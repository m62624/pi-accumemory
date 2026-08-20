/**
 * User-facing progress for the otherwise in-memory memory agents.
 *
 * The agent conversation stays private and ephemeral; this is only a small
 * status line and lifecycle notifications. Keeping this
 * separate from the pass itself means the memory runner remains usable in
 * tests and in non-interactive callers.
 */

export type BackgroundJob = "consolidation" | "review" | "size-consolidation";
export type BackgroundResult =
	| "completed"
	| "nothing"
	| "interrupted"
	| "failed";

export interface BackgroundProgressUi {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
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

export async function runInspectorWhenAvailable<T>(
	job: BackgroundJob | undefined,
	notify: (message: string, type?: "info" | "warning" | "error") => void,
	task: () => Promise<T>,
): Promise<T | undefined> {
	if (job !== undefined) {
		const label = LABELS[job];
		notify(
			`${label} is running. Open the memory inspector after it finishes.`,
			"warning",
		);
		return undefined;
	}
	return task();
}

const STATUS_KEY = "longterm-memory";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const LABELS: Record<BackgroundJob, string> = {
	consolidation: "Memory consolidation",
	review: "Memory review",
	"size-consolidation": "Memory size consolidation",
};

export function createBackgroundProgress(options: BackgroundProgressOptions): {
	begin(job: BackgroundJob): BackgroundRun;
	activeJob(): BackgroundJob | undefined;
	interrupt(): void;
	cancel(): void;
} {
	const setTimer = options.setTimer ?? ((fn, ms) => setInterval(fn, ms));
	const clearTimer =
		options.clearTimer ?? ((handle) => clearInterval(handle as never));
	// A sub-second update keeps the footer spinner visibly alive without turning
	// a small indicator into a screen-wide repaint loop.
	const intervalMs = options.intervalMs ?? 120;
	let timer: unknown;
	let active: { id: number; job: BackgroundJob; frame: number } | undefined;
	let nextId = 0;
	let renderedLine: string | undefined;

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
		const ui = options.ui();
		if (ui === undefined) return;
		try {
			ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// A stale UI context must not affect the memory pass.
		}
	};

	const render = () => {
		if (active === undefined) return;
		const ui = options.ui();
		if (ui === undefined) return;
		const label = LABELS[active.job];
		const line = `${label} ${FRAMES[active.frame]}`;
		if (line === renderedLine) return;
		renderedLine = line;
		try {
			ui.setStatus(STATUS_KEY, line);
		} catch {
			// A stale UI context must not affect the memory pass.
		}
	};

	return {
		activeJob(): BackgroundJob | undefined {
			return active?.job;
		},

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
