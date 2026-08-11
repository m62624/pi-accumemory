import { describe, expect, it } from "vitest";
import {
	consolidationBlock,
	dropVisible,
	memoryBlock,
	memoryManifest,
} from "../../src/memory/block.ts";
import type { Turn } from "../../src/memory/transcript-view.ts";

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
	it("produces nothing for an empty recall", () => {
		// An empty section is a tax charged on every turn, and it teaches the
		// model that the memory heading is usually noise.
		expect(memoryBlock("", "this project")).toBe("");
		expect(memoryBlock("   \n  ", "this project")).toBe("");
	});

	it("says whose memory it is, that it may miss, and not to re-ask", () => {
		const block = memoryBlock(rendered, "this project");
		expect(block).toContain(rendered);
		expect(block).toMatch(/your own long-term memory/i);
		expect(block).toMatch(/ignore/i);
		expect(block).toMatch(/do not ask/i);
	});

	it("names the scope it was retrieved from", () => {
		expect(memoryBlock(rendered, "this project")).toContain("this project");
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
