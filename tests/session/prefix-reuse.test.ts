/**
 * What this extension costs a serving backend, measured rather than argued.
 *
 * The design rests on one claim: putting everything dynamic BELOW the
 * transcript, and recomputing it only on events, keeps the prompt prefix
 * stable. This is where that claim is checked - the same bench that caught
 * pi-telegram-manager re-reading 19,397 characters per newly learned fact,
 * because its memory block sat one line too high.
 *
 * Assertions are in CHARACTERS, not percentages. A prompt whose constant part
 * is 24 KB of rules scores 96% reuse no matter what happens to the other
 * kilobyte, and 96% of nothing is still nothing. The number that costs seconds
 * is `reread`.
 */

import { describe, expect, it } from "vitest";
import { RefreshPolicy } from "../../src/memory/refresh.ts";
import { buildTail } from "../../src/session/tail.ts";
import {
	PrefixCache,
	type PromptMessage,
	serializePrompt,
} from "../helpers/prefix-cache.ts";

const SYSTEM_PROMPT = `You are a coding agent.\n${"Guideline line that is part of every prompt.\n".repeat(200)}`;

function prompt(
	history: readonly PromptMessage[],
	tail: string,
): PromptMessage[] {
	const messages: PromptMessage[] = [
		{ role: "system", content: SYSTEM_PROMPT },
		...history,
	];
	if (tail !== "") messages.push({ role: "user", content: tail });
	return messages;
}

function tailFor(block: string): string {
	return buildTail({
		clock: "[Now: Tuesday, 11 August 2026 at 17:30 (UTC)]",
		block,
	});
}

describe("prompt prefix reuse", () => {
	it("charges only the tail when the memory block changes", () => {
		// The core claim. The block changes on every refresh by construction, so
		// what it costs must be bounded by its own size and not by the length of
		// the conversation above it.
		const cache = new PrefixCache();
		const history: PromptMessage[] = [
			{ role: "user", content: "fix the flaky test" },
			{ role: "assistant", content: "reading the config" },
		];
		cache.serve(
			serializePrompt(
				prompt(history, tailFor("- [f1] cache off: warmup race")),
			),
		);
		const second = cache.serve(
			serializePrompt(
				prompt(history, tailFor("- [f2] tests run under vitest")),
			),
		);
		expect(second.reread).toBeLessThan(200);
	});

	it("would charge the whole conversation if the block sat above it", () => {
		// The counter-example, kept because it is the reason for the rule. Same
		// two blocks, placed before the transcript instead of after it.
		const cache = new PrefixCache();
		const history: PromptMessage[] = [
			{ role: "user", content: "x".repeat(8000) },
			{ role: "assistant", content: "y".repeat(8000) },
		];
		const above = (block: string): PromptMessage[] => [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: block },
			...history,
		];
		cache.serve(serializePrompt(above("- [f1] cache off: warmup race")));
		const second = cache.serve(
			serializePrompt(above("- [f2] tests run under vitest")),
		);
		expect(second.reread).toBeGreaterThan(16_000);
	});

	it("costs nothing at all on the steps between refresh events", () => {
		// This is what the event-based refresh policy buys: inside a tool loop
		// the tail is byte-identical, so the backend re-reads zero.
		const cache = new PrefixCache();
		const policy = new RefreshPolicy({
			afterToolCalls: 10,
			onCompact: true,
			askHintAfterIdleInferences: 2,
		});
		policy.takeDue();

		let block = "- [f1] cache off: warmup race";
		const history: PromptMessage[] = [
			{ role: "user", content: "fix the flaky test" },
		];
		cache.serve(serializePrompt(prompt(history, tailFor(block))));

		const rereads: number[] = [];
		for (let step = 0; step < 9; step += 1) {
			policy.noteToolCall();
			history.push({ role: "tool", content: `result ${step}` });
			// The policy is not due, so the block is not recomputed - and the
			// tail below the new tool result is the same bytes as before.
			if (policy.takeDue() !== undefined) block = `- [f${step}] something new`;
			rereads.push(
				cache.serve(serializePrompt(prompt(history, tailFor(block)))).reread,
			);
		}
		// Each step re-reads only its own new tool result plus the tail beneath
		// it, never the conversation above.
		expect(Math.max(...rereads)).toBeLessThan(200);
	});

	it("adds nothing when the memory is empty", () => {
		// No facts, no block - and with no clock either, an empty tail is
		// literally zero added bytes.
		const withoutTail = serializePrompt(
			prompt([{ role: "user", content: "hi" }], ""),
		);
		expect(buildTail({})).toBe("");
		expect(withoutTail.includes("Now:")).toBe(false);
	});

	it("keeps the clock inside the tail, not in a message of its own", () => {
		// A separate clock message is new bytes at a message boundary on every
		// tick, and a model reads it as somebody speaking.
		const tail = tailFor("- [f1] a fact");
		const messages = prompt([{ role: "user", content: "hi" }], tail);
		expect(
			messages.filter((message) => String(message.content).includes("Now:")),
		).toHaveLength(1);
		expect(messages.at(-1)?.content).toContain("- [f1] a fact");
	});
});
