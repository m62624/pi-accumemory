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

import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { extensionLayout, projectDbName } from "./layout.ts";
import { isToolReport, personLine } from "./memory/tool-report.ts";
import type { Turn } from "./memory/transcript-view.ts";
import { hasToolCalls, messageToTurn, toTurns } from "./messages.ts";
import { nodeFileOps } from "./node-fs.ts";
import { withHead } from "./session/head.ts";
import { createIdleTrigger } from "./session/idle-trigger.ts";
import { unfixableNotice } from "./session/stumbles.ts";
import { parseSettings } from "./settings/schema.ts";
import { type StartedSession, startSession } from "./startup.ts";
import type { EmbedderState } from "./storage/port.ts";
import { longtermTools } from "./tools/definitions.ts";
import { lazyController, MEMORY_UNAVAILABLE } from "./tools/lazy.ts";
import { terminalWidth } from "./ui/fit.ts";
import {
	buildRebindOptions,
	type RebindCandidate,
	resolveRebindPick,
} from "./ui/rebind-picker.ts";
import {
	type ProgressStep,
	reembedProgressLines,
	reembedSummary,
} from "./ui/reembed-progress.ts";

/** Widget slot for the rebuild panel; the same key replaces, never stacks. */
const REEMBED_WIDGET = "longterm-reembed";

export default function accumemory(pi: ExtensionAPI): void {
	let session: StartedSession | undefined;
	let startupError: string | undefined;
	let noticesShown = false;

	const agentDir = getAgentDir();
	const layout = extensionLayout(agentDir, path);

	/**
	 * Brings the memory up.
	 *
	 * A function rather than the one-shot it used to be, because rebinding this
	 * folder to a different memory has to reopen everything - and the whole
	 * extension already reaches its state through the mutable `session` above
	 * (and `lazyController` below), so swapping it is a matter of closing one
	 * and starting the next. `startSession` is pure over its injected
	 * dependencies, so calling it again is not a special case.
	 */
	const boot = async (): Promise<StartedSession | undefined> => {
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
			home: homedir(),
		});
		started.notices.unshift(...warnings);
		return started;
	};

	const ready = boot()
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
				// Whatever is being held is not this call's. The idle pass writes
				// through this same controller and never renders anything, so its
				// last report would otherwise sit there until the user's next tool
				// call - any tool, including one that reads - picked it up and
				// printed "Stored [fN]" over an answer that stored nothing.
				session?.controller.takeLastReport();
				const text =
					session === undefined
						? (startupError ?? MEMORY_UNAVAILABLE)
						: await spec.run((params ?? {}) as Record<string, unknown>);
				// `content` is what the MODEL reads, and it always carries the
				// full account - see `memory/write-report.ts` for why every part
				// of it is load-bearing. What the person sees is `renderResult`
				// below, and only that is configurable.
				const report = session?.controller.takeLastReport();
				return {
					content: [{ type: "text", text }],
					details: report,
				};
			},
			renderResult: (result, _options, _theme) => {
				const detail = result.details;
				const mode = session?.settings.memory.output ?? "short";
				// No report means nothing happened worth summarising - a refusal,
				// a miss, an error - and those are worded for the model in terms a
				// person can read too.
				if (!isToolReport(detail)) return new Text(resultText(result));
				return new Text(personLine(detail, mode) ?? resultText(result));
			},
		});
	}

	// -- the tail ------------------------------------------------------------

	pi.on("context", async (event) => {
		await ready;
		if (session === undefined) return;
		const turns = toTurns(event.messages);
		const tail = await session.controller.tail(turns);

		// Head and tail, and the split is the whole caching strategy. The
		// instructions never change during a session, so in front they cost one
		// cached prefix; the memory block changes by construction, so it goes
		// last, where a change re-reads nothing but itself.
		//
		// Both are rebuilt here rather than written into the session, which is
		// what makes them survive a compaction - a summary can rewrite the
		// conversation, but not something that was never in it.
		const messages = withHead(event.messages, session.headInstructions);
		if (tail === "") return { messages };
		return {
			messages: [
				...messages,
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
				`Engine config: ${session.configFile}`,
				// Asked now rather than remembered from startup: a provider that
				// stopped answering mid-session is exactly what somebody runs
				// this command to find out about.
				`Embedder: ${embedderLine(session.embedderState())}`,
				await session.controller.projects(),
				...session.notices,
			];
			// Only when there is something wrong that the memory could not fix
			// by itself. See `unfixableNotice`.
			const stuck = unfixableNotice(
				await session.stumbles.unfixable(
					session.settings.memory.consolidation.habits.afterSessions,
				),
			);
			if (stuck !== "") lines.push("", stuck);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	/**
	 * Closes the memory and opens it again, in place.
	 *
	 * What makes "no restart needed" true after a command changes which database
	 * this folder uses. Closing first is not only tidiness: the old memory is
	 * held under a writer lock, and nothing else can touch a file this session
	 * still owns - which is also why deleting an orphan happens after this, not
	 * before. Answers whether the memory came back up.
	 */
	const reopen = async (ctx: {
		ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
	}): Promise<boolean> => {
		idle.interrupt();
		session?.close();
		session = undefined;
		try {
			session = await boot();
			return true;
		} catch (error) {
			startupError = `pi-accumemory could not reopen its memory: ${describe(error)}`;
			ctx.ui.notify(startupError, "error");
			return false;
		}
	};

	pi.registerCommand("longterm-new", {
		description:
			"Give this folder a memory of its own, separate from any above it",
		handler: async (_args, ctx) => {
			await ready;
			if (session === undefined) {
				ctx.ui.notify(startupError ?? "Long-term memory is off.", "warning");
				return;
			}
			const inherited = session.projectId;
			const here = process.cwd();
			// Asked even when the folder has nothing today: this decides where
			// everything stored here from now on goes, and that is not a thing to
			// do on one keystroke.
			if (
				ctx.hasUI &&
				!(await ctx.ui.confirm(
					"Give this folder its own memory?",
					`${here} gets a new, empty memory.\n` +
						(inherited === undefined
							? "Facts about this folder are going to the shared memory about you today."
							: `It is using memory ${inherited} (${session.projectRoot}) today, which keeps serving everything else under it.`),
				))
			) {
				return;
			}

			const outcome = await session.newMemoryHere();
			if (!outcome.ok) {
				ctx.ui.notify(outcome.reason, "warning");
				return;
			}
			if (!(await reopen(ctx))) return;
			ctx.ui.notify(
				`${outcome.folder} now has its own memory (${outcome.projectId}), and it is open. ` +
					(outcome.replacedId === undefined
						? "Facts about this folder no longer have to go to the shared memory."
						: `Memory ${outcome.replacedId} is untouched and still serves the folders above.`),
				"info",
			);
		},
	});

	pi.registerCommand("longterm-rebind", {
		description:
			"Bind a memory from elsewhere - a copied one, or one left unbound - to this folder",
		handler: async (_args, ctx) => {
			await ready;
			if (session === undefined) {
				ctx.ui.notify(startupError ?? "Long-term memory is off.", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"This command picks a memory from a list, so it needs a terminal.",
					"warning",
				);
				return;
			}

			const candidates = await session.rebindCandidates();
			const width = terminalWidth();
			// A flat selector with no scrollback, so a long roster is paged and a
			// page row re-opens the picker rather than choosing anything.
			let page = 0;
			let chosen: RebindCandidate | undefined;
			for (;;) {
				const options = buildRebindOptions(candidates, { page, width });
				if (options.length === 0) {
					ctx.ui.notify("There are no other memories to bind here.", "info");
					return;
				}
				const selected = await ctx.ui.select(
					"Which memory belongs to this folder?",
					options.map((option) => option.label),
				);
				if (selected === undefined) return;
				const pick = resolveRebindPick(options, selected);
				if (pick === null) return;
				if (pick.kind === "page") {
					page = pick.page;
					continue;
				}
				chosen = candidates.find(
					(candidate) => candidate.projectId === pick.projectId,
				);
				break;
			}
			if (chosen === undefined) return;

			const here = session.projectRoot ?? process.cwd();
			const facts =
				chosen.facts === undefined ? "an unknown number of" : `${chosen.facts}`;
			if (
				!(await ctx.ui.confirm(
					"Bind this memory here?",
					`${chosen.projectId} (${facts} facts), ${chosen.bound ? "bound to" : "last bound to"} ${chosen.path}\n` +
						`becomes the memory of ${here}.`,
				))
			) {
				return;
			}
			// Asked separately, because it is a different question: the first is
			// "this memory here", this one is "and that one no longer".
			const occupant = candidates.find((candidate) => candidate.current);
			if (
				occupant !== undefined &&
				!(await ctx.ui.confirm(
					"Replace the memory this folder uses now?",
					`${occupant.projectId} (${occupant.facts ?? 0} facts) serves ${here} today.\n` +
						"It stays on disk, bound to nothing, and you will be asked whether to delete it.",
				))
			) {
				return;
			}

			const outcome = await session.rebindTo(chosen.projectId);
			if (!outcome.ok) {
				ctx.ui.notify(outcome.reason, "warning");
				return;
			}

			if (!(await reopen(ctx))) return;

			// The orphan is deleted through the NEW session, and only after it: by
			// then nothing holds the file open, which is what makes the removal
			// work on Windows too.
			let aftermath = "";
			const released = outcome.releasedId;
			if (released !== undefined && session !== undefined) {
				const file = path.join(
					layout.memoryDir,
					"db",
					`${projectDbName(released)}.plugmem`,
				);
				if (
					await ctx.ui.confirm(
						"Delete the memory that was here?",
						`${released} now belongs to no folder. Its database is\n${file}\n` +
							"Deleting removes it, its notes and its place in the list. This cannot be undone.",
					)
				) {
					const deleted = await session.deleteMemory(released);
					aftermath = deleted.ok
						? ` Deleted ${released} (${deleted.removed.length} files).`
						: ` ${released} was left alone: ${deleted.reason}`;
				} else {
					aftermath = ` ${released} was left where it is; /longterm-rebind lists it as unbound, and can delete it later.`;
				}
			}
			ctx.ui.notify(
				`${here} now uses memory ${outcome.projectId} (was ${outcome.from}). ` +
					`The memory has been reopened - no restart needed.${aftermath}`,
				"info",
			);
		},
	});

	pi.registerCommand("longterm-consolidate", {
		description:
			"Run the memory consolidation pass now, without waiting for a quiet period",
		handler: async (_args, ctx) => {
			await ready;
			const runner = session?.consolidation;
			if (runner === undefined) {
				// The only way to get here now is having switched it off, so say
				// that rather than the old sentence, which named no reason and
				// was usually shown for one that was not true anyway.
				ctx.ui.notify(
					session === undefined
						? (startupError ?? "Long-term memory is off.")
						: 'The consolidation pass is switched off ("memory.consolidation.enabled": false in settings.json).',
					"warning",
				);
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

			// A visible, moving panel above the editor rather than one word in
			// the footer. This is the only operation here that takes real time,
			// and a person watching it has to be able to tell it apart from a
			// hang. The editor stays usable on purpose: there is no API to lock
			// it, and taking the keyboard away during a background rebuild is
			// worse than showing what is going on.
			let steps: readonly ProgressStep[] = [];
			let tick = 0;
			const draw = () => {
				if (steps.length === 0) return;
				try {
					ctx.ui.setWidget(REEMBED_WIDGET, reembedProgressLines(steps, tick));
				} catch {
					// Cosmetic: a stale UI handle must not fail the rebuild.
				}
			};
			const animation = setInterval(() => {
				tick += 1;
				draw();
			}, 120);
			ctx.ui.setStatus("longterm", "rebuilding vectors");

			try {
				const result = await session.reembed((progress) => {
					steps = progress;
					draw();
				});
				ctx.ui.notify(
					result.blocked ?? reembedSummary(result.steps),
					result.steps.some((step) => step.state === "skipped")
						? "warning"
						: "info",
				);
			} catch (error) {
				ctx.ui.notify(`Re-embedding failed: ${describe(error)}`, "error");
			} finally {
				clearInterval(animation);
				ctx.ui.setStatus("longterm", undefined);
				try {
					ctx.ui.setWidget(REEMBED_WIDGET, undefined);
				} catch {
					// Same reason as above.
				}
			}
		},
	});
}

function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** The embedder's state, said in terms of what the memory can do. */
function embedderLine(state: EmbedderState): string {
	switch (state) {
		case "absent":
			return "none - answers match wording, not meaning";
		case "active":
			return "answering";
		case "suspended":
			return "not answering right now, so new facts are stored without vectors; it retries by itself, and /longterm-reembed fills them in";
	}
}

/** Re-exported so a consumer can drive the pieces without the extension shell. */
export { messageToTurn, type Turn, toTurns };

/** The text a tool result carries, for the results that are not writes. */
function resultText(result: {
	content?: { type: string; text?: string }[];
}): string {
	return (result.content ?? [])
		.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("");
}
