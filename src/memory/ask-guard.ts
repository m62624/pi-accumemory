/**
 * Anti-sticking for the ask-your-memory tool.
 *
 * Lighter than the consolidation pass's ledger, but needed for the same reason:
 * a model that did not get the answer it wanted asks the same question again in
 * slightly different words, and nothing in its own context tells it that it
 * already did. Only the runtime can see the repeat.
 *
 * Two guards, because there are two ways to get stuck. Asking the *same*
 * question twice returns the same answer, so it is worth saying so. Asking
 * several *different* questions with nothing done in between is inspection
 * replacing work, and worth interrupting.
 */

export interface AskGuardOptions {
	/** Consecutive asks with no other activity before the nudge appears. */
	maxConsecutive?: number;
}

export class AskGuard {
	private readonly asked = new Set<string>();
	private consecutive = 0;
	private readonly maxConsecutive: number;

	constructor(options: AskGuardOptions = {}) {
		this.maxConsecutive = options.maxConsecutive ?? 3;
	}

	/** A note to append to the answer when this question is a repeat. */
	check(question: string): string | undefined {
		if (!this.asked.has(normalise(question))) return undefined;
		return (
			"You already asked this in this run and the memory has not changed since, so " +
			"the answer is the same. Rephrasing it will not produce a different one - act " +
			"on what you have, or look somewhere other than memory."
		);
	}

	record(question: string): void {
		this.asked.add(normalise(question));
		this.consecutive += 1;
	}

	/** The model did something other than ask: it is making progress. */
	noteOtherActivity(): void {
		this.consecutive = 0;
	}

	/** New user input starts a new run; the same question may be fair again. */
	reset(): void {
		this.asked.clear();
		this.consecutive = 0;
	}

	stuck(): boolean {
		return this.consecutive >= this.maxConsecutive;
	}

	static stuckText(): string {
		return (
			"That is several memory lookups in a row with nothing else done between them. " +
			"Decide with what you have, or find the answer in the code instead - the " +
			"memory holds what was written down, not everything that is true."
		);
	}
}

function normalise(question: string): string {
	return question.toLowerCase().replace(/\s+/gu, " ").trim();
}
