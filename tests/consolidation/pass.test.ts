import { describe, expect, it } from "vitest";
import { ConsolidationLedger } from "../../src/consolidation/ledger.ts";
import {
	passMemoryView,
	passPrompt,
	passTail,
} from "../../src/consolidation/pass.ts";
import type { Turn } from "../../src/memory/transcript-view.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";

const context = {
	instructions: "Collapse repetition. Drop what expired.",
	clock: "[Now: Tuesday, 11 August 2026 at 17:30 (UTC)]",
	memory: passMemoryView("- [f1] plays that game on Saturday at 20:30"),
	transcript: [
		{ role: "user", text: "I will play at 20:30 on Saturday" },
		{ role: "assistant", text: "noted" },
	] as Turn[],
	label: "this project (app)",
};

describe("passPrompt", () => {
	it("says outright that nobody is waiting for an answer", () => {
		// Without this the pass writes a summary for a reader who does not
		// exist, and changes nothing.
		expect(passPrompt(context)).toMatch(/nobody is waiting/i);
	});

	it("identifies the specialist and its tool boundary", () => {
		const prompt = passPrompt(context);
		expect(prompt).toContain("pi-accumemory's memory-consolidation specialist");
		expect(prompt).toMatch(/full access to pi-accumemory's memory tools/i);
		expect(prompt).toMatch(/do not have access to .*filesystem/i);
	});

	it("carries the clock, which is what makes a date judgeable", () => {
		expect(passPrompt(context)).toContain("[Now:");
	});

	it("shows the current memory with actionable ids", () => {
		const prompt = passPrompt(context);
		expect(prompt).toContain("[f1]");
		expect(prompt).toContain("longterm_forget");
	});

	it("renders the transcript with speakers named", () => {
		const prompt = passPrompt(context);
		expect(prompt).toContain("User: I will play at 20:30 on Saturday");
		expect(prompt).toContain("You: noted");
	});

	it("says so plainly when there is nothing new", () => {
		expect(passPrompt({ ...context, transcript: [] })).toMatch(/nothing new/i);
	});

	it("drops empty turns rather than printing blank speakers", () => {
		const prompt = passPrompt({
			...context,
			transcript: [{ role: "tool", text: "" }] as Turn[],
		});
		expect(prompt).not.toContain("Tool result:");
	});
});

describe("passMemoryView", () => {
	it("states that an untouched memory is empty", () => {
		expect(passMemoryView("")).toMatch(/empty/i);
	});
});

describe("passTail", () => {
	it("is the ledger's directive and nothing else", () => {
		const ledger = new ConsolidationLedger(
			DEFAULT_SETTINGS.memory.consolidation,
		);
		expect(passTail(ledger)).toBe(ledger.directive().text);
	});

	it("changes as the pass gets stuck", () => {
		const ledger = new ConsolidationLedger(
			DEFAULT_SETTINGS.memory.consolidation,
		);
		const opening = passTail(ledger);
		ledger.noteIdleTurn();
		expect(passTail(ledger)).not.toBe(opening);
	});
});
