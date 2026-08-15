import { describe, expect, it } from "vitest";
import { createBackgroundProgress } from "../../src/ui/background-progress.ts";

function fakeUi() {
	const events: string[] = [];
	return {
		events,
		notify: (message: string, type = "info") =>
			events.push(`notify:${type}:${message}`),
		setStatus: (key: string, text: string | undefined) =>
			events.push(`status:${key}:${text ?? "clear"}`),
		setWidget: (
			key: string,
			content: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		) =>
			events.push(
				`widget:${key}:${content?.join("|") ?? "clear"}:${options?.placement ?? "default"}`,
			),
	};
}

describe("createBackgroundProgress", () => {
	it("shows an English notification and an animated widget", () => {
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
		expect(ui.events).toContain("notify:info:Memory consolidation started.");
		expect(ui.events).toContain(
			"widget:longterm-memory:Memory consolidation  (background):belowEditor",
		);

		const beforeTick = ui.events.length;
		tick?.();
		expect(ui.events.length).toBeGreaterThan(beforeTick);
		expect(ui.events.join("\n")).toContain("Memory consolidation ⠙");

		run.end("completed");
		expect(ui.events.at(-1)).toBe("notify:info:Memory consolidation finished.");
	});

	it("keeps the widget static while the status spinner animates", () => {
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
		const widgetUpdates = () =>
			ui.events.filter((event) => event.startsWith("widget:")).length;
		const beforeTicks = widgetUpdates();
		tick?.();
		tick?.();
		expect(widgetUpdates()).toBe(beforeTicks);
		expect(ui.events.join("\n")).toContain("Memory review ⠙");
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
});
