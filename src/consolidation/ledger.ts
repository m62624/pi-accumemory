/**
 * Bookkeeping that keeps a consolidation pass from spinning.
 *
 * The pass is an agent loop with no user in it, and that is exactly what makes
 * it prone to sticking. Its context is rebuilt the same way on every step, so a
 * model that just made a call and learned nothing sees precisely the same
 * situation again and has every reason to make the same call. Nothing inside
 * the conversation can reveal the repetition - only the runtime, which counts.
 *
 * So each step gets a directive, chosen by a priority ladder. Exactly one is
 * sent, because two pieces of advice at once are advice the model averages.
 */

import type { ConsolidationSettings } from "../settings/defaults.ts";

export type DirectiveKind = "continue" | "nudge" | "finish" | "abandon";

export interface Directive {
	kind: DirectiveKind;
	text: string;
}

/** Tool names that change the memory, as opposed to inspecting it. */
const WRITE_TOOLS = new Set([
	"longterm_remember",
	"longterm_revise",
	"longterm_forget",
	"longterm_forget_many",
]);

/** Consecutive inspections with no write before the pass is told to decide. */
const MAX_LOOKS_WITHOUT_WRITE = 3;

export class ConsolidationLedger {
	private steps = 0;
	private writes = 0;
	private nudges = 0;
	private looksWithoutWrite = 0;
	private lastCall: string | undefined;
	private repeated = false;
	private done = false;
	private readonly journal: string[] = [];

	constructor(private readonly settings: ConsolidationSettings) {}

	noteToolCall(name: string, argsKey: string): void {
		this.steps += 1;
		const signature = `${name}:${argsKey}`;
		this.repeated = signature === this.lastCall;
		this.lastCall = signature;
		this.journal.push(name);
		// A write resets the patience counter; an inspection spends it.
		this.looksWithoutWrite = WRITE_TOOLS.has(name)
			? 0
			: this.looksWithoutWrite + 1;
		// A nudge is answered by doing something, so the count starts over.
		this.nudges = 0;
	}

	noteWrite(): void {
		this.writes += 1;
		this.looksWithoutWrite = 0;
	}

	/** The pass produced a message and called nothing. */
	noteIdleTurn(): void {
		this.nudges += 1;
	}

	noteDone(): void {
		this.done = true;
	}

	finished(): boolean {
		return this.done;
	}

	/** What to tell the pass next. Highest applicable rung wins. */
	directive(): Directive {
		if (this.steps >= this.settings.maxSteps) {
			this.done = true;
			return {
				kind: "finish",
				text:
					"You have used this pass's step budget. Finish now with longterm_done - " +
					"whatever is left will be picked up by the next pass, which resumes from " +
					"the same place in the transcript. Nothing is lost by stopping here.",
			};
		}
		if (this.nudges >= this.settings.maxNudges) {
			this.done = true;
			return {
				kind: "abandon",
				text: "This pass produced no actions and is being ended.",
			};
		}
		if (this.nudges > 0) {
			return {
				kind: "nudge",
				text:
					"That turn called nothing. This pass is not a conversation - describing " +
					"what you would change does not change it. " +
					`${this.summary()} Either make the next call, or end the pass with ` +
					"longterm_done.",
			};
		}
		if (this.repeated) {
			return {
				kind: "continue",
				text:
					"That was the same call as the step before, and the memory has not " +
					"changed in between, so the answer is the same. Do something else, or " +
					"finish with longterm_done.",
			};
		}
		if (this.looksWithoutWrite >= MAX_LOOKS_WITHOUT_WRITE) {
			return {
				kind: "continue",
				text:
					"That is several lookups in a row with nothing written. The inspection " +
					"phase is over: decide what to store, revise or forget, or finish with " +
					"longterm_done.",
			};
		}
		return {
			kind: "continue",
			text:
				"Finish with longterm_done whenever this pass has nothing more worth doing. " +
				"Until then: store what the transcript shows and the memory lacks " +
				"(longterm_remember), collapse repeated dated facts into one undated " +
				"pattern (longterm_revise, then longterm_forget_many the old ones), and " +
				"drop what has expired (longterm_forget). One statement per fact.",
		};
	}

	/** A short account of what this pass has done, for the nudge and the log. */
	summary(): string {
		if (this.journal.length === 0) return "So far this pass has done nothing.";
		const calls = this.journal.join(", ");
		return `So far this pass made ${this.journal.length} calls (${calls}) and ${this.writes} memory writes.`;
	}
}
