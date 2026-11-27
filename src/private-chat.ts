import {
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import { toTurns } from "./messages.ts";
import { openPrivatePanel, plainPrivateText } from "./ui/private-chat.ts";

type Completion = ExtensionContext["modelRegistry"]["complete"];
type CompletionContext = Parameters<Completion>[1];
type ChatModel = NonNullable<ExtensionContext["model"]>;
const CONTEXT_LIMIT = 16_000;
const BTW_WIDGET = "longterm-btw";

class PrivateReplyError extends Error {}

function recentChat(ctx: ExtensionContext): string {
	const { messages } = buildSessionContext(ctx.sessionManager.getBranch());
	const visible = convertToLlm(
		messages.filter(
			({ role }) =>
				role === "user" ||
				role === "assistant" ||
				role === "compactionSummary" ||
				role === "branchSummary",
		),
	);
	return toTurns(visible)
		.filter(({ text }) => text.length > 0)
		.map(({ role, text }) => `${role}: ${text}`)
		.join("\n\n")
		.slice(-CONTEXT_LIMIT);
}

function providerFailure(details?: string): string {
	const status = details?.match(/^(?:HTTP\s+)?([45]\d\d)\b/u)?.[1];
	if (status !== undefined) return `The model request failed (HTTP ${status}).`;
	if (/\b(?:ECONNREFUSED|ENOTFOUND)\b|connection error/iu.test(details ?? "")) {
		return "Could not connect to the selected model.";
	}
	return "The selected model could not complete the request.";
}

async function privateReply(
	ctx: ExtensionContext,
	model: ChatModel,
	context: CompletionContext,
	signal: AbortSignal,
) {
	// The regular agent, extension request hooks, tool registry and
	// SessionManager never receive private turns.
	let answer: Awaited<ReturnType<Completion>>;
	try {
		answer = await ctx.modelRegistry.complete(model, context, {
			signal,
			cacheRetention: "none",
		});
	} catch (error) {
		signal.throwIfAborted();
		throw new PrivateReplyError(
			providerFailure(error instanceof Error ? error.message : undefined),
		);
	}
	signal.throwIfAborted();
	if (answer.stopReason === "error" || answer.stopReason === "aborted") {
		throw new PrivateReplyError(providerFailure(answer.errorMessage));
	}
	const content = answer.content.filter((part) => part.type === "text");
	const text = content.map((part) => part.text).join("\n");
	if (text.trim() === "") {
		throw new PrivateReplyError(
			answer.content.some((part) => part.type === "thinking")
				? "The model returned reasoning without a text answer."
				: "The model returned no text answer.",
		);
	}
	return { text, message: { ...answer, content } };
}

export function registerPrivateChat(pi: ExtensionAPI): void {
	let active: AbortController | undefined;
	let resultVisible = false;

	const clearBtw = (ctx: ExtensionContext) => {
		if (!resultVisible) return;
		resultVisible = false;
		ctx.ui.setWidget(BTW_WIDGET, undefined);
	};

	const withModel = async (
		ctx: ExtensionContext,
		run: (model: ChatModel, lifetime: AbortController) => Promise<void>,
	) => {
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
			clearBtw(ctx);
			await run(model, lifetime);
		} catch {
			if (!lifetime.signal.aborted)
				ctx.ui.notify("Private chat failed.", "error");
		} finally {
			lifetime.abort();
			active = undefined;
		}
	};

	const runBtw = async (args: string, ctx: ExtensionContext) => {
		const question = args.trim();
		if (question === "") {
			ctx.ui.notify("Usage: /longterm-btw <question>", "info");
			return;
		}
		await withModel(ctx, async (model, lifetime) => {
			const unsubscribe = ctx.ui.onTerminalInput((data) => {
				if (!matchesKey(data, "escape")) return;
				lifetime.abort();
				return { consume: true };
			});
			const display = (text: string) => {
				resultVisible = true;
				ctx.ui.setWidget(
					BTW_WIDGET,
					(_tui, theme) =>
						new Text(`${theme.bold("BTW")}\n${plainPrivateText(text)}`, 1, 0),
				);
			};
			try {
				display("Waiting for the model… Esc cancels.");
				const excerpt = recentChat(ctx);
				const systemPrompt =
					excerpt === ""
						? "Answer the question directly."
						: "Answer the question directly.\n\nRecent main-chat text for reference:\n" +
							excerpt;
				const { text } = await privateReply(
					ctx,
					model,
					{
						systemPrompt,
						messages: [
							{ role: "user", content: question, timestamp: Date.now() },
						],
					},
					lifetime.signal,
				);
				display(text);
			} catch (error) {
				if (lifetime.signal.aborted) clearBtw(ctx);
				else
					display(
						error instanceof PrivateReplyError
							? error.message
							: "The private request failed.",
					);
			} finally {
				unsubscribe();
			}
		});
	};

	pi.registerCommand("longterm-btw", {
		description: "Ask one private question: /longterm-btw <question>",
		handler: runBtw,
	});

	// Pi's command parser splits on a literal space. Treat pasted tabs or
	// line breaks as separators too, before the prompt can enter the chat.
	pi.on("input", async (event, ctx) => {
		const command = /^\/longterm-btw(?:\s+([\s\S]*))?$/u.exec(
			event.text.trim(),
		);
		if (command === null) return;
		await runBtw(command[1] ?? "", ctx);
		return { action: "handled" };
	});

	pi.registerCommand("longterm-incognito", {
		description: "Open a temporary private chat with /longterm-incognito on",
		handler: async (args, ctx) => {
			switch (args.trim()) {
				case "on":
					await withModel(ctx, async (model, lifetime) => {
						const messages: CompletionContext["messages"] = [];
						await openPrivatePanel(ctx.ui, lifetime, async (question) => {
							const user = {
								role: "user" as const,
								content: question,
								timestamp: Date.now(),
							};
							const { text, message } = await privateReply(
								ctx,
								model,
								{
									systemPrompt:
										"Answer conversationally as a text-only assistant.",
									messages: [...messages, user],
								},
								lifetime.signal,
							);
							messages.push(user, message);
							return text;
						});
					});
					break;
				case "off":
					active?.abort();
					break;
				default:
					ctx.ui.notify("Use /longterm-incognito on or off.", "info");
			}
		},
	});
	pi.on("before_agent_start", (_event, ctx) => {
		active?.abort();
		clearBtw(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		active?.abort();
		clearBtw(ctx);
	});
}
