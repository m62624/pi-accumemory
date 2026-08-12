/**
 * What the terminal says, per tool.
 *
 * One rule holds all of these together and it is worth stating once: the line a
 * person reads is built from what the DATABASE returned, never from what the
 * model said about it. At the moment of a forget the model does not have the
 * fact's text - it read it in a memory block several turns ago and that block is
 * rebuilt every turn - so a description written by it would be a guess sitting
 * exactly where the fact should be.
 *
 * The second rule is that `full` is not a second wording of the same thing. It
 * falls through to the answer the model received, so the two can never drift.
 */

import { describe, expect, it } from "vitest";
import {
	isToolReport,
	personLine,
	SNIP_CHARS,
	snip,
	type ToolReport,
} from "../../src/memory/tool-report.ts";
import type { WriteReport } from "../../src/memory/write-report.ts";

const write: WriteReport = {
	id: 7,
	text: "the user prefers Rust for systems work",
	scope: "user",
	scopeLabel: "your memory about the user",
	entity: "user",
	tags: ["preference"],
	vocabulary: ["preference(4)"],
	notes: [],
};

/** Every kind, so the table below cannot silently miss one. */
const EVERY: ToolReport[] = [
	{ kind: "write", write },
	{
		kind: "revise",
		scopeLabel: "this project (app)",
		oldId: 4,
		newId: 9,
		before: "the cache is off because it raced with the warmup",
		after: "the cache is on since the warmup was fixed",
	},
	{
		kind: "forget",
		scopeLabel: "your memory about the user",
		forgot: [
			{ id: 2, text: "pi-accumemory is a memory extension" },
			{ id: 5, text: "pi-accumemory is a memory extension" },
		],
		absent: [9],
	},
	{
		kind: "ask",
		label: "this project (app)",
		question: "why is the cache off",
		found: 3,
	},
	{ kind: "projects", count: 3 },
	{ kind: "tags", scopeLabel: "this project (app)", count: 17, more: false },
	{
		kind: "link",
		undone: false,
		scopeLabel: "this project (app)",
		src: "api",
		rel: "depends-on",
		dst: "db",
	},
	{
		kind: "note",
		action: "created",
		noteId: "n3",
		title: "layout",
		chars: 1200,
	},
	{ kind: "about", topic: "scopes", chars: 2600 },
];

function short(report: ToolReport): string {
	return personLine(report, "short") ?? "";
}

describe("every kind of report", () => {
	it("has a short form, and it is never empty", () => {
		for (const report of EVERY) {
			expect(short(report).length, report.kind).toBeGreaterThan(0);
		}
	});

	it("never shows a bare id with nothing to identify it", () => {
		// The complaint this whole channel answers: "[f2] or [f5] tells me
		// nothing". An id may appear, but never alone.
		for (const report of EVERY) {
			const line = short(report);
			if (!line.includes("[f")) continue;
			expect(line.replace(/\[f\d+\]/g, "").trim().length, line).toBeGreaterThan(
				20,
			);
		}
	});

	it("says nothing at all when the person asked for silence", () => {
		for (const report of EVERY) expect(personLine(report, "hidden")).toBe("");
	});

	it("defers to the model's own answer on full, except for a write", () => {
		for (const report of EVERY) {
			const full = personLine(report, "full");
			if (report.kind === "write") expect(full).toContain("entity : user");
			else expect(full, report.kind).toBeUndefined();
		}
	});
});

describe("a write", () => {
	it("shows what was stored, not only where", () => {
		expect(short({ kind: "write", write })).toBe(
			'Stored [f7] in your memory about the user: "the user prefers Rust for systems work"',
		);
	});
});

describe("a revision", () => {
	it("puts the old wording beside the new one", () => {
		const line = short(EVERY[1] as ToolReport);
		expect(line).toContain("Revised [f4] into [f9] in this project (app).");
		expect(line).toContain('was  "the cache is off');
		expect(line).toContain('now  "the cache is on');
	});
});

describe("a forget", () => {
	it("groups the ids that said the same thing", () => {
		// The job this tool exists for produces exactly this shape: several ids
		// over one repeated sentence. Printing the sentence once per id would
		// hide the duplication that was the reason for the call.
		const line = short(EVERY[2] as ToolReport);
		expect(line).toContain("Forgot 2 facts from your memory about the user.");
		expect(line).toContain('[f2] [f5]  "pi-accumemory is a memory extension"');
		expect(line.match(/pi-accumemory is a memory extension/g)).toHaveLength(1);
	});

	it("names the ids that were not there separately", () => {
		expect(short(EVERY[2] as ToolReport)).toContain("Not there: [f9]");
	});

	it("says nothing about facts when none went away", () => {
		const line = short({
			kind: "forget",
			scopeLabel: "this project (app)",
			forgot: [],
			absent: [3],
		});
		expect(line).not.toMatch(/forgot/i);
		expect(line).toContain("[f3]");
	});

	it("survives a fact whose text could not be read", () => {
		// `get` can return nothing for a fact the engine still agrees to close.
		// An empty pair of quotes is honest; a crash in the renderer is not.
		const line = short({
			kind: "forget",
			scopeLabel: "this project (app)",
			forgot: [{ id: 1, text: "" }],
			absent: [],
		});
		expect(line).toContain('[f1]  ""');
	});
});

describe("a question", () => {
	it("counts what came back", () => {
		expect(short(EVERY[3] as ToolReport)).toBe(
			'Asked this project (app): "why is the cache off" - 3 facts.',
		);
	});

	it("says plainly when nothing did", () => {
		expect(
			short({
				kind: "ask",
				label: "both memories",
				question: "anything",
				found: 0,
			}),
		).toContain("nothing on this");
	});

	it("counts one fact in the singular", () => {
		expect(
			short({ kind: "ask", label: "both memories", question: "x", found: 1 }),
		).toContain("1 fact.");
	});
});

describe("the rest", () => {
	it("counts projects", () => {
		expect(short({ kind: "projects", count: 3 })).toBe(
			"3 projects with a memory.",
		);
		expect(short({ kind: "projects", count: 0 })).toBe(
			"No projects have a memory yet.",
		);
	});

	it("counts tags, and says when there are more", () => {
		expect(short(EVERY[5] as ToolReport)).toBe(
			"17 tags in this project (app).",
		);
		expect(
			short({
				kind: "tags",
				scopeLabel: "this project (app)",
				count: 50,
				more: true,
			}),
		).toContain("50+ tags");
	});

	it("draws a link the way the tool describes it", () => {
		expect(short(EVERY[6] as ToolReport)).toBe(
			"Linked api -depends-on-> db in this project (app).",
		);
		expect(
			short({
				kind: "link",
				undone: true,
				scopeLabel: "this project (app)",
				src: "api",
				rel: "depends-on",
				dst: "db",
			}),
		).toContain("Unlinked");
	});

	it("names a note and its size, never its body", () => {
		expect(short(EVERY[7] as ToolReport)).toBe(
			'Created note n3 "layout" (1.2 kB).',
		);
		expect(short({ kind: "note", action: "deleted", noteId: "n3" })).toBe(
			"Deleted note n3.",
		);
	});

	it("says which page was read, and not the page", () => {
		// The pages run to thousands of characters and are written for the
		// model. A person wants to know their agent went and read the manual.
		expect(short(EVERY[8] as ToolReport)).toBe(
			'Read the "scopes" page of longterm_about (2.6 kB).',
		);
	});
});

describe("recognising a report at all", () => {
	it("accepts one", () => {
		expect(isToolReport({ kind: "projects", count: 0 })).toBe(true);
	});

	it("rejects what a failed call leaves behind", () => {
		// The shape check exists because the renderer used to decide "this was a
		// write" on the detail not being undefined, and printed
		// `Stored [fundefined] in undefined.` over a crash.
		expect(isToolReport(undefined)).toBe(false);
		expect(isToolReport(null)).toBe(false);
		expect(isToolReport("Stored")).toBe(false);
		expect(isToolReport({})).toBe(false);
		expect(isToolReport({ id: 7 })).toBe(false);
	});
});

describe("cutting long text", () => {
	it("leaves a short fact exactly as it was stored", () => {
		expect(snip("the linter here is biome")).toBe("the linter here is biome");
	});

	it("cuts a long one and says it cut", () => {
		const long = "x".repeat(SNIP_CHARS * 2);
		const cut = snip(long);
		expect(cut.length).toBe(SNIP_CHARS);
		expect(cut.endsWith("...")).toBe(true);
	});

	it("flattens newlines, because one fact is one line here", () => {
		expect(snip("two\n\nlines")).toBe("two lines");
	});
});
