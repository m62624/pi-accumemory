/**
 * The rebuild panel and the sentence it leaves behind.
 *
 * Both are pure functions precisely so they can be checked here: the thing they
 * are for - telling a person what is happening during the one slow operation in
 * this extension - is invisible to every other test in the suite.
 */

import { describe, expect, it } from "vitest";
import {
	type ProgressStep,
	reembedProgressLines,
	reembedSummary,
	SPINNER,
} from "../../src/ui/reembed-progress.ts";

const steps = (...states: ProgressStep["state"][]): ProgressStep[] =>
	states.map((state, index) => ({ label: `db${index}`, state }));

describe("reembedProgressLines", () => {
	it("lists every database from the first frame", () => {
		// Including the ones not started yet: the length of the job has to be
		// visible at once, not discovered one line at a time.
		const lines = reembedProgressLines(
			steps("running", "waiting", "waiting"),
			0,
		);
		expect(lines[0]).toContain("0 of 3");
		expect(lines).toHaveLength(5);
		expect(lines[2]).toContain("db1");
	});

	it("moves between frames so it cannot be mistaken for a hang", () => {
		const first = reembedProgressLines(steps("running"), 0);
		const second = reembedProgressLines(steps("running"), 1);
		expect(first[0]).not.toBe(second[0]);
		expect(first[0]?.startsWith(SPINNER[0] ?? "")).toBe(true);
	});

	it("wraps the spinner rather than running off the end of it", () => {
		const wrapped = reembedProgressLines(steps("running"), SPINNER.length);
		expect(wrapped[0]).toBe(reembedProgressLines(steps("running"), 0)[0]);
	});

	it("counts finished and skipped alike as no longer pending", () => {
		const lines = reembedProgressLines(steps("done", "skipped", "running"), 0);
		expect(lines[0]).toContain("2 of 3");
	});

	it("stops spinning once nothing is running", () => {
		expect(reembedProgressLines(steps("done", "skipped"), 0)[0]).toMatch(/^✓/);
	});

	it("says the memory is answering from old vectors meanwhile", () => {
		// Otherwise a rebuild looks like a moment when memory is simply broken.
		expect(reembedProgressLines(steps("running"), 0).join("\n")).toMatch(
			/old vectors/i,
		);
	});
});

describe("reembedSummary", () => {
	it("reports a clean run in one sentence", () => {
		expect(reembedSummary(steps("done", "done"))).toBe(
			"Rebuilt 2 of 2 memories.",
		);
	});

	it("names what it could not rebuild, and what to do", () => {
		// A skipped database leaves the workspace answering from two vector
		// spaces at once, and nothing else will ever mention it again.
		const summary = reembedSummary([
			{ label: "shared memory about you", state: "done" },
			{ label: "api", state: "skipped" },
		]);
		expect(summary).toContain("Rebuilt 1 of 2");
		expect(summary).toContain("api");
		expect(summary).toMatch(/another pi session has it open/i);
		expect(summary).toContain("/longterm-reembed");
	});

	it("reads correctly with more than one left behind", () => {
		const summary = reembedSummary([
			{ label: "api", state: "skipped" },
			{ label: "web", state: "skipped" },
		]);
		expect(summary).toContain("api, web");
		expect(summary).toMatch(/has them open/i);
	});
});
