/**
 * The review job's two pure pieces: what it shows, and where it stops.
 *
 * The cursor arithmetic is the part with a bug in it waiting to happen, and one
 * did: an exclusive `> from` starting at zero skips [f0] for the life of the
 * memory, because there is no id below zero to mean "nothing shown yet".
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	nextCursor,
	type ReviewWindow,
	reviewPrompt,
} from "../../src/consolidation/review.ts";
import { ReviewCursorStore } from "../../src/consolidation/review-cursor.ts";
import { FakeFs } from "../helpers/fake-fs.ts";

const window = (ids: number[]): ReviewWindow => ({
	scope: "project",
	label: "this project (app)",
	facts: ids.map((id) => ({ id, text: `fact ${id}`, tags: ["decision"] })),
});

describe("reviewPrompt", () => {
	it("says these are not search results and nobody asked", () => {
		// Otherwise it reads like a recall, and a model that thinks the user
		// raised the subject starts answering about it.
		const prompt = reviewPrompt({
			instructions: "the rules",
			clock: "[Now: X]",
			windows: [window([0, 1])],
			held: 2,
		});
		expect(prompt).toMatch(/not search results/i);
		expect(prompt).toMatch(/nobody is waiting for a reply/i);
	});

	it("uses the same specialist boundary as transcript consolidation", () => {
		const prompt = reviewPrompt({
			instructions: "the rules",
			clock: "[Now: X]",
			windows: [window([0])],
			held: 1,
		});
		expect(prompt).toContain("pi-accumemory's memory-consolidation specialist");
		expect(prompt).toMatch(/do not have access to .*ordinary Pi tools/i);
	});

	it("labels each window with the scope its ids belong to", () => {
		const prompt = reviewPrompt({
			instructions: "",
			clock: "[Now: X]",
			windows: [
				window([0]),
				{
					scope: "user",
					label: "your memory about the user",
					facts: [{ id: 3, text: "prefers Rust", tags: [] }],
				},
			],
			held: 2,
		});
		expect(prompt).toContain('the ids below are scope: "project"');
		expect(prompt).toContain('the ids below are scope: "user"');
		expect(prompt).toContain("- [f3] prefers Rust");
	});

	it("says that leaving a fact alone is the expected answer", () => {
		// Without this the phase becomes a machine for deleting things, because
		// acting looks like working and doing nothing looks like failing.
		const prompt = reviewPrompt({
			instructions: "",
			clock: "[Now: X]",
			windows: [window([0])],
			held: 1,
		});
		expect(prompt).toMatch(/most will be fine and need nothing/i);
	});
});

describe("nextCursor", () => {
	it("stops one past the highest id, so the window can be inclusive", () => {
		// With an exclusive cursor starting at zero, [f0] is never reviewed.
		expect(nextCursor([window([0, 1, 2])])).toBe(3);
	});

	it("takes the highest across every window", () => {
		expect(nextCursor([window([0, 1]), window([7])])).toBe(8);
	});

	it("wraps to the beginning when the walk found nothing", () => {
		expect(nextCursor([])).toBe(0);
		expect(nextCursor([window([])])).toBe(0);
	});
});

describe("ReviewCursorStore", () => {
	const store = (fs: FakeFs) =>
		new ReviewCursorStore(fs, "/state/review.json", path.posix);

	it("starts at the beginning when it has never been written", async () => {
		expect(await store(new FakeFs()).get("p1")).toBe(0);
	});

	it("remembers where each key stopped", async () => {
		const fs = new FakeFs();
		await store(fs).set("p1", 12);
		await store(fs).set("p2", 3);
		expect(await store(fs).get("p1")).toBe(12);
		expect(await store(fs).get("p2")).toBe(3);
	});

	it("starts over rather than failing on a corrupt file", async () => {
		// Losing this costs one pass looking at facts it has seen; refusing to
		// work because a throwaway JSON file is broken costs the whole pass.
		const fs = new FakeFs();
		await fs.writeFile("/state/review.json", "{not json");
		expect(await store(fs).get("p1")).toBe(0);
	});

	it("treats a nonsensical value as the beginning", async () => {
		const fs = new FakeFs();
		await fs.writeFile("/state/review.json", '{"p1": -4, "p2": "x"}');
		expect(await store(fs).get("p1")).toBe(0);
		expect(await store(fs).get("p2")).toBe(0);
	});

	it("swallows a write it cannot make", async () => {
		const fs = new FakeFs();
		fs.failWrites = new Error("read-only filesystem");
		await expect(store(fs).set("p1", 5)).resolves.toBeUndefined();
	});
});
