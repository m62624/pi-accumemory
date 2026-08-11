/**
 * What the memory is asked about, and why the two questions differ.
 *
 * A recall is only as good as the text it runs on, and the right text is not
 * the same at the start of a turn and ten tool calls into it.
 *
 * - {@link recallQuery} runs on the **unanswered tail**: what the user just
 *   said and nobody has replied to. Everything older is in the transcript
 *   verbatim, so re-fetching it spends the budget on what the model can already
 *   read.
 * - {@link progressQuery} runs on **what the model has learned since**: the
 *   last few tool results and its own last thought. By the tenth tool call the
 *   opening request is no longer what it is working on, and a block still
 *   answering that question is a block about the wrong thing.
 *
 * Both truncate from the front. The newest end of a query is the identifying
 * end, and lexical retrieval degrades as terms pile up: a pasted wall of text
 * drowns the two or three words that actually name the question.
 */

import type { Turn } from "./transcript-view.ts";

/**
 * How far back {@link progressQuery} looks.
 *
 * Bounded because a long agentic loop is long: without a window the query grows
 * until it is truncated anyway, having spent the work of assembling the part
 * that gets thrown away.
 */
const PROGRESS_WINDOW = 8;

/**
 * The unanswered tail of the transcript, oldest first.
 *
 * Returns `""` when the newest user message has already been answered — the
 * caller reads that as "nothing new was asked, do not spend a recall".
 */
export function recallQuery(turns: readonly Turn[], maxChars: number): string {
	const tail: string[] = [];
	for (let i = turns.length - 1; i >= 0; i -= 1) {
		const turn = turns[i];
		if (turn === undefined) continue;
		// An assistant message closes the batch: everything older than it has
		// been dealt with. A tool result does not — it is the assistant's own
		// work in progress, not a reply.
		if (turn.role === "assistant") break;
		if (turn.role === "user" && turn.text !== "") tail.unshift(turn.text);
	}
	return clampTail(tail.join("\n"), maxChars);
}

/**
 * What the model has seen and thought most recently, oldest first.
 *
 * This is the query for the middle of a tool loop. It excludes user messages on
 * purpose: those are what {@link recallQuery} already asked about, and mixing
 * them back in pulls the block towards the question the model has moved on from.
 */
export function progressQuery(
	turns: readonly Turn[],
	maxChars: number,
): string {
	const recent: string[] = [];
	for (
		let i = turns.length - 1;
		i >= 0 && recent.length < PROGRESS_WINDOW;
		i -= 1
	) {
		const turn = turns[i];
		if (turn === undefined) continue;
		if (turn.role === "user") continue;
		if (turn.text !== "") recent.unshift(turn.text);
	}
	return clampTail(recent.join("\n"), maxChars);
}

function clampTail(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	return text.slice(text.length - maxChars);
}
