/**
 * The phase that can end in a permanent rule, so the tests are about restraint:
 * it must not fire below the threshold, must raise one habit rather than four,
 * must never ask twice about a settled question, and must leave the question
 * open when the pass was cut short.
 */

import { describe, expect, it } from "vitest";
import { habitsPrompt } from "../../src/consolidation/habits.ts";
import type { StumbleReport } from "../../src/session/stumbles.ts";

const HABIT: StumbleReport = {
	kind: "id_without_scope",
	sessions: 4,
	lastSeen: "2026-08-12",
	covered: false,
	sinceCovered: 0,
};

const LIMITS = { alwaysMax: 8, alwaysMaxChars: 1200 };

function prompt(overrides: Partial<Parameters<typeof habitsPrompt>[0]> = {}) {
	return habitsPrompt({
		clock: "[Now: 2026-08-12]",
		habit: HABIT,
		standing: [],
		limits: LIMITS,
		...overrides,
	});
}

describe("the habits prompt", () => {
	it("says how many separate sessions made the mistake", () => {
		// The number is the whole argument for spending permanent context. A
		// prompt that only describes the mistake is asking for a rule about one
		// bad evening.
		expect(prompt()).toContain("In 4 different sessions");
		expect(prompt()).toContain("2026-08-12");
	});

	it("describes the mistake in words, not by its internal name", () => {
		expect(prompt()).toContain("no scope");
		expect(prompt()).not.toContain("id_without_scope");
	});

	it("asks for the correct action rather than a prohibition", () => {
		// Left to itself a model writes "never use longterm_forget", which is
		// obeyed exactly and costs it the tool.
		expect(prompt()).toContain("CORRECT action, not a prohibition");
	});

	it("quotes the ceiling, so brevity is a fact rather than a request", () => {
		const text = prompt();
		expect(text).toContain("at most 8 standing rules");
		expect(text).toContain("1200 characters");
	});

	it("puts the rule in the user memory, where it holds everywhere", () => {
		expect(prompt()).toContain('scope: "user"');
	});

	it("shows the rules already standing when there are any", () => {
		const text = prompt({ standing: ["name the scope beside every fact id"] });
		expect(text).toContain("name the scope beside every fact id");
		expect(text).toContain("do not write a second");
	});

	it("says nothing about existing rules when there are none", () => {
		expect(prompt()).not.toContain("already written");
	});

	it("allows the answer to be no", () => {
		// A phase that cannot end without writing something is a machine for
		// manufacturing rules.
		expect(prompt()).toContain("does not warrant a standing rule");
	});

	it("ends by naming the tool that closes the pass", () => {
		expect(prompt()).toContain("longterm_done");
	});
});
