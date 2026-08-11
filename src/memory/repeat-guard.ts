/**
 * Stopping a failing call from being sent a third time.
 *
 * The instruction file says not to repeat a call that just failed. The tool
 * result said it too, in the sentence right above the retry. The model did it
 * five times anyway, and there is a reason that is not stupidity: everything it
 * can see is unchanged between attempts. Its own reasoning, the transcript, the
 * block above its reply - identical. From inside, the third attempt looks like
 * the first.
 *
 * Only the runtime can tell them apart, so only the runtime can break the loop.
 * The escalation is deliberate:
 *
 * 1. the first failure explains what to change;
 * 2. the same failure again gets a different sentence, because a repeated one
 *    is indistinguishable from the first and reads as "nothing happened";
 * 3. after that, the answer stops describing the failure at all and states the
 *    only remaining move - which is to leave it alone and tell the user.
 *
 * Keyed by call rather than by tool: forgetting [f4] after failing on [f3] is
 * progress, not a repeat.
 */

export interface RepeatGuardOptions {
	/** Identical failures before the answer changes shape entirely. */
	hardStopAfter?: number;
}

export class RepeatGuard {
	private readonly failures = new Map<string, number>();
	private readonly hardStopAfter: number;

	constructor(options: RepeatGuardOptions = {}) {
		this.hardStopAfter = options.hardStopAfter ?? 2;
	}

	/**
	 * Records a failed call and returns what to say instead, if anything.
	 *
	 * `undefined` means this is the first time and the caller's own message is
	 * the right answer.
	 */
	noteFailure(key: string): string | undefined {
		const seen = (this.failures.get(key) ?? 0) + 1;
		this.failures.set(key, seen);
		if (seen === 1) return undefined;
		if (seen <= this.hardStopAfter) {
			return (
				"This is the second time you have sent this exact call, and it failed the " +
				"same way. Nothing about it will succeed on a third attempt: the arguments " +
				"are identical and so is the memory. Change what you are asking for, or " +
				"move on to the next thing."
			);
		}
		return (
			"Stop. You have sent this identical call several times and it has failed every " +
			"time. Do not send it again in this session. Say plainly to the user what you " +
			"were trying to do and that it did not work, and carry on with the rest of " +
			"their request."
		);
	}

	/** A successful call on the same key clears its history. */
	noteSuccess(key: string): void {
		this.failures.delete(key);
	}

	/** New user input starts a new run: the situation may genuinely differ. */
	reset(): void {
		this.failures.clear();
	}
}
