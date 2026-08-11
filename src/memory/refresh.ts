/**
 * When the memory block is recomputed — and, just as importantly, when it is not.
 *
 * `context` fires before every LLM call, and one turn makes as many of those as
 * the tool loop needs. Both extremes are wrong. Recomputing every call rewrites
 * the prompt tail constantly, invalidating the prefix cache and spending an
 * embedder round trip on each step. Recomputing strictly once per turn leaves
 * the model, ten tool calls deep, staring at a block about the sentence the
 * user opened with.
 *
 * So the block is recomputed on **events**, and between them the tail is
 * byte-identical — which is the whole mechanism by which the cache survives.
 * Three events, and no others:
 *
 * - a new user message — the topic was set or changed;
 * - a compaction — the history was cut away, and the memory is what is left;
 * - N tool calls since the last refresh — the model has moved on, so the query
 *   is rebuilt from what it has learned rather than from what was asked.
 *
 * Anything the model needs in between it can ask for directly. Push covers the
 * background; pull covers the specific question.
 */

import type { RefreshSettings } from "../settings/defaults.ts";

export type RefreshReason =
	| "session_start"
	| "user_message"
	| "compact"
	| "tool_budget";

/** Higher wins when two reasons are pending; only one block is ever computed. */
const PRIORITY: Record<RefreshReason, number> = {
	user_message: 3,
	compact: 2,
	session_start: 1,
	tool_budget: 0,
};

export class RefreshPolicy {
	private due: RefreshReason | undefined = "session_start";
	private toolCallsSinceRefresh = 0;
	/**
	 * Consecutive completed runs that ended without the model touching a single
	 * tool.
	 *
	 * A note on what this actually counts. pi's agent loop stops as soon as an
	 * assistant message carries no tool calls, so "several tool-less inferences
	 * in a row" cannot happen *inside* one run — the first one ends it. What it
	 * can happen across is runs: the model answers from guesswork, the user
	 * asks again, it guesses again. That is the same failure the plan aimed at,
	 * observed at the grain pi actually offers.
	 */
	private idleRuns = 0;
	private toolCallsThisRun = 0;

	constructor(private readonly settings: RefreshSettings) {}

	noteUserMessage(): void {
		this.raise("user_message");
	}

	noteCompact(): void {
		if (this.settings.onCompact) this.raise("compact");
	}

	noteToolCall(): void {
		this.toolCallsThisRun += 1;
		this.toolCallsSinceRefresh += 1;
		const budget = this.settings.afterToolCalls;
		if (budget > 0 && this.toolCallsSinceRefresh >= budget)
			this.raise("tool_budget");
	}

	/** @param usedTools whether this run called any tool at all. */
	noteTurnEnd(usedTools: boolean): void {
		const touchedSomething = usedTools || this.toolCallsThisRun > 0;
		this.idleRuns = touchedSomething ? 0 : this.idleRuns + 1;
		this.toolCallsThisRun = 0;
	}

	/** The pending reason, clearing it and restarting the tool budget. */
	takeDue(): RefreshReason | undefined {
		const reason = this.due;
		if (reason !== undefined) {
			this.due = undefined;
			this.toolCallsSinceRefresh = 0;
		}
		return reason;
	}

	/** Whether to add the "you can ask your memory" hint to the tail. */
	askHintDue(): boolean {
		const threshold = this.settings.askHintAfterIdleInferences;
		return threshold > 0 && this.idleRuns >= threshold;
	}

	private raise(reason: RefreshReason): void {
		const current = this.due;
		if (current === undefined || PRIORITY[reason] > PRIORITY[current])
			this.due = reason;
	}
}
