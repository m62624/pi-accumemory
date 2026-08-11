/**
 * What a consolidation pass is shown, and how it is kept moving.
 *
 * The pass is an agent loop with no user in it. Its prompt is rebuilt
 * identically on every step, which is exactly what makes it prone to repeating
 * itself: from the inside, step five looks like step four. The runtime is the
 * only thing that can notice, so the ledger's directive is appended to the tail
 * on every step - see `ledger.ts`.
 *
 * This module is pure. It builds strings; running the loop is `runner.ts`.
 */

import { consolidationBlock } from "../memory/block.ts";
import type { Turn } from "../memory/transcript-view.ts";
import type { ConsolidationLedger } from "./ledger.ts";

export interface PassContext {
	/** Composed from `defaults/consolidation.md` plus the user's append. */
	instructions: string;
	/** The current time, so a dated fact can be judged expired. */
	clock: string;
	/** What the memory currently holds, with actionable [fN] ids. */
	memory: string;
	/** The unprocessed tail of the transcript. */
	transcript: readonly Turn[];
	/** What the pass is reviewing: a project, or a directory that is not one. */
	label: string;
}

/** The opening message of a pass. */
export function passPrompt(context: PassContext): string {
	const transcript = renderTranscript(context.transcript);
	return [
		context.clock,
		"",
		`You are reviewing what happened in ${context.label} while it was quiet, ` +
			"and curating your own long-term memory from it. Nobody is waiting for a reply; " +
			"there is no answer to write. The only things that count are the memory calls " +
			"you make.",
		"",
		context.instructions,
		"",
		context.memory,
		"",
		transcript === ""
			? "There is nothing new in the transcript since the last pass."
			: `Recent conversation, oldest first:\n\n${transcript}`,
	].join("\n");
}

/** The empty-memory form, so a first pass is not shown a blank section. */
export function passMemoryView(rendered: string): string {
	return consolidationBlock(rendered);
}

/** The per-step tail: the ledger's directive, and nothing else. */
export function passTail(ledger: ConsolidationLedger): string {
	return ledger.directive().text;
}

function renderTranscript(turns: readonly Turn[]): string {
	return turns
		.filter((turn) => turn.text.trim() !== "")
		.map((turn) => `${label(turn.role)}: ${turn.text}`)
		.join("\n\n");
}

function label(role: Turn["role"]): string {
	switch (role) {
		case "user":
			return "User";
		case "assistant":
			return "You";
		case "tool":
			return "Tool result";
	}
}
