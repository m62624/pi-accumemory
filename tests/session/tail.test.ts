import { describe, expect, it } from "vitest";
import { alwaysBlock, buildTail, clockLine } from "../../src/session/tail.ts";

describe("buildTail", () => {
	it("is empty when there is nothing to add", () => {
		// No memory, no clock, no nudge: the extension adds no bytes at all,
		// and the prompt is exactly what pi built.
		expect(buildTail({})).toBe("");
		expect(buildTail({ block: "  ", clock: "" })).toBe("");
	});

	it("puts the clock first, so everything after it can be dated", () => {
		const tail = buildTail({ clock: "[Now: X]", block: "facts" });
		expect(tail.indexOf("[Now: X]")).toBeLessThan(tail.indexOf("facts"));
	});

	it("puts the nudge last, because a model acts on what it read last", () => {
		const tail = buildTail({
			clock: "[Now: X]",
			block: "facts",
			alwaysInstructions: "rules",
			writeNudge: "save something",
		});
		const order = ["[Now: X]", "facts", "rules", "save something"].map((part) =>
			tail.indexOf(part),
		);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it("shows exactly one nudge, even when both are due", () => {
		// Two requests for two different actions, one after the other, are a
		// choice the model must resolve before it can do anything - and it
		// resolves it by position rather than by merit.
		const tail = buildTail({
			clock: "[Now: X]",
			writeNudge: "save something",
			askHint: "ask memory",
		});
		expect(tail).toContain("save something");
		expect(tail).not.toContain("ask memory");
	});

	it("prefers the write reminder, because a fact not stored is gone", () => {
		// A question not asked can be asked next turn; a fact not stored ends
		// with the session.
		expect(
			buildTail({ writeNudge: "save something", askHint: "ask memory" }),
		).toBe("save something");
	});

	it("still shows the ask hint when it is the only one due", () => {
		expect(buildTail({ askHint: "ask memory" })).toBe("ask memory");
		expect(buildTail({ writeNudge: "   ", askHint: "ask memory" })).toBe(
			"ask memory",
		);
	});

	it("skips absent parts without leaving blank gaps", () => {
		expect(buildTail({ clock: "[Now: X]", askHint: "ask" })).toBe(
			"[Now: X]\n\nask",
		);
	});
});

describe("clockLine", () => {
	const at = new Date("2026-08-11T17:30:00Z");

	it("names the zone, because a bare timestamp cannot date a fact", () => {
		const line = clockLine(at, "Asia/Almaty");
		expect(line).toContain("Asia/Almaty");
		expect(line.startsWith("[Now: ")).toBe(true);
		expect(line.endsWith("]")).toBe(true);
	});

	it("renders the configured zone, not the host's", () => {
		const almaty = clockLine(at, "Asia/Almaty");
		const utc = clockLine(at, "UTC");
		expect(almaty).not.toBe(utc);
	});

	it("falls back to the host zone rather than failing on a bad one", () => {
		// A typo in settings must not take the session down; it surfaces as a
		// settings warning elsewhere.
		expect(() => clockLine(at, "Not/AZone")).not.toThrow();
		expect(clockLine(at, "Not/AZone")).toContain("Now:");
	});

	it("uses the host zone when none is configured", () => {
		expect(clockLine(at, null)).toContain("Now:");
	});
});

describe("alwaysBlock", () => {
	const limits = { alwaysMax: 3, alwaysMaxChars: 1000 };

	it("is empty when the model has written no standing rules", () => {
		expect(alwaysBlock([], limits)).toBe("");
	});

	it("lists the rules under a heading that says whose they are", () => {
		const block = alwaysBlock(["always run biome before committing"], limits);
		expect(block).toMatch(/you wrote for yourself/i);
		expect(block).toContain("- always run biome before committing");
	});

	it("stops at the count ceiling", () => {
		// These bypass retrieval and sit in every prompt of every session.
		// Without a ceiling this slowly becomes the unbounded file the design
		// exists to avoid.
		const block = alwaysBlock(["a", "b", "c", "d", "e"], limits);
		expect(block.split("\n")).toHaveLength(4);
	});

	it("stops at the character ceiling even below the count", () => {
		const block = alwaysBlock(["x".repeat(50), "y".repeat(50)], {
			alwaysMax: 8,
			alwaysMaxChars: 60,
		});
		const rules = block.split("\n").filter((line) => line.startsWith("- "));
		expect(rules).toHaveLength(1);
		expect(rules[0]).toContain("x".repeat(50));
	});
});
