/**
 * "The session has gone quiet" - the only thing that starts a consolidation
 * pass.
 *
 * It is a boundary, not a budget. The point is not that thirty minutes of work
 * have accumulated; it is that the work has stopped, so a background pass can
 * have the machine without competing with anybody. Which is also why the pass
 * yields the instant the user types: their turn is what the session is for.
 *
 * Timers are injected so this is testable without waiting.
 */

export interface IdleTriggerOptions {
	/** Read at schedule time; `0` disables the trigger entirely. */
	quietMs(): number;
	run(signal: AbortSignal): Promise<void>;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export interface IdleTrigger {
	/** Start (or restart) the quiet countdown. */
	schedule(): void;
	/** The user is active: cancel the countdown and abort a running pass. */
	interrupt(): void;
	/** Tear everything down. */
	cancel(): void;
	/** Whether a pass is running right now. */
	running(): boolean;
}

export function createIdleTrigger(options: IdleTriggerOptions): IdleTrigger {
	const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer =
		options.clearTimer ?? ((handle) => clearTimeout(handle as never));

	let timer: unknown;
	let controller: AbortController | undefined;

	const stopTimer = () => {
		if (timer !== undefined) clearTimer(timer);
		timer = undefined;
	};

	return {
		schedule(): void {
			stopTimer();
			const quietMs = options.quietMs();
			if (quietMs <= 0) return;
			timer = setTimer(() => {
				timer = undefined;
				// A pass already running is not restarted; it is still the same
				// silence.
				if (controller !== undefined) return;
				const running = new AbortController();
				controller = running;
				void options.run(running.signal).finally(() => {
					if (controller === running) controller = undefined;
				});
			}, quietMs);
		},

		interrupt(): void {
			stopTimer();
			controller?.abort();
			controller = undefined;
		},

		cancel(): void {
			stopTimer();
			controller?.abort();
			controller = undefined;
		},

		running(): boolean {
			return controller !== undefined;
		},
	};
}
