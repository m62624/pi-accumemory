import {
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { toTurns } from "./messages.ts";
import { openPrivatePanel, type PrivateChatMode } from "./ui/private-chat.ts";

type CompletionContext = Parameters<
	ExtensionContext["modelRegistry"]["complete"]
>[1];
const CONTEXT_LIMIT = 16_000;

export function registerPrivateChat(pi: ExtensionAPI): void {
	let active: AbortController | undefined;

	const open = async (mode: PrivateChatMode, ctx: ExtensionCommandContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify(
				"Private chat needs Pi's interactive terminal UI.",
				"warning",
			);
			return;
		}
		if (active !== undefined || !ctx.isIdle()) {
			ctx.ui.notify(
				"Private chat can open when the main chat is idle.",
				"warning",
			);
			return;
		}
		const model = ctx.model;
		if (model === undefined) {
			ctx.ui.notify("Select a model before opening private chat.", "warning");
			return;
		}

		const lifetime = new AbortController();
		active = lifetime;
		try {
			let systemPrompt = "Answer conversationally as a text-only assistant.";
			if (mode === "btw") {
				const { messages } = buildSessionContext(
					ctx.sessionManager.getBranch(),
				);
				const visible = convertToLlm(
					messages.filter(
						({ role }) =>
							role === "user" ||
							role === "assistant" ||
							role === "compactionSummary" ||
							role === "branchSummary",
					),
				);
				const excerpt = toTurns(visible)
					.filter(({ text }) => text.length > 0)
					.map(({ role, text }) => `${role}: ${text}`)
					.join("\n\n")
					.slice(-CONTEXT_LIMIT);
				if (excerpt !== "") {
					systemPrompt += `\n\nRecent main-chat text for reference:\n${excerpt}`;
				}
			}
			const messages: CompletionContext["messages"] = [];
			await openPrivatePanel(ctx.ui, mode, lifetime, async (question) => {
				const user = {
					role: "user" as const,
					content: question,
					timestamp: Date.now(),
				};
				// Call the provider directly. The regular agent, extension hooks,
				// tool registry and SessionManager never receive private turns.
				const answer = await ctx.modelRegistry.complete(
					model,
					{ systemPrompt, messages: [...messages, user] },
					{ signal: lifetime.signal, cacheRetention: "none" },
				);
				lifetime.signal.throwIfAborted();
				if (answer.stopReason === "error" || answer.stopReason === "aborted") {
					throw new Error("Private completion failed.");
				}
				const content = answer.content.filter((part) => part.type === "text");
				const text = content.map((part) => part.text).join("\n");
				if (text.trim() === "")
					throw new Error("Private completion returned no text.");
				if (mode === "incognito") messages.push(user, { ...answer, content });
				return text;
			});
		} catch {
			ctx.ui.notify("Could not open private chat.", "error");
		} finally {
			lifetime.abort();
			active = undefined;
		}
	};

	pi.registerCommand("longterm-btw", {
		description: "Ask one private question using recent main-chat text",
		handler: async (args, ctx) => {
			if (args.trim() !== "") {
				ctx.ui.notify(
					"Use /longterm-btw, then enter your question in the panel.",
					"warning",
				);
				return;
			}
			await open("btw", ctx);
		},
	});
	pi.registerCommand("longterm-incognito", {
		description: "Open a temporary private chat with /longterm-incognito on",
		handler: async (args, ctx) => {
			switch (args.trim()) {
				case "on":
					await open("incognito", ctx);
					break;
				case "off":
					active?.abort();
					break;
				default:
					ctx.ui.notify("Use /longterm-incognito on or off.", "info");
			}
		},
	});
	pi.on("session_shutdown", () => active?.abort());
}
