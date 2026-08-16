import { describe, expect, it } from "vitest";
import {
	createBackgroundProgress,
	runInspectorWhenAvailable,
} from "../../src/ui/background-progress.ts";

function fakeUi() {
	const events: string[] = [];
	return {
		events,
		notify: (message: string, type = "info") =>
			events.push(`notify:${type}:${message}`),
		setStatus: (key: string, text: string | undefined) =>
			events.push(`status:${key}:${text ?? "clear"}`),
	};
}

describe("createBackgroundProgress", () => {
	it("shows an English notification and an animated status", () => {
		const ui = fakeUi();
		let tick: (() => void) | undefined;
		const progress = createBackgroundProgress({
			ui: () => ui,
			intervalMs: 1000,
			setTimer: (fn) => {
				tick = fn;
				return 1;
			},
			clearTimer: () => {},
		});

		const run = progress.begin("consolidation");
		expect(progress.activeJob()).toBe("consolidation");
		expect(ui.events).toContain("notify:info:Memory consolidation started.");
		expect(ui.events).toContain(
			"status:longterm-memory:Memory consolidation ⠋",
		);

		const beforeTick = ui.events.length;
		tick?.();
		expect(ui.events.length).toBeGreaterThan(beforeTick);
		expect(ui.events.join("\n")).toContain("Memory consolidation ⠙");

		run.end("completed");
		expect(progress.activeJob()).toBeUndefined();
		expect(ui.events.at(-1)).toBe("notify:info:Memory consolidation finished.");
	});

	it("does not add a second in-editor surface", () => {
		const ui = fakeUi();
		let tick: (() => void) | undefined;
		const progress = createBackgroundProgress({
			ui: () => ui,
			setTimer: (fn) => {
				tick = fn;
				return 1;
			},
			clearTimer: () => {},
		});

		const run = progress.begin("review");
		expect(progress.activeJob()).toBe("review");
		const statusUpdates = () =>
			ui.events.filter((event) => event.startsWith("status:")).length;
		const beforeTicks = statusUpdates();
		tick?.();
		tick?.();
		expect(statusUpdates()).toBeGreaterThan(beforeTicks);
		expect(ui.events.join("\n")).toContain("Memory review ⠙");
		expect(ui.events.some((event) => event.startsWith("widget:"))).toBe(false);
		run.cancel();
	});

	it("reports interruption without persisting a transcript entry", () => {
		const ui = fakeUi();
		const progress = createBackgroundProgress({ ui: () => ui });
		progress.begin("review");
		progress.interrupt();
		expect(ui.events).toContain(
			"notify:warning:Memory review interrupted. Changes already saved remain.",
		);
	});

	it("reports every terminal result", () => {
		const ui = fakeUi();
		const progress = createBackgroundProgress({
			ui: () => ui,
			setTimer: () => 1,
			clearTimer: () => {},
		});

		progress.begin("consolidation").end("nothing");
		progress.begin("consolidation").end("interrupted");
		progress.begin("consolidation").end("failed");

		expect(ui.events).toContain(
			"notify:info:Memory consolidation finished — nothing to change.",
		);
		expect(ui.events).toContain(
			"notify:warning:Memory consolidation interrupted. Changes already saved remain.",
		);
		expect(ui.events).toContain(
			"notify:error:Memory consolidation failed. The next run will retry.",
		);
	});

	it("blocks the inspector during consolidation and review", async () => {
		const notices: string[] = [];
		let ran = false;
		const task = () => {
			ran = true;
			return Promise.resolve("opened");
		};
		await expect(
			runInspectorWhenAvailable(
				"consolidation",
				(message) => notices.push(message),
				task,
			),
		).resolves.toBeUndefined();
		expect(ran).toBe(false);
		expect(notices[0]).toMatch(/consolidation is running/i);
		await expect(
			runInspectorWhenAvailable(
				"review",
				(message) => notices.push(message),
				task,
			),
		).resolves.toBeUndefined();
		expect(ran).toBe(false);
		expect(notices[1]).toMatch(/review is running/i);
		await expect(
			runInspectorWhenAvailable(undefined, () => {}, task),
		).resolves.toBe("opened");
		expect(ran).toBe(true);
	});

	it("ignores an older run after a newer run starts", () => {
		const ui = fakeUi();
		const progress = createBackgroundProgress({
			ui: () => ui,
			setTimer: () => 1,
			clearTimer: () => {},
		});

		const oldRun = progress.begin("consolidation");
		const newRun = progress.begin("review");
		const before = [...ui.events];
		oldRun.end("completed");

		expect(ui.events).toEqual(before);
		newRun.cancel();
	});
});
