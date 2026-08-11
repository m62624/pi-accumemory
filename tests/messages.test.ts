import { describe, expect, it } from "vitest";
import { messageToTurn, toTurns } from "../src/messages.ts";

describe("messageToTurn", () => {
	it("reads a plain-string user message", () => {
		expect(messageToTurn({ role: "user", content: "hello" })).toEqual({
			role: "user",
			text: "hello",
		});
	});

	it("joins the text blocks of a structured user message", () => {
		const turn = messageToTurn({
			role: "user",
			content: [
				{ type: "text", text: "first" },
				{ type: "image", data: "..." },
				{ type: "text", text: "second" },
			],
		});
		expect(turn).toEqual({ role: "user", text: "first\nsecond" });
	});

	it("keeps assistant text but drops its thinking", () => {
		// Thinking is the model talking to itself; feeding it back as the
		// recall query asks the memory about its own uncertainty.
		const turn = messageToTurn({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "the cache is off" },
			],
		});
		expect(turn?.text).toBe("the cache is off");
	});

	it("summarises a tool call rather than dumping its arguments", () => {
		// Arguments are frequently a whole file. As query text they drown
		// everything else in the window.
		const turn = messageToTurn({
			role: "assistant",
			content: [
				{ type: "toolCall", name: "read", arguments: { path: "/a/b.ts" } },
			],
		});
		expect(turn?.text).toContain("read");
		expect(turn?.text).not.toContain("/a/b.ts");
	});

	it("maps a tool result to the tool role", () => {
		const turn = messageToTurn({
			role: "toolResult",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
		});
		expect(turn).toEqual({ role: "tool", text: "file body" });
	});

	it("ignores a message with no role it knows", () => {
		expect(messageToTurn({ role: "custom", content: "x" })).toBeUndefined();
		expect(messageToTurn(null)).toBeUndefined();
		expect(messageToTurn("nope")).toBeUndefined();
	});

	it("survives content that is not the shape it expects", () => {
		// This parses session files written by other versions of pi. Throwing
		// on an unfamiliar block would take the whole consolidation pass down.
		expect(messageToTurn({ role: "user", content: 42 })).toEqual({
			role: "user",
			text: "",
		});
		expect(messageToTurn({ role: "user", content: [null, 7] })).toEqual({
			role: "user",
			text: "",
		});
	});
});

describe("toTurns", () => {
	it("keeps order and skips what it cannot read", () => {
		const turns = toTurns([
			{ role: "user", content: "a" },
			{ role: "nonsense" },
			{ role: "assistant", content: [{ type: "text", text: "b" }] },
		]);
		expect(turns).toEqual([
			{ role: "user", text: "a" },
			{ role: "assistant", text: "b" },
		]);
	});
});
