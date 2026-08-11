/**
 * What a vector rebuild looks like while it is happening.
 *
 * A rebuild is the one operation here that takes real time - every fact in
 * every database goes to the embedding service and comes back - and until now
 * it showed a single line in the footer naming databases by their file names
 * (`p_dd21d9ddb1fa`), which tells a person nothing about what is being rebuilt
 * or how much is left.
 *
 * Content is a pure function of the state so it can be tested without a
 * terminal; `index.ts` pushes it through `ui.setWidget`, the same arrangement
 * pi-telegram-manager uses for its manager banner.
 */

/** How one database ended up, or that it has not started yet. */
export type StepState = "waiting" | "running" | "done" | "skipped";

export interface ProgressStep {
	/** What a person calls it: a folder name, or the shared memory. */
	label: string;
	state: StepState;
}

/** Braille spinner frames, the same shape pi's own working indicator uses. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const MARK: Record<StepState, (frame: string) => string> = {
	waiting: () => "·",
	running: (frame) => frame,
	done: () => "✓",
	skipped: () => "!",
};

/**
 * The widget body.
 *
 * Every database is listed from the start, including the ones not reached yet,
 * so the length of the job is visible immediately rather than being discovered
 * one line at a time.
 */
export function reembedProgressLines(
	steps: readonly ProgressStep[],
	tick: number,
): string[] {
	const frame = SPINNER[tick % SPINNER.length] ?? SPINNER[0] ?? "";
	const finished = steps.filter(
		(step) => step.state === "done" || step.state === "skipped",
	).length;
	const running = steps.some((step) => step.state === "running");
	return [
		`${running ? frame : "✓"} Rebuilding memory vectors — ${finished} of ${steps.length}`,
		...steps.map((step) => `  ${MARK[step.state](frame)} ${step.label}`),
		"  Memory tools answer from the old vectors until this finishes.",
	];
}

/**
 * The sentence left behind afterwards.
 *
 * Names what was skipped and what to do about it. A skipped database is not a
 * detail: the workspace is then answering from two vector spaces at once, and
 * nothing else will ever mention it again.
 */
export function reembedSummary(steps: readonly ProgressStep[]): string {
	const done = steps.filter((step) => step.state === "done");
	const skipped = steps.filter((step) => step.state === "skipped");
	const rebuilt = `Rebuilt ${done.length} of ${steps.length} memories.`;
	if (skipped.length === 0) return rebuilt;
	const names = skipped.map((step) => step.label).join(", ");
	const them = skipped.length === 1 ? "it" : "them";
	return (
		`${rebuilt} Could not rebuild ${names}: another pi session has ${them} open. ` +
		`Close that session and run /longterm-reembed again - until then ${names} ` +
		"still answers from the old vectors."
	);
}
