import { describe, expect, it } from "vitest";
import { BUNDLED_INSTRUCTIONS } from "../../src/instructions/bundled.ts";
import { INSTRUCTION_KEYS } from "../../src/instructions/manager.ts";

describe("BUNDLED_INSTRUCTIONS", () => {
	it("covers every key, so no key syncs to an empty file", () => {
		for (const key of INSTRUCTION_KEYS) {
			expect(BUNDLED_INSTRUCTIONS[key]?.trim().length ?? 0).toBeGreaterThan(0);
		}
	});

	it("names the tools it talks about, so the model does not have to guess", () => {
		expect(BUNDLED_INSTRUCTIONS.memory).toContain("longterm_ask");
		expect(BUNDLED_INSTRUCTIONS.memory).toContain("longterm_remember");
		expect(BUNDLED_INSTRUCTIONS.notes).toContain("longterm_note_create");
		expect(BUNDLED_INSTRUCTIONS.consolidation).toContain("longterm_done");
	});

	it("states the placement rule and its asymmetry", () => {
		expect(BUNDLED_INSTRUCTIONS.placement).toMatch(/would this still be true/i);
		expect(BUNDLED_INSTRUCTIONS.placement).toMatch(
			/never write the same fact to both/i,
		);
	});

	it("separates a question ABOUT the memory from a question FOR it", () => {
		// Measured in a real session: asked to name its own rules for the memory,
		// a local model ran longterm_ask three times and found nothing, because
		// "instruction" is both a rule it was given and a tag on a stored fact.
		// Only the second one lives in the memory.
		expect(BUNDLED_INSTRUCTIONS.memory).toMatch(
			/question ABOUT the memory is not a question FOR the memory/,
		);
		expect(BUNDLED_INSTRUCTIONS.memory).toContain("longterm_about");
		// The ambiguity itself is named, not just the rule.
		expect(BUNDLED_INSTRUCTIONS.memory).toMatch(/word \*instruction\*/);
	});

	it("names a correction as the durable fact it is", () => {
		// The same session stored nothing at all, including "do not run the
		// tests" - a standing preference that costs a repeat every session it is
		// missing. It arrives as an interruption, which is what makes it feel
		// like something to apologise for rather than something to keep.
		expect(BUNDLED_INSTRUCTIONS.memory).toMatch(/\*\*a correction\.\*\*/);
		expect(BUNDLED_INSTRUCTIONS.memory).toMatch(
			/the user corrected you.*longterm_remember/i,
		);
	});

	it("forbids credentials in plain words", () => {
		expect(BUNDLED_INSTRUCTIONS.secrets).toMatch(/never store/i);
		expect(BUNDLED_INSTRUCTIONS.secrets).toMatch(/\.env/);
		expect(BUNDLED_INSTRUCTIONS.secrets).toMatch(
			/cannot\s+be\s+switched\s+off/i,
		);
	});

	it("is written in ASCII, so no console or editor mangles it", () => {
		// The instruction text lands in a prompt, a terminal and a markdown
		// file on three operating systems; the plainest possible bytes travel
		// best through all of them.
		for (const [key, text] of Object.entries(BUNDLED_INSTRUCTIONS)) {
			const offending = [...text].find(
				(char) =>
					char.codePointAt(0) !== undefined &&
					(char.codePointAt(0) ?? 0) > 0x7f,
			);
			expect(
				offending,
				`${key} contains ${JSON.stringify(offending)}`,
			).toBeUndefined();
		}
	});
});
