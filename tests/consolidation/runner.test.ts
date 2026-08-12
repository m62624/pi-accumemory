import path from "node:path";
import { describe, expect, it } from "vitest";
import { CursorStore } from "../../src/consolidation/cursor-store.ts";
import { ReviewCursorStore } from "../../src/consolidation/review-cursor.ts";
import {
	ConsolidationRunner,
	DONE_TOOL,
	type PassAgent,
	type PassAgentRequest,
} from "../../src/consolidation/runner.ts";
import type { TranscriptCursor } from "../../src/consolidation/transcript.ts";
import { BUNDLED_INSTRUCTIONS } from "../../src/instructions/bundled.ts";
import { InstructionManager } from "../../src/instructions/manager.ts";
import type { Turn } from "../../src/memory/transcript-view.ts";
import { NoteStore } from "../../src/notes/store.ts";
import { ProjectRouter } from "../../src/router/router.ts";
import { MemoryController } from "../../src/session/controller.ts";
import { REPEATS_PER_SESSION, StumbleLog } from "../../src/session/stumbles.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import { FakeFs } from "../helpers/fake-fs.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

/** An agent that performs a scripted list of calls and then stops. */
function scriptedAgent(script: [name: string, args: string][]): PassAgent & {
	prompts: string[];
	tails: string[];
} {
	const prompts: string[] = [];
	const tails: string[] = [];
	return {
		prompts,
		tails,
		run: async (request: PassAgentRequest) => {
			prompts.push(request.prompt);
			for (const [name, args] of script) {
				if (request.finished()) break;
				// A real driver builds the tail, sends it, and only then acts -
				// and a directive that ends the pass ends it before the next
				// action, not after.
				tails.push(request.tail());
				if (request.finished()) break;
				if (name === "") request.onIdleTurn();
				else request.onToolCall(name, args);
			}
		},
	};
}

function build(
	options: {
		turns?: Turn[];
		enabled?: boolean;
		settings?: Partial<typeof DEFAULT_SETTINGS.memory.consolidation>;
		stumbles?: StumbleLog;
	} = {},
) {
	const common = new FakeMemory();
	const project = new FakeMemory();
	const fs = new FakeFs();
	const controller = new MemoryController({
		settings: DEFAULT_SETTINGS,
		common,
		project,
		projectName: "app",
		notesCommon: new NoteStore(common, { fs, dir: "/n", flavour: path.posix }),
		router: new ProjectRouter(common),
	});
	const instructions = new InstructionManager({
		fs,
		flavour: path.posix,
		defaultsDir: "/ext/defaults",
		globalAppendDir: "/ext/append",
		bundled: BUNDLED_INSTRUCTIONS,
	});
	const cursors = new CursorStore(fs, "/ext/state.json", path.posix);
	const reviewCursor = new ReviewCursorStore(
		fs,
		"/ext/review.json",
		path.posix,
	);
	const turns = options.turns ?? [
		{ role: "user", text: "I will play at 20:30 on Saturday" },
		{ role: "assistant", text: "noted" },
	];
	let readCursor: TranscriptCursor | undefined;
	const runner = (agent: PassAgent) =>
		new ConsolidationRunner({
			settings: {
				...DEFAULT_SETTINGS.memory.consolidation,
				enabled: options.enabled ?? true,
				...options.settings,
			},
			controller,
			cursors,
			instructions,
			agent,
			alwaysLimits: DEFAULT_SETTINGS.memory.instructions,
			...(options.stumbles === undefined ? {} : { stumbles: options.stumbles }),
			cursorKey: "p1",
			label: "this project (app)",
			reviewCursor,
			scopeLabel: (scope) =>
				scope === "user" ? "your memory about the user" : "this project (app)",
			clock: () => "[Now: Tuesday, 11 August 2026 at 17:30 (UTC)]",
			readTail: async (cursor) => {
				readCursor = cursor;
				return { turns, cursor: { file: "a.jsonl", line: 12 } };
			},
		});
	return {
		runner,
		cursors,
		reviewCursor,
		project,
		common,
		seenCursor: () => readCursor,
	};
}

describe("ConsolidationRunner", () => {
	it("does nothing when consolidation is switched off", async () => {
		const { runner } = build({ enabled: false });
		const agent = scriptedAgent([]);
		expect(await runner(agent).runOnce()).toEqual({
			ran: false,
			reason: "disabled",
		});
		expect(agent.prompts).toHaveLength(0);
	});

	it("does nothing when the transcript has nothing new", async () => {
		const { runner } = build({ turns: [] });
		const agent = scriptedAgent([]);
		expect((await runner(agent).runOnce()).ran).toBe(false);
	});

	it("shows the pass the transcript and the instructions", async () => {
		const { runner } = build();
		const agent = scriptedAgent([[DONE_TOOL, ""]]);
		await runner(agent).runOnce();
		expect(agent.prompts[0]).toContain("I will play at 20:30 on Saturday");
		expect(agent.prompts[0]).toMatch(/collapse repetition/i);
	});

	it("advances the cursor when the pass completes", async () => {
		// This is what turns a long session into several small passes instead
		// of one that cannot be lifted.
		const { runner, cursors } = build();
		await runner(scriptedAgent([[DONE_TOOL, ""]])).runOnce();
		expect(await cursors.get("p1")).toEqual({ file: "a.jsonl", line: 12 });
	});

	it("resumes from the cursor it stored", async () => {
		const { runner, cursors, seenCursor } = build();
		await cursors.set("p1", { file: "a.jsonl", line: 3 });
		await runner(scriptedAgent([[DONE_TOOL, ""]])).runOnce();
		expect(seenCursor()).toEqual({ file: "a.jsonl", line: 3 });
	});

	it("leaves the cursor alone when the pass was cut short", async () => {
		// An aborted pass re-reads the same tail next time. Repetition is
		// absorbed by the guarded write; skipped material is not recoverable.
		const { runner, cursors } = build();
		const aborted = new AbortController();
		aborted.abort();
		await runner(scriptedAgent([])).runOnce(aborted.signal);
		expect(await cursors.get("p1")).toBeUndefined();
	});

	it("gives the pass a fresh directive on every step", async () => {
		const { runner } = build();
		const agent = scriptedAgent([
			["longterm_ask", "a"],
			["longterm_ask", "a"],
			["longterm_ask", "a"],
		]);
		await runner(agent).runOnce();
		// The directive is built before each step, so a repeat is called out on
		// the step AFTER the one that repeated.
		expect(agent.tails[0]).toBe(agent.tails[1]);
		expect(agent.tails[2]).toMatch(/same call/i);
	});

	it("stops feeding steps once the pass declares itself done", async () => {
		const { runner } = build();
		const agent = scriptedAgent([
			[DONE_TOOL, ""],
			["longterm_ask", "should never run"],
		]);
		await runner(agent).runOnce();
		expect(agent.tails).toHaveLength(1);
	});

	it("counts a write so the pass is not told to stop inspecting", async () => {
		const { runner } = build();
		const agent = scriptedAgent([
			["longterm_ask", "a"],
			["longterm_ask", "b"],
			["longterm_remember", "a fact"],
			["longterm_ask", "c"],
		]);
		await runner(agent).runOnce();
		expect(agent.tails.at(-1)).not.toMatch(/inspection phase is over/i);
	});

	it("ends a pass that keeps producing nothing", async () => {
		// Prose on a memory pass is not an answer written badly - it is a lost
		// thread, and nothing recovers it. So the pass is ended rather than
		// nudged forever.
		const { runner } = build();
		const agent = scriptedAgent([
			["", ""],
			["", ""],
			["longterm_ask", "should never run"],
		]);
		await runner(agent).runOnce();
		expect(agent.tails.at(-1)).toMatch(/no actions and is being ended/i);
		expect(agent.tails).toHaveLength(3);
	});
});

describe("the review phase", () => {
	/** A build whose project memory already holds `count` older facts. */
	async function seeded(
		count: number,
		options: Parameters<typeof build>[0] = {},
	) {
		const parts = build(options);
		for (let i = 0; i < count; i += 1) {
			await parts.project.remember({
				text: `an older fact number ${i}`,
				entity: "project",
				tags: ["decision"],
			});
		}
		return parts;
	}

	/** The prompt of the review phase, whichever run it was. */
	const reviewPromptOf = (agent: { prompts: string[] }) =>
		agent.prompts.find((prompt) =>
			/oldest facts still in memory/i.test(prompt),
		);

	it("runs on its own when the transcript has nothing new", async () => {
		// The point of the phase. An idle machine with no new transcript is
		// exactly when there is time to age the memory; refusing then means the
		// review happens least on the days it costs least.
		const { runner } = await seeded(3, { turns: [] });
		const agent = scriptedAgent([[DONE_TOOL, ""]]);
		expect((await runner(agent).runOnce()).ran).toBe(true);
		expect(agent.prompts).toHaveLength(1);
		expect(reviewPromptOf(agent)).toBeDefined();
	});

	it("shows the oldest facts, with their ids and their scope", async () => {
		const { runner } = await seeded(3);
		const agent = scriptedAgent([[DONE_TOOL, ""]]);
		await runner(agent).runOnce();
		const review = reviewPromptOf(agent) ?? "";
		expect(review).toContain("[f0] an older fact number 0");
		expect(review).toContain('the ids below are scope: "project"');
		expect(review).toContain("#decision");
	});

	it("runs as a second agent run, with its own step budget", async () => {
		// One run with two sections would let the transcript phase eat the
		// budget, and it routinely would - it is the phase with material.
		const { runner } = await seeded(3);
		const agent = scriptedAgent([[DONE_TOOL, ""]]);
		await runner(agent).runOnce();
		expect(agent.prompts).toHaveLength(2);
	});

	it("walks forward, so the next pass sees the next window", async () => {
		const { runner, reviewCursor } = await seeded(5, { turns: [] });
		await runner(scriptedAgent([[DONE_TOOL, ""]])).runOnce();
		expect(await reviewCursor.get("p1")).toBe(5);

		const agent = scriptedAgent([[DONE_TOOL, ""]]);
		await runner(agent).runOnce();
		// Nothing after id 4, so the walk wraps instead of re-showing the same
		// window forever - what survived one review is worth asking about again
		// later, but not immediately.
		expect(await reviewCursor.get("p1")).toBe(0);
		expect(reviewPromptOf(agent)).toBeUndefined();
	});

	it("keeps the window small, however much is stored", async () => {
		const { runner } = await seeded(20, {
			turns: [],
			settings: { review: { enabled: true, sampleSize: 4 } },
		});
		const agent = scriptedAgent([[DONE_TOOL, ""]]);
		await runner(agent).runOnce();
		const review = reviewPromptOf(agent) ?? "";
		expect(review).toContain("[f3]");
		expect(review).not.toContain("[f4]");
	});

	it("can be switched off on its own", async () => {
		const { runner } = await seeded(3, {
			settings: { review: { enabled: false, sampleSize: 12 } },
		});
		const agent = scriptedAgent([[DONE_TOOL, ""]]);
		await runner(agent).runOnce();
		expect(reviewPromptOf(agent)).toBeUndefined();
	});
});

describe("reclaiming space", () => {
	it("maintains after a pass, because nothing else ever does", async () => {
		// `forget` only tombstones; plugmem schedules no maintenance of its own.
		// Measured: a thousand facts with five hundred forgotten stayed at
		// 1278 KB until a compaction took it to 674 KB.
		const { runner, project } = build();
		await runner(scriptedAgent([[DONE_TOOL, ""]])).runOnce();
		expect(project.maintains).toBeGreaterThan(0);
	});

	it("skips it when the pass had nothing to do", async () => {
		const { runner, project } = build({ turns: [] });
		await runner(scriptedAgent([])).runOnce();
		expect(project.maintains).toBe(0);
	});

	it("can be switched off", async () => {
		const { runner, project } = build({ settings: { maintain: false } });
		await runner(scriptedAgent([[DONE_TOOL, ""]])).runOnce();
		expect(project.maintains).toBe(0);
	});
});

/**
 * The third phase. Everything here is about it staying quiet: it is the only
 * phase whose output is charged to every future request, so the interesting
 * cases are the ones where it must NOT run.
 */
describe("the habits phase", () => {
	async function withHabit(
		sessions: number,
	): Promise<{ fs: FakeFs; log: StumbleLog }> {
		const fs = new FakeFs();
		const make = (id: string) =>
			new StumbleLog({
				fs,
				file: "/ext/stumbles.json",
				flavour: path.posix,
				sessionId: id,
			});
		for (let session = 0; session < sessions; session++) {
			const one = make(`s${session}`);
			for (let i = 0; i < REPEATS_PER_SESSION; i++) {
				await one.note("id_without_scope");
			}
		}
		return { fs, log: make("current") };
	}

	it("stays out of the way when nothing is being repeated", async () => {
		const { log } = await withHabit(0);
		const { runner } = build({ turns: [], stumbles: log });
		const agent = scriptedAgent([[DONE_TOOL, ""]]);
		expect((await runner(agent).runOnce()).ran).toBe(false);
		expect(agent.prompts).toHaveLength(0);
	});

	it("stays out of the way below the threshold", async () => {
		const { log } = await withHabit(2);
		const { runner } = build({ turns: [], stumbles: log });
		const agent = scriptedAgent([[DONE_TOOL, ""]]);
		expect((await runner(agent).runOnce()).ran).toBe(false);
	});

	it("raises the habit once it is one, even with an empty transcript", async () => {
		// The point of it being its own phase: an idle machine with nothing new
		// to read is exactly when there is room for this.
		const { log } = await withHabit(3);
		const { runner } = build({ turns: [], stumbles: log });
		const agent = scriptedAgent([[DONE_TOOL, ""]]);
		expect((await runner(agent).runOnce()).ran).toBe(true);
		expect(agent.prompts[0]).toContain("In 3 different sessions");
	});

	it("does not raise the same habit twice", async () => {
		const { log } = await withHabit(3);
		const { runner } = build({ turns: [], stumbles: log });
		await runner(scriptedAgent([[DONE_TOOL, ""]])).runOnce();
		const second = scriptedAgent([[DONE_TOOL, ""]]);
		expect((await runner(second).runOnce()).ran).toBe(false);
		expect(second.prompts).toHaveLength(0);
	});

	it("leaves the question open when the pass was interrupted", async () => {
		// The model may not have got as far as deciding, and marking it settled
		// would close the question with nothing written.
		const { log } = await withHabit(3);
		const { runner } = build({ turns: [], stumbles: log });
		const aborted = new AbortController();
		aborted.abort();
		await runner(scriptedAgent([[DONE_TOOL, ""]])).runOnce(aborted.signal);
		expect(await log.worstUncovered(3)).toBeDefined();
	});

	it("can be switched off on its own", async () => {
		const { log } = await withHabit(5);
		const { runner } = build({
			turns: [],
			stumbles: log,
			settings: { habits: { enabled: false, afterSessions: 3 } },
		});
		expect((await runner(scriptedAgent([])).runOnce()).ran).toBe(false);
	});

	it("does nothing at all without a log, which is a session without one", async () => {
		const { runner } = build({ turns: [] });
		expect((await runner(scriptedAgent([])).runOnce()).ran).toBe(false);
	});
});
