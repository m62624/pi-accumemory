import { describe, expect, it } from "vitest";
import {
	consolidationBlock,
	dropVisible,
	memoryBlock,
	memoryManifest,
} from "../../src/memory/block.ts";
import type { Turn } from "../../src/memory/transcript-view.ts";
import { liveFacts } from "../../src/storage/port.ts";

const rendered = [
	"- [f1] cache disabled: warmup race",
	"- [f2] tests run under vitest",
].join("\n");

describe("dropVisible", () => {
	it("drops a fact the model can already read above", () => {
		const turns: Turn[] = [
			{ role: "tool", text: "cache disabled: warmup race" },
		];
		expect(dropVisible(rendered, turns)).toBe("- [f2] tests run under vitest");
	});

	it("keeps everything when nothing overlaps", () => {
		expect(dropVisible(rendered, [{ role: "user", text: "hello" }])).toBe(
			rendered,
		);
	});

	it("returns nothing rather than an empty heading", () => {
		// A heading with every line under it removed claims the memory answered
		// and then shows nothing — worse than saying nothing at all.
		const turns: Turn[] = [
			{ role: "tool", text: "cache disabled: warmup race" },
			{ role: "tool", text: "tests run under vitest" },
		];
		expect(dropVisible(rendered, turns)).toBe("");
	});

	it("ignores whitespace and case when comparing", () => {
		const turns: Turn[] = [
			{ role: "tool", text: "  CACHE   disabled:\n warmup race " },
		];
		expect(dropVisible(rendered, turns)).not.toContain("f1");
	});

	it("is unchanged by an empty transcript", () => {
		expect(dropVisible(rendered, [])).toBe(rendered);
	});

	it("leaves non-fact lines alone", () => {
		const withHeading = `Some heading\n${rendered}`;
		const turns: Turn[] = [
			{ role: "tool", text: "cache disabled: warmup race" },
		];
		expect(dropVisible(withHeading, turns)).toContain("Some heading");
	});
});

describe("memoryBlock", () => {
	const project = {
		scope: "project" as const,
		label: "this project (app)",
		rendered,
	};
	const user = {
		scope: "user" as const,
		label: "your memory about the user",
		rendered: "## memory\n- [f3] user: prefers Rust (2026-05; active)",
	};

	it("produces nothing when nothing was recalled", () => {
		// An empty section is a tax charged on every turn, and it teaches the
		// model that the memory heading is usually noise.
		expect(memoryBlock([])).toBe("");
		expect(memoryBlock([{ ...project, rendered: "   \n  " }])).toBe("");
	});

	it("says whose memory it is, that it may miss, and not to re-ask", () => {
		const block = memoryBlock([project]);
		expect(block).toContain(rendered);
		expect(block).toMatch(/your own long-term memory/i);
		expect(block).toMatch(/ignore/i);
		expect(block).toMatch(/do not ask/i);
	});

	it("explains itself exactly once, however many memories answered", () => {
		// Wrapping each memory separately printed the same ninety words twice,
		// with one scope named between the copies and the other after them - so
		// a model reading top to bottom could attach either footer to either
		// half. The ids are per-memory, so that ambiguity picks the wrong fact.
		const block = memoryBlock([project, user]);
		expect(block.split("your own long-term memory")).toHaveLength(2);
		expect(block.split("What you remember")).toHaveLength(2);
	});

	it("labels every section with the scope its ids belong to", () => {
		const block = memoryBlock([project, user]);
		expect(block).toContain(
			'this project (app) - the ids below are scope: "project"',
		);
		expect(block).toContain(
			'your memory about the user - the ids below are scope: "user"',
		);
		// In the order given: project first, so the safer memory to write to is
		// the one nearest the model's own reply.
		expect(block.indexOf("[f0]")).toBeLessThan(block.indexOf("[f3]"));
	});

	it("drops a memory that answered nothing, keeping the one that did", () => {
		const block = memoryBlock([{ ...project, rendered: "" }, user]);
		expect(block).not.toContain("this project (app)");
		expect(block).toContain("[f3]");
	});

	it("tells the model how to act on an id it reads there", () => {
		expect(memoryBlock([project])).toMatch(
			/pass its \[fN\] together with the scope written above the section/i,
		);
	});
});

describe("memoryManifest", () => {
	it("tells the model the memory is worth asking, and in which categories", () => {
		const line = memoryManifest([
			{
				label: "Project memory",
				facts: 47,
				tags: [{ name: "decision", count: 12 }],
			},
			{ label: "User memory", facts: 23, tags: [] },
		]);
		expect(line).toContain("Project memory: 47 facts");
		expect(line).toContain("decision(12)");
		expect(line).toContain("User memory: 23 facts");
	});

	it("says nothing at all when every scope is empty", () => {
		// "0 facts" invites the model to conclude the memory is useless and stop
		// asking; saying nothing leaves the tools to speak for themselves.
		expect(
			memoryManifest([{ label: "Project memory", facts: 0, tags: [] }]),
		).toBe("");
	});

	it("omits an empty scope but keeps a non-empty one", () => {
		const line = memoryManifest([
			{ label: "Project memory", facts: 0, tags: [] },
			{ label: "User memory", facts: 3, tags: [] },
		]);
		expect(line).not.toContain("Project memory");
		expect(line).toContain("User memory: 3 facts");
	});
});

describe("consolidationBlock", () => {
	it("says the ids are actionable, because otherwise the model narrates", () => {
		const block = consolidationBlock(rendered);
		expect(block).toContain(rendered);
		expect(block).toMatch(/longterm_revise/);
		expect(block).toMatch(/longterm_forget/);
	});

	it("states plainly that the memory is empty", () => {
		expect(consolidationBlock("")).toMatch(/empty/i);
	});
});

describe("liveFacts", () => {
	it("subtracts what is forgotten but not yet purged", () => {
		// `facts` counts stored records, so a memory that was just tidied would
		// otherwise claim to hold more than it did before it was tidied.
		expect(
			liveFacts({
				facts: 47,
				entities: 3,
				edges: 0,
				vectors: 47,
				tombstones: 5,
			}),
		).toBe(42);
	});

	it("never goes below zero", () => {
		// The two numbers come from the engine separately. A report reading
		// "-3 facts" because they disagreed for a moment is worse than "0".
		expect(
			liveFacts({
				facts: 2,
				entities: 0,
				edges: 0,
				vectors: 0,
				tombstones: 9,
			}),
		).toBe(0);
	});
});
