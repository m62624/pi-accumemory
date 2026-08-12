/**
 * The one thing the model can write that costs it context forever.
 *
 * A fact tagged `instruction` + `always` is pasted into the head of every
 * request of every later session. The instruction file asks for few and short;
 * an instruction file cannot enforce anything, and the phase that proposes
 * these rules is itself run by a model.
 *
 * So the ceiling is code, and these tests are about it holding: at the count,
 * at the character budget, on a revision as well as a write, and - the one that
 * would be easy to get wrong - a rule that replaces itself must not be counted
 * against itself.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { NoteStore } from "../../src/notes/store.ts";
import { ProjectRouter } from "../../src/router/router.ts";
import {
	ALWAYS_TAG,
	INSTRUCTION_TAG,
	MemoryController,
} from "../../src/session/controller.ts";
import {
	DEFAULT_SETTINGS,
	type Settings,
} from "../../src/settings/defaults.ts";
import { FakeFs } from "../helpers/fake-fs.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

const RULE_TAGS = [INSTRUCTION_TAG, ALWAYS_TAG];

/** Sentences with nothing in common, so the duplicate guard stays out of it. */
const DISTINCT = [
	"name the scope beside every fact id",
	"prefer one statement per write",
	"check the clock before storing a date",
];

function build(limits: { alwaysMax: number; alwaysMaxChars: number }) {
	const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
	settings.memory.instructions = limits;
	const common = new FakeMemory();
	const project = new FakeMemory();
	const fs = new FakeFs();
	const controller = new MemoryController({
		settings,
		common,
		project,
		projectName: "app",
		notesCommon: new NoteStore(common, { fs, dir: "/n", flavour: path.posix }),
		router: new ProjectRouter(common),
	});
	return { controller, common };
}

/** Fills the user memory with `count` standing rules. */
async function fill(
	controller: MemoryController,
	count: number,
	text: (index: number) => string,
): Promise<void> {
	for (let i = 0; i < count; i++) {
		const answer = await controller.remember({
			text: text(i),
			tags: RULE_TAGS,
			scope: "user",
		});
		expect(answer).not.toContain("Not stored");
	}
}

describe("standing rules cannot grow without limit", () => {
	it("refuses one past the count this installation shows", async () => {
		const { controller } = build({ alwaysMax: 3, alwaysMaxChars: 4000 });
		// Genuinely different sentences: the duplicate guard refuses near-copies,
		// and a test that trips it is testing the wrong mechanism.
		await fill(controller, 3, (i) => DISTINCT[i] ?? "");
		const answer = await controller.remember({
			text: "one rule too many for the block to show",
			tags: RULE_TAGS,
			scope: "user",
		});
		expect(answer).toContain("Not stored");
		expect(answer).toContain("at most 3");
	});

	it("refuses one past the character budget", async () => {
		const { controller } = build({ alwaysMax: 20, alwaysMaxChars: 120 });
		await fill(controller, 1, () => "a".repeat(100));
		const answer = await controller.remember({
			text: "b".repeat(100),
			tags: RULE_TAGS,
			scope: "user",
		});
		expect(answer).toContain("Not stored");
		expect(answer).toContain("120 characters");
	});

	it("names the rules already standing, so the answer is reachable", async () => {
		const { controller } = build({ alwaysMax: 1, alwaysMaxChars: 4000 });
		await fill(controller, 1, () => "always name the scope beside a fact id");
		const answer = await controller.remember({
			text: "and something else entirely",
			tags: RULE_TAGS,
			scope: "user",
		});
		expect(answer).toContain("always name the scope beside a fact id");
		expect(answer).toContain("longterm_revise");
	});

	it("leaves ordinary facts alone, however many there are", async () => {
		const { controller } = build({ alwaysMax: 1, alwaysMaxChars: 40 });
		await fill(controller, 1, () => "always name the scope");
		// Same tag, but not `always`: found by asking, never injected.
		for (const text of ["run the tests with npm run ci", "the cache is off"]) {
			const answer = await controller.remember({
				text,
				tags: [INSTRUCTION_TAG],
				scope: "user",
			});
			expect(answer).not.toContain("Not stored");
		}
	});

	it("stops a revision growing one past the budget", async () => {
		const { controller } = build({ alwaysMax: 4, alwaysMaxChars: 100 });
		await fill(controller, 1, () => "short rule");
		const [rule] = await controller.alwaysRules();
		expect(rule).toBeDefined();
		const answer = await controller.revise(
			rule?.id ?? 0,
			"c".repeat(200),
			"user",
		);
		expect(answer).toContain("Not stored");
	});

	it("does not count a rule against itself when it is the one being revised", async () => {
		// The trap: with the block full, revising an existing rule reads as
		// "one more rule" unless the one being replaced is taken out first, and
		// then no standing rule could ever be corrected.
		const { controller } = build({ alwaysMax: 2, alwaysMaxChars: 4000 });
		await fill(controller, 2, (i) => DISTINCT[i] ?? "");
		const [first] = await controller.alwaysRules();
		expect(first).toBeDefined();
		const answer = await controller.revise(
			first?.id ?? 0,
			"give the scope whenever an id appears",
			first?.scope ?? "user",
		);
		expect(answer).toContain("Revised");
	});

	it("accepts a rule that fits", async () => {
		const { controller } = build({ alwaysMax: 8, alwaysMaxChars: 1200 });
		const answer = await controller.remember({
			text: "always pass scope beside a fact id",
			tags: RULE_TAGS,
			scope: "user",
		});
		expect(answer).not.toContain("Not stored");
		expect((await controller.alwaysRules()).length).toBe(1);
	});
});
