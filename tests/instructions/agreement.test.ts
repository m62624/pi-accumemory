/**
 * The instructions must describe the software that actually exists.
 *
 * Every check here stands for a specific way the text had drifted from the code
 * while both were individually correct. The model has no way to notice: it does
 * what the prose says, gets an error the prose does not predict, and concludes
 * something false about its own tools.
 *
 * Found by reading the instructions as a model with nothing but those bytes:
 *
 * - the block example quoted a heading that no render ever produced;
 * - the notes section spelled a parameter `noteId` while the schema declared
 *   `note_id`;
 * - one rule was stated twice, in two places, in two different wordings, one of
 *   them absolute and the other with an exception.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_INSTRUCTIONS } from "../../src/instructions/bundled.ts";
import { memoryBlock } from "../../src/memory/block.ts";
import { NoteStore } from "../../src/notes/store.ts";
import { ProjectRouter } from "../../src/router/router.ts";
import { MemoryController } from "../../src/session/controller.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import {
	LONGTERM_TOOL_NAMES,
	longtermTools,
} from "../../src/tools/definitions.ts";
import { FakeFs } from "../helpers/fake-fs.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

const everything = Object.values(BUNDLED_INSTRUCTIONS).join("\n\n");

/** The first ```-fenced block of a document, without its fences. */
function fencedBlock(text: string): string {
	const match = /```\n([\s\S]*?)```/.exec(text);
	return match?.[1]?.trim() ?? "";
}

function tools() {
	const common = new FakeMemory();
	const fs = new FakeFs();
	return longtermTools(
		new MemoryController({
			settings: DEFAULT_SETTINGS,
			common,
			project: new FakeMemory(),
			notesCommon: new NoteStore(common, {
				fs,
				dir: "/c",
				flavour: path.posix,
			}),
			router: new ProjectRouter(common),
		}),
	);
}

describe("the instructions and the code agree", () => {
	it("shows a block example the renderer really produces, line for line", () => {
		// The example used to quote `## memory - this project (name)`, a line
		// that appears nowhere. Checking two landmark lines was not enough
		// either: the renderer later stopped emitting the engine's `## memory`
		// heading and the example kept it, and nothing failed. So the whole
		// example is compared against a real render of the same facts.
		const real = memoryBlock([
			{
				scope: "project",
				label: "this project (app)",
				rendered:
					"## memory\n- [f0] project:app: the cache is off: it raced with the warmup (2026-08; active) #decision",
			},
			{
				scope: "user",
				label: "your memory about the user",
				rendered:
					"## memory\n- [f3] user: prefers Rust for systems work (2026-05; active) #preference",
			},
		]);
		const example = fencedBlock(BUNDLED_INSTRUCTIONS.reading ?? "");
		expect(example, "the reading section has no fenced example").not.toBe("");
		// The example quotes the block down to its footer; the real one carries
		// the footer too, so compare what the example chose to show.
		expect(real.startsWith(example)).toBe(true);
	});

	it("names only tools that are registered", () => {
		const known = new Set<string>(LONGTERM_TOOL_NAMES);
		known.add("longterm_done"); // pass-only, registered by the runner
		for (const [, name] of everything.matchAll(/`?(longterm_[a-z_]+)`?/g)) {
			expect(known, `instructions mention ${name}`).toContain(name);
		}
	});

	it("spells every parameter the way its schema declares it", () => {
		// `longterm_note_read(noteId)` in prose against `note_id` in the schema
		// is a call the model cannot make and cannot debug.
		const declared = new Map<string, Set<string>>();
		for (const tool of tools()) {
			declared.set(tool.name, new Set(Object.keys(tool.parameters.properties)));
		}
		// Every `longterm_x { "a": ..., "b": ... }` written in the instructions.
		const calls = everything.matchAll(/(longterm_[a-z_]+) \{([^}]*)\}/g);
		let checked = 0;
		for (const [, name, body] of calls) {
			const properties = declared.get(name ?? "");
			if (properties === undefined) continue;
			for (const [, key] of (body ?? "").matchAll(/"([a-z_]+)":/g)) {
				checked += 1;
				expect(properties, `${name} has no parameter "${key}"`).toContain(key);
			}
		}
		expect(checked, "no example calls were checked").toBeGreaterThan(0);
	});

	it("does not promise a default where the schema requires the argument", () => {
		for (const name of [
			"longterm_revise",
			"longterm_forget",
			"longterm_forget_many",
		]) {
			const tool = tools().find((candidate) => candidate.name === name);
			expect(tool?.parameters.required, name).toContain("scope");
		}
		// And the instructions say so, in the words a reader would search for.
		expect(BUNDLED_INSTRUCTIONS.memory).toMatch(
			/`longterm_forget_many` \*\*require\*\*\n`scope`/,
		);
		expect(BUNDLED_INSTRUCTIONS.placement).toMatch(/REQUIRED on/);
	});
});

describe("one thought, one place", () => {
	/** How many of the instruction files state a rule matching `pattern`. */
	const filesStating = (pattern: RegExp): string[] =>
		Object.entries(BUNDLED_INSTRUCTIONS)
			.filter(([, text]) => pattern.test(text))
			.map(([key]) => key);

	it("states the block-is-not-a-message rule once", () => {
		// It used to be in two files: an absolute "Never answer the memory
		// block" in one and "unless the user raised the subject" in the other.
		// A live session stalled on exactly that gap, declining to act on a
		// clean-up the user had asked for one turn earlier.
		expect(filesStating(/answer(ing)? (that|the|this) block/i)).toEqual([
			"reading",
		]);
	});

	it("states the id-needs-a-scope rule in one place, and points at it", () => {
		expect(filesStating(/number their facts separately/i)).toEqual(["reading"]);
		// The other files may reference it - by name, so it can be found.
		expect(BUNDLED_INSTRUCTIONS.memory).toContain(
			"How to read what you are shown",
		);
	});

	it("states the one-fact-per-remember rule once", () => {
		expect(filesStating(/one call, one fact/i)).toEqual(["memory"]);
	});

	it("gives the turn exactly one ordered procedure", () => {
		expect(filesStating(/## The order of a turn/)).toEqual(["memory"]);
	});
});
