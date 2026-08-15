import { describe, expect, it } from "vitest";
import { createPeriodicTrigger } from "../../src/session/periodic-trigger.ts";

function manualTimers() {
	let pending: (() => void) | undefined;
	let delay: number | undefined;
	return {
		setTimer: (fn: () => void, ms: number) => {
			pending = fn;
			delay = ms;
			return 1;
		},
		clearTimer: () => {
			pending = undefined;
		},
		fire: () => {
			const fn = pending;
			pending = undefined;
			fn?.();
		},
		pending: () => pending !== undefined,
		delay: () => delay,
	};
}

describe("createPeriodicTrigger", () => {
	it("runs and re-arms after every interval", async () => {
		const timers = manualTimers();
		let runs = 0;
		const trigger = createPeriodicTrigger({
			intervalMs: () => 1_800_000,
			run: async () => {
				runs += 1;
			},
			...timers,
		});

		trigger.start();
		expect(timers.delay()).toBe(1_800_000);
		timers.fire();
		await Promise.resolve();
		await Promise.resolve();
		expect(runs).toBe(1);
		expect(timers.pending()).toBe(true);

		timers.fire();
		await Promise.resolve();
		expect(runs).toBe(2);
	});

	it("does not schedule when the interval is zero", () => {
		const timers = manualTimers();
		const trigger = createPeriodicTrigger({
			intervalMs: () => 0,
			run: async () => {},
			...timers,
		});
		trigger.start();
		expect(timers.pending()).toBe(false);
	});

	it("re-arms after a running pass is interrupted", async () => {
		const timers = manualTimers();
		let aborted = false;
		let release = () => {};
		const trigger = createPeriodicTrigger({
			intervalMs: () => 1000,
			run: (signal) =>
				new Promise<void>((resolve) => {
					release = resolve;
					signal.addEventListener("abort", () => {
						aborted = true;
					});
				}),
			...timers,
		});

		trigger.start();
		timers.fire();
		trigger.interrupt();
		expect(aborted).toBe(true);
		release();
		await Promise.resolve();
		await Promise.resolve();
		expect(timers.pending()).toBe(true);
	});

	it("cancels both the pending timer and a running pass", async () => {
		const timers = manualTimers();
		let aborted = false;
		const trigger = createPeriodicTrigger({
			intervalMs: () => 1000,
			run: (signal) =>
				new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => {
						aborted = true;
						resolve();
					});
				}),
			...timers,
		});

		trigger.start();
		timers.fire();
		trigger.cancel();
		await Promise.resolve();
		expect(aborted).toBe(true);
		expect(timers.pending()).toBe(false);
	});
});
