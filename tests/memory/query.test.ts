import { describe, expect, it } from "vitest";
import { progressQuery, recallQuery } from "../../src/memory/query.ts";
import type { Turn } from "../../src/memory/transcript-view.ts";

const user = (text: string): Turn => ({ role: "user", text });
const assistant = (text: string): Turn => ({ role: "assistant", text });
const tool = (text: string): Turn => ({ role: "tool", text });

describe("recallQuery", () => {
	it("asks about the newest user message", () => {
		expect(recallQuery([user("why is the cache off here")], 600)).toBe(
			"why is the cache off here",
		);
	});

	it("uses the unanswered tail, not the whole window", () => {
		// Older turns sit in the transcript verbatim. Spending the recall budget
		// fetching what the model can already read buys nothing.
		const turns = [
			user("set up the linter"),
			assistant("done"),
			user("now the cache"),
			user("specifically the warmup race"),
		];
		expect(recallQuery(turns, 600)).toBe(
			"now the cache\nspecifically the warmup race",
		);
	});

	it("is empty when the last user message was already answered", () => {
		// The caller reads an empty query as "do not spend a recall on this
		// step" — nothing new has been asked.
		expect(recallQuery([user("hi"), assistant("hello")], 600)).toBe("");
	});

	it("is empty for an empty transcript", () => {
		expect(recallQuery([], 600)).toBe("");
	});

	it("keeps the newest text when the tail is longer than the ceiling", () => {
		// Lexical retrieval degrades as a query grows: every extra term is
		// another posting list, and a pasted wall drowns the two or three words
		// that identify the question. The newest end is the identifying one.
		const query = recallQuery([user(`${"x".repeat(700)}END`)], 600);
		expect(query).toHaveLength(600);
		expect(query.endsWith("END")).toBe(true);
	});

	it("ignores empty user messages", () => {
		expect(
			recallQuery([assistant("ok"), user(""), user("the cache")], 600),
		).toBe("the cache");
	});

	it("does not stop at a tool message", () => {
		// A tool result between two user messages does not mean the earlier one
		// was answered — only an assistant message does.
		expect(recallQuery([user("a"), tool("ls output"), user("b")], 600)).toBe(
			"a\nb",
		);
	});
});

describe("progressQuery", () => {
	it("asks about what the model just learned, not the original request", () => {
		// Ten tool calls into a loop, the user's opening line is no longer what
		// the model is working on. This is the query for that moment.
		const turns = [
			user("fix the flaky test"),
			assistant("reading the config"),
			tool("cache: { enabled: false } // see note"),
			assistant("the cache is disabled deliberately?"),
		];
		const query = progressQuery(turns, 600);
		expect(query).toContain("cache is disabled deliberately");
		expect(query).toContain("enabled: false");
		expect(query).not.toContain("fix the flaky test");
	});

	it("is empty when nothing has happened since the user spoke", () => {
		expect(progressQuery([user("fix the test")], 600)).toBe("");
	});

	it("truncates from the front, keeping the newest end", () => {
		const turns = [
			assistant("x".repeat(400)),
			tool("y".repeat(400)),
			assistant("TAIL"),
		];
		const query = progressQuery(turns, 600);
		expect(query).toHaveLength(600);
		expect(query.endsWith("TAIL")).toBe(true);
	});

	it("looks no further back than the recent window", () => {
		const turns: Turn[] = [];
		for (let i = 0; i < 40; i += 1) turns.push(tool(`step-${i}`));
		const query = progressQuery(turns, 10_000);
		expect(query).toContain("step-39");
		expect(query).not.toContain("step-0 ");
	});
});
