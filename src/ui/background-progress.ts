/**
 * User-facing progress for the otherwise in-memory memory agents.
 *
 * The agent conversation stays private and ephemeral; this is only a small
 * status line, an animated widget, and lifecycle notifications. Keeping this
 * separate from the pass itself means the memory runner remains usable in
 * tests and in non-interactive callers.
 */

export type BackgroundJob = "consolidation" | "review";
export type BackgroundResult =
	| "completed"
	| "nothing"
	| "interrupted"
	| "failed";

export interface BackgroundProgressUi {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(
		key: string,
		content: string[] | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

export interface BackgroundProgressOptions {
	ui(): BackgroundProgressUi | undefined;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	intervalMs?: number;
}

export interface BackgroundRun {
	end(result: BackgroundResult): void;
	/** Clear the display without adding an interruption notification. */
	cancel(): void;
}

const STATUS_KEY = "longterm-memory";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const LABELS: Record<BackgroundJob, string> = {
	consolidation: "Memory consolidation",
	review: "Memory review",
};

export function createBackgroundProgress(options: BackgroundProgressOptions): {
	begin(job: BackgroundJob): BackgroundRun;
	interrupt(): void;
	cancel(): void;
} {
	const setTimer = options.setTimer ?? ((fn, ms) => setInterval(fn, ms));
	const clearTimer =
		options.clearTimer ?? ((handle) => clearInterval(handle as never));
	// Pi rebuilds a widget on every setWidget call. One update per second keeps
	// the spinner alive without turning a small indicator into a screen-wide
	// repaint loop.
	const intervalMs = options.intervalMs ?? 1_000;
	let timer: unknown;
	let active: { id: number; job: BackgroundJob; frame: number } | undefined;
	let nextId = 0;
	let renderedLine: string | undefined;
	let renderedWidget: string | undefined;

	const notify = (
		ui: BackgroundProgressUi,
		message: string,
		type: "info" | "warning" | "error" = "info",
	) => {
		try {
			ui.notify(message, type);
		} catch {
			// A stale UI context must not affect the memory pass.
		}
	};
	const unref = (handle: unknown) => {
		if (typeof handle !== "object" || handle === null || !("unref" in handle)) {
			return;
		}
		const method = (handle as { unref?: () => void }).unref;
		method?.call(handle);
	};

	const clearDisplay = () => {
		if (timer !== undefined) clearTimer(timer);
		timer = undefined;
		renderedLine = undefined;
		renderedWidget = undefined;
		const ui = options.ui();
		if (ui === undefined) return;
		try {
			ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// A stale UI context must not affect the memory pass.
		}
		try {
			ui.setWidget(STATUS_KEY, undefined, { placement: "belowEditor" });
		} catch {
			// A stale UI context must not affect the memory pass.
		}
	};

	const render = () => {
		if (active === undefined) return;
		const ui = options.ui();
		if (ui === undefined) return;
		const label = LABELS[active.job];
		const line = `${label} ${FRAMES[active.frame]}  (background)`;
		if (line === renderedLine) return;
		renderedLine = line;
		try {
			ui.setStatus(STATUS_KEY, line);
		} catch {
			// A stale UI context must not affect the memory pass.
		}
		const widgetLine = `${label}  (background)`;
		if (widgetLine === renderedWidget) return;
		renderedWidget = widgetLine;
		try {
			ui.setWidget(STATUS_KEY, [widgetLine], { placement: "belowEditor" });
		} catch {
			// A stale UI context must not affect the memory pass.
		}
	};

	return {
		begin(job): BackgroundRun {
			clearDisplay();
			const run = { id: ++nextId, job, frame: 0 };
			active = run;
			const ui = options.ui();
			if (ui !== undefined) {
				notify(ui, `${LABELS[job]} started.`);
				render();
			}
			timer = setTimer(() => {
				if (active?.id !== run.id) return;
				active.frame = (active.frame + 1) % FRAMES.length;
				render();
			}, intervalMs);
			unref(timer);

			return {
				end(result): void {
					if (active?.id !== run.id) return;
					clearDisplay();
					active = undefined;
					const currentUi = options.ui();
					if (currentUi === undefined) return;
					const label = LABELS[job];
					if (result === "completed") {
						notify(currentUi, `${label} finished.`);
					} else if (result === "nothing") {
						notify(currentUi, `${label} finished — nothing to change.`);
					} else if (result === "interrupted") {
						notify(
							currentUi,
							`${label} interrupted. Changes already saved remain.`,
							"warning",
						);
					} else {
						notify(
							currentUi,
							`${label} failed. The next run will retry.`,
							"error",
						);
					}
				},
				cancel(): void {
					if (active?.id !== run.id) return;
					clearDisplay();
					active = undefined;
				},
			};
		},

		interrupt(): void {
			if (active === undefined) return;
			const job = active.job;
			clearDisplay();
			active = undefined;
			const ui = options.ui();
			if (ui !== undefined) {
				notify(
					ui,
					`${LABELS[job]} interrupted. Changes already saved remain.`,
					"warning",
				);
			}
		},

		cancel(): void {
			clearDisplay();
			active = undefined;
		},
	};
}
