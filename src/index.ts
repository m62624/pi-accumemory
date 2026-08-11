/**
 * The extension entry point: pi's events wired to the memory controller.
 *
 * Everything interesting lives elsewhere. What this file is responsible for is
 * the two things only it can get right:
 *
 * - **the `context` hook**, where the tail is appended as the LAST message and
 *   nowhere else. It is ephemeral by design - `context` fires before each LLM
 *   call and is not persisted to the transcript - which is what lets the block
 *   change without accumulating in the session file.
 * - **failing softly**. If the memory cannot start, the session still does. A
 *   coding agent whose memory is unavailable is a coding agent; one that
 *   refuses to open is a broken tool.
 */

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { extensionLayout } from "./layout.ts";
import type { Turn } from "./memory/transcript-view.ts";
import { hasToolCalls, messageToTurn, toTurns } from "./messages.ts";
import { nodeFileOps } from "./node-fs.ts";
import { createIdleTrigger } from "./session/idle-trigger.ts";
import { parseSettings } from "./settings/schema.ts";
import { type StartedSession, startSession } from "./startup.ts";
import { longtermTools } from "./tools/definitions.ts";

export default function accumemory(pi: ExtensionAPI): void {
	let session: StartedSession | undefined;
	let startupError: string | undefined;
	let noticesShown = false;

	const agentDir = getAgentDir();
	const layout = extensionLayout(agentDir, path);

	const ready = (async () => {
		const raw = await nodeFileOps.readFile(layout.settingsFile);
		const { settings, warnings } = parseSettings(
			raw === undefined ? undefined : (JSON.parse(raw) as unknown),
		);
		if (!settings.memory.enabled) return undefined;

		const started = await startSession({
			settings,
			layout,
			fs: nodeFileOps,
			pathModule: path,
			agentDir,
			cwd: process.cwd(),
		});
		started.notices.unshift(...warnings);
		return started;
	})()
		.then((started) => {
			session = started;
			return started;
		})
		.catch((error: unknown) => {
			// One sentence, once, and the session carries on without memory.
			startupError = `pi-accumemory could not start its memory: ${describe(error)}`;
			return undefined;
		});

	// -- tools ---------------------------------------------------------------

	// Registered unconditionally and up front. Tool schemas sit in the head of
	// the prompt, so adding or removing one mid-session invalidates the cache
	// for everything below it - a far larger cost than a tool that occasionally
	// answers "memory is unavailable".
	for (const spec of longtermTools(lazyController(() => session))) {
		pi.registerTool({
			name: spec.name,
			label: spec.label,
			description: spec.description,
			parameters: spec.parameters as never,
			execute: async (_id, params) => {
				await ready;
				const text =
					session === undefined
						? (startupError ??
							"Long-term memory is not available in this session.")
						: await spec.run((params ?? {}) as Record<string, unknown>);
				return { content: [{ type: "text", text }], details: undefined };
			},
		});
	}

	// -- the tail ------------------------------------------------------------

	pi.on("context", async (event) => {
		await ready;
		if (session === undefined) return;
		const turns = toTurns(event.messages);
		const tail = await session.controller.tail(turns);
		if (tail === "") return;
		// LAST message, always. A backend caches a prefix, and this changes on
		// every refresh by construction; anywhere above the transcript it would
		// charge the whole transcript each time.
		return {
			messages: [
				...event.messages,
				{ role: "user", content: tail, timestamp: Date.now() },
			],
		};
	});

	// -- lifecycle -----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		await ready;
		if (noticesShown) return;
		noticesShown = true;
		const notices =
			startupError === undefined ? (session?.notices ?? []) : [startupError];
		for (const notice of notices)
			ctx.ui.notify(`pi-accumemory: ${notice}`, "info");
	});

	pi.on("before_agent_start", () => {
		// The strongest signal that the topic was set or changed.
		session?.controller.noteUserMessage();
	});

	pi.on("tool_execution_end", (event) => {
		session?.controller.noteToolCall(event.toolName);
	});

	pi.on("turn_end", (event) => {
		session?.controller.noteTurnEnd(
			event.toolResults.length > 0 || hasToolCalls(event.message),
		);
	});

	pi.on("session_compact", () => {
		// The worst moment to be holding a stale block: the history was just cut
		// away, and the memory is the only thing left of it.
		session?.controller.noteCompact();
	});

	pi.on("session_shutdown", () => {
		idle?.cancel();
		session?.close();
		session = undefined;
	});

	// -- the idle consolidation pass -----------------------------------------

	// It starts only after a stretch of silence, and yields to the user the
	// instant they type. Every memory call it makes has already landed on disk
	// by then, so being cut short costs nothing but the rest of the pass.
	const idle = createIdleTrigger({
		quietMs: () => session?.consolidationQuietMs ?? 0,
		run: async (signal: AbortSignal) => {
			const runner = session?.consolidation;
			if (runner === undefined) return;
			try {
				await runner.runOnce(signal);
			} catch {
				// A pass that fails is a pass that did not happen. The next one
				// resumes from the same cursor.
			}
		},
	});

	pi.on("before_agent_start", () => idle.interrupt());
	pi.on("agent_settled", () => idle.schedule());

	// -- commands ------------------------------------------------------------

	pi.registerCommand("longterm-status", {
		description: "What pi-accumemory has open, and what it holds",
		handler: async (_args, ctx) => {
			await ready;
			if (session === undefined) {
				ctx.ui.notify(startupError ?? "Long-term memory is off.", "warning");
				return;
			}
			const lines = [
				`Project: ${session.projectRoot ?? "(not a project directory)"}`,
				`Project id: ${session.projectId ?? "-"}`,
				`Memory: ${layout.memoryDir}`,
				await session.controller.projects(),
				...session.notices,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("longterm-consolidate", {
		description:
			"Run the memory consolidation pass now, without waiting for a quiet period",
		handler: async (_args, ctx) => {
			await ready;
			const runner = session?.consolidation;
			if (runner === undefined) {
				ctx.ui.notify("There is no consolidation pass to run here.", "warning");
				return;
			}
			idle.interrupt();
			const outcome = await runner.runOnce();
			ctx.ui.notify(
				outcome.ran
					? "Consolidation pass finished."
					: `Nothing to do: ${outcome.reason}.`,
				"info",
			);
		},
	});

	pi.registerCommand("longterm-reembed", {
		description:
			"Rebuild every stored vector after changing the embedder model or dimension",
		handler: async (_args, ctx) => {
			await ready;
			if (session === undefined) {
				ctx.ui.notify(startupError ?? "Long-term memory is off.", "warning");
				return;
			}
			// Every database, not just this project's: a partial reembed leaves
			// half the memory answering in one vector space and half in another,
			// and nothing reports that.
			idle.interrupt();
			ctx.ui.notify(
				"Re-embedding every memory; this can take a while.",
				"info",
			);
			try {
				ctx.ui.notify(
					await session.reembed((name) =>
						ctx.ui.setStatus("longterm", `re-embedding ${name}`),
					),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Re-embedding failed: ${describe(error)}`, "error");
			} finally {
				ctx.ui.setStatus("longterm", undefined);
			}
		},
	});
}

/**
 * A controller façade that resolves lazily.
 *
 * The tools are registered before the databases finish opening, because the
 * tool list belongs to the prompt head and must not change mid-session. This
 * bridges the gap: every call goes through whatever the controller is by then,
 * and a call that arrives before startup finished gets a sentence rather than a
 * crash.
 */
function lazyController(get: () => StartedSession | undefined) {
	const unavailable = "Long-term memory is not available in this session.";
	const proxy = {
		ask: async (input: Parameters<Controller["ask"]>[0]) =>
			get()?.controller.ask(input) ?? unavailable,
		askProject: async (project: string, question: string) =>
			get()?.controller.askProject(project, question) ?? unavailable,
		projects: async () => get()?.controller.projects() ?? unavailable,
		remember: async (input: Parameters<Controller["remember"]>[0]) =>
			get()?.controller.remember(input) ?? unavailable,
		revise: async (...args: Parameters<Controller["revise"]>) =>
			get()?.controller.revise(...args) ?? unavailable,
		forget: async (...args: Parameters<Controller["forget"]>) =>
			get()?.controller.forget(...args) ?? unavailable,
		listTags: async (...args: Parameters<Controller["listTags"]>) =>
			get()?.controller.listTags(...args) ?? unavailable,
		link: async (...args: Parameters<Controller["link"]>) =>
			get()?.controller.link(...args) ?? unavailable,
		unlink: async (...args: Parameters<Controller["unlink"]>) =>
			get()?.controller.unlink(...args) ?? unavailable,
		notes: (...args: Parameters<Controller["notes"]>) =>
			get()?.controller.notes(...args),
	};
	return proxy as unknown as Controller;
}

type Controller = StartedSession["controller"];

function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Re-exported so a consumer can drive the pieces without the extension shell. */
export { messageToTurn, type Turn, toTurns };
