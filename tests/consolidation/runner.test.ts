import path from "node:path";
import { describe, expect, it } from "vitest";
import { CursorStore } from "../../src/consolidation/cursor-store.ts";
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

function build(options: { turns?: Turn[]; enabled?: boolean } = {}) {
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
			},
			controller,
			cursors,
			instructions,
			agent,
			cursorKey: "p1",
			label: "this project (app)",
			clock: () => "[Now: Tuesday, 11 August 2026 at 17:30 (UTC)]",
			readTail: async (cursor) => {
				readCursor = cursor;
				return { turns, cursor: { file: "a.jsonl", line: 12 } };
			},
		});
	return { runner, cursors, project, common, seenCursor: () => readCursor };
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
