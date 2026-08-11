/**
 * The second phase of a consolidation pass: looking at what is already stored.
 *
 * The first phase reads the transcript, so it only ever considers what was just
 * discussed. That leaves a gap nothing else covers: a fact learned six months
 * ago, never mentioned since, is never reconsidered - not because it is still
 * true, but because nothing puts it in front of anybody. Memory then only ever
 * grows, and the oldest entries are the least likely to still be right.
 *
 * So this phase shows the model a window of the oldest stored facts and asks
 * one question about each: does this still earn its place. It decides; nothing
 * here deletes anything. That is the same division as everywhere else in this
 * extension - the runtime shows what the model could not otherwise see, and the
 * model judges.
 *
 * The alternative considered and rejected was a TTL: facts tagged `session`
 * expire after N days. It is predictable and it needs no model, but it deletes
 * on a rule that knows nothing about what the fact says, and the tag vocabulary
 * here is open, so the rule would be enforced against a convention nobody has
 * to follow.
 */

import type { Scope } from "../session/controller.ts";

export interface ReviewFact {
	id: number;
	text: string;
	tags: string[];
}

export interface ReviewWindow {
	scope: Exclude<Scope, "both">;
	label: string;
	facts: readonly ReviewFact[];
}

export interface ReviewContext {
	instructions: string;
	/** The current time: half of these judgements are about whether a date passed. */
	clock: string;
	windows: readonly ReviewWindow[];
	/** Live facts across every memory, so the window has a sense of scale. */
	held: number;
}

/** The opening message of a review phase. */
export function reviewPrompt(context: ReviewContext): string {
	const parts = [
		context.clock,
		"",
		"You are reviewing facts you stored earlier, oldest first, while nothing else " +
			"is happening. Nobody is waiting for a reply and there is no answer to write - " +
			"the only things that count are the memory calls you make.",
		"",
		"These are NOT search results and nothing here was asked about. They are simply " +
			"the oldest entries still stored, shown to you because nothing else would ever " +
			"bring them up again.",
		"",
		`Your memory holds ${context.held} ${context.held === 1 ? "fact" : "facts"} in total. ` +
			"You are seeing a window of them; the next pass continues from where this one " +
			"stops, so there is no need to hurry and nothing is lost by leaving the rest.",
		"",
		context.instructions,
		"",
	];
	for (const window of context.windows) {
		parts.push(
			`--- ${window.label} - the ids below are scope: "${window.scope}" ---`,
		);
		for (const fact of window.facts) {
			const tags = fact.tags.length === 0 ? "" : ` #${fact.tags.join(" #")}`;
			parts.push(`- [f${fact.id}] ${fact.text}${tags}`);
		}
		parts.push("");
	}
	parts.push(
		"Go through them one at a time. Most will be fine and need nothing - saying so " +
			"is not a wasted step, it is the answer. When you are done, call longterm_done.",
	);
	return parts.join("\n");
}

/**
 * Where the next review starts: one past the highest id shown.
 *
 * One PAST, because the window is inclusive of its first id - there is no id
 * below zero to mean "nothing shown yet", so an exclusive cursor would skip
 * [f0] for the life of the memory.
 *
 * `0` when the window was empty, which wraps the walk to the beginning.
 * Wrapping is the point: a memory walked to the end has an oldest fact again,
 * and the facts that survived one review are exactly the ones worth asking
 * about again later - just not immediately.
 */
export function nextCursor(windows: readonly ReviewWindow[]): number {
	let highest = -1;
	for (const window of windows) {
		for (const fact of window.facts) highest = Math.max(highest, fact.id);
	}
	return highest < 0 ? 0 : highest + 1;
}
