/**
 * A recurring background trigger that can be interrupted by user activity.
 *
 * Unlike the idle trigger, this one is not armed by an agent response. It is
 * for maintenance that must happen even when nobody sends another message -
 * such as reviewing old memory facts. The timer is one-shot internally and is
 * re-armed only after the previous attempt settles, so two maintenance passes
 * cannot overlap through this trigger.
 */

export interface PeriodicTriggerOptions {
	/** Read when the next interval is armed; `0` disables the trigger. */
	intervalMs(): number;
	run(signal: AbortSignal): Promise<void>;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export interface PeriodicTrigger {
	/** Begin the recurring schedule, replacing any pending timer. */
	start(): void;
	/** Abort a running pass; a pending interval remains intact. */
	interrupt(): void;
	/** Stop the schedule and abort a running pass. */
	cancel(): void;
	/** Whether a pass is running right now. */
	running(): boolean;
}

export function createPeriodicTrigger(
	options: PeriodicTriggerOptions,
): PeriodicTrigger {
	const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer =
		options.clearTimer ?? ((handle) => clearTimeout(handle as never));

	let timer: unknown;
	let controller: AbortController | undefined;
	let active = false;

	const stopTimer = () => {
		if (timer !== undefined) clearTimer(timer);
		timer = undefined;
	};

	const arm = () => {
		stopTimer();
		const intervalMs = options.intervalMs();
		if (!active || intervalMs <= 0) return;
		timer = setTimer(() => {
			timer = undefined;
			if (!active || controller !== undefined) return;
			const running = new AbortController();
			controller = running;
			void options
				.run(running.signal)
				.catch(() => {})
				.finally(() => {
					if (controller !== running) return;
					controller = undefined;
					arm();
				});
		}, intervalMs);
	};

	return {
		start(): void {
			active = true;
			arm();
		},

		interrupt(): void {
			controller?.abort();
		},

		cancel(): void {
			active = false;
			stopTimer();
			controller?.abort();
			controller = undefined;
		},

		running(): boolean {
			return controller !== undefined;
		},
	};
}
