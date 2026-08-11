import { describe, expect, it } from "vitest";
import { hasToolCalls } from "../src/messages.ts";

describe("hasToolCalls", () => {
	it("sees a tool call in an assistant message", () => {
		// This is what separates "the model did some work" from "the model
		// answered from what it already believed" - and the second is the case
		// the ask-hint exists for.
		expect(
			hasToolCalls({
				role: "assistant",
				content: [{ type: "toolCall", name: "read", arguments: {} }],
			}),
		).toBe(true);
	});

	it("sees none in an assistant message that only spoke", () => {
		expect(
			hasToolCalls({
				role: "assistant",
				content: [{ type: "text", text: "here you go" }],
			}),
		).toBe(false);
	});

	it("ignores messages that are not from the assistant", () => {
		expect(hasToolCalls({ role: "user", content: "hi" })).toBe(false);
		expect(hasToolCalls({ role: "toolResult", content: [] })).toBe(false);
	});

	it("survives a shape it does not recognise", () => {
		// These also come out of session files written by other versions of pi.
		expect(hasToolCalls(null)).toBe(false);
		expect(hasToolCalls("nope")).toBe(false);
		expect(hasToolCalls({ role: "assistant", content: "a plain string" })).toBe(
			false,
		);
		expect(hasToolCalls({ role: "assistant", content: [null, 7] })).toBe(false);
		expect(hasToolCalls({ role: "assistant" })).toBe(false);
	});
});
