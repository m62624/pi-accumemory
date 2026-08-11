import { describe, expect, it } from "vitest";
import { createIdleTrigger } from "../../src/session/idle-trigger.ts";

/** A timer the test fires by hand, so nothing here waits. */
function manualTimers() {
	let pending: (() => void) | undefined;
	let lastDelay: number | undefined;
	return {
		setTimer: (fn: () => void, ms: number) => {
			pending = fn;
			lastDelay = ms;
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
		delay: () => lastDelay,
	};
}

describe("createIdleTrigger", () => {
	it("runs the pass once the quiet period elapses", async () => {
		const timers = manualTimers();
		let ran = 0;
		const trigger = createIdleTrigger({
			quietMs: () => 1000,
			run: async () => {
				ran += 1;
			},
			...timers,
		});
		trigger.schedule();
		expect(ran).toBe(0);
		timers.fire();
		await Promise.resolve();
		expect(ran).toBe(1);
	});

	it("never schedules anything when the quiet period is zero", () => {
		// That is how consolidation is switched off without a second flag.
		const timers = manualTimers();
		const trigger = createIdleTrigger({
			quietMs: () => 0,
			run: async () => {},
			...timers,
		});
		trigger.schedule();
		expect(timers.pending()).toBe(false);
	});

	it("reads the delay at schedule time", () => {
		const timers = manualTimers();
		let quiet = 1000;
		const trigger = createIdleTrigger({
			quietMs: () => quiet,
			run: async () => {},
			...timers,
		});
		trigger.schedule();
		expect(timers.delay()).toBe(1000);
		quiet = 50;
		trigger.schedule();
		expect(timers.delay()).toBe(50);
	});

	it("restarts the countdown rather than stacking timers", () => {
		const timers = manualTimers();
		let ran = 0;
		const trigger = createIdleTrigger({
			quietMs: () => 1000,
			run: async () => {
				ran += 1;
			},
			...timers,
		});
		trigger.schedule();
		trigger.schedule();
		timers.fire();
		expect(ran).toBe(1);
	});

	it("cancels a countdown the user interrupted", () => {
		const timers = manualTimers();
		const trigger = createIdleTrigger({
			quietMs: () => 1000,
			run: async () => {},
			...timers,
		});
		trigger.schedule();
		trigger.interrupt();
		expect(timers.pending()).toBe(false);
	});

	it("aborts a pass already running when the user types", async () => {
		// The user's turn is what the session is for. Everything the pass had
		// decided by then is already on disk.
		const timers = manualTimers();
		let aborted = false;
		let release = () => {};
		const trigger = createIdleTrigger({
			quietMs: () => 1000,
			run: (signal) => {
				signal.addEventListener("abort", () => {
					aborted = true;
				});
				return new Promise<void>((resolve) => {
					release = resolve;
				});
			},
			...timers,
		});
		trigger.schedule();
		timers.fire();
		expect(trigger.running()).toBe(true);
		trigger.interrupt();
		expect(aborted).toBe(true);
		release();
	});

	it("does not start a second pass while one is running", async () => {
		const timers = manualTimers();
		let started = 0;
		let release = () => {};
		const trigger = createIdleTrigger({
			quietMs: () => 1000,
			run: () => {
				started += 1;
				return new Promise<void>((resolve) => {
					release = resolve;
				});
			},
			...timers,
		});
		trigger.schedule();
		timers.fire();
		trigger.schedule();
		timers.fire();
		expect(started).toBe(1);
		release();
	});

	it("is idle again once the pass finishes", async () => {
		const timers = manualTimers();
		const trigger = createIdleTrigger({
			quietMs: () => 1000,
			run: async () => {},
			...timers,
		});
		trigger.schedule();
		timers.fire();
		await Promise.resolve();
		await Promise.resolve();
		expect(trigger.running()).toBe(false);
	});
});
