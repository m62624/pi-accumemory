/**
 * What the model is shown out of its own memory, and how it is worded.
 *
 * Pure functions, plus one hard rule about where the result goes: the block
 * belongs in the TRAILING message, under the transcript — never above it.
 * Everything a backend caches is a prefix, and a recall changes by
 * construction, so a block written above the conversation charges the whole
 * conversation every time it changes. The same mistake in pi-telegram-manager
 * was measured at 19,397 characters of re-reading for one newly learned fact,
 * caused by the block sitting one line too high.
 */

import type { Turn } from "./transcript-view.ts";

/**
 * Drops recalled lines the model can already read in the transcript above.
 *
 * A recall about what was just said ranks what was just said first — so left
 * alone, the block opens by quoting a sentence three lines above it. That costs
 * tokens to say nothing and, worse, makes the section look like noise on
 * exactly the turns it should be trusted.
 *
 * The rule it enforces is what the block is for: the memory answers about what
 * the transcript cannot show. What the window still holds is the window's job.
 */
export function dropVisible(rendered: string, turns: readonly Turn[]): string {
	const said = turns
		.map((turn) => normalise(turn.text))
		.filter((text) => text.length > 0);
	if (said.length === 0) return rendered;

	const kept = rendered.split("\n").filter((line) => {
		if (!isFactLine(line)) return true;
		const body = normalise(line);
		return !said.some((text) => body.includes(text));
	});
	// A heading with every line under it removed claims the memory answered and
	// then shows nothing. Say nothing instead.
	if (!kept.some(isFactLine)) return "";
	return kept.join("\n").trim();
}

/**
 * Wraps a rendered recall for the prompt, or returns `""` when it is empty.
 *
 * The empty case matters more than it looks: a standing heading with nothing
 * under it is a tax on every turn of every project with no memory yet, and it
 * teaches the model that this section is usually noise.
 *
 * The wording says three things, in this order, because a model acts on the
 * last instruction it read: this is your own memory (not something the user
 * said), it may be off-target (ignoring it is allowed), and if it is on target
 * then do not ask for what it already tells you.
 */
export function memoryBlock(rendered: string, scopeLabel: string): string {
	const body = rendered.trim();
	if (body === "") return "";
	return [
		`What you remember about ${scopeLabel}, retrieved for the messages above:`,
		"",
		body,
		"",
		"This is your own long-term memory, carried over from earlier sessions — not " +
			"something anyone just said. It is retrieved by relevance and may be " +
			"off-target: if none of it bears on the work above, ignore it entirely and " +
			"proceed as if it were not here. If it does bear on the work, use it, and do " +
			"not ask for anything it already tells you.",
	].join("\n");
}

export interface ManifestScope {
	label: string;
	facts: number;
	tags: readonly { name: string; count: number }[];
}

/**
 * The one-line inventory shown once at session start.
 *
 * It exists because of the failure mode that makes the ask-the-memory tools
 * worthless: the model does not suspect there is anything to ask about, so it
 * never asks. Two cheap counters fix that — the memory is not empty, and here
 * are the categories it has answers in.
 *
 * An all-empty memory produces no line at all. "0 facts" invites the model to
 * conclude the memory is useless and stop looking at it for the whole session.
 */
export function memoryManifest(scopes: readonly ManifestScope[]): string {
	const parts = scopes
		.filter((scope) => scope.facts > 0)
		.map((scope) => {
			const tags = scope.tags
				.filter((tag) => tag.count > 0)
				.map((tag) => `${tag.name}(${tag.count})`)
				.join(" ");
			const counted = `${scope.label}: ${scope.facts} ${scope.facts === 1 ? "fact" : "facts"}`;
			return tags === "" ? counted : `${counted} - ${tags}`;
		});
	return parts.join(" | ");
}

/**
 * The same block for an idle consolidation pass, where it is not context for a
 * reply but the working material of the pass.
 *
 * It says what the reply-turn wording must not: the ids are actionable. `[f3]`
 * is the `3` that the revise and forget tools take, and a model not told so
 * describes what it would change instead of changing it.
 */
export function consolidationBlock(rendered: string): string {
	const body = rendered.trim();
	if (body === "")
		return "This memory is empty - nothing has been stored for it yet.";
	return [
		"What this memory currently holds:",
		"",
		body,
		"",
		"The number in each [fN] tag is that fact's id: pass it to longterm_revise to " +
			"replace it, or longterm_forget to drop it. Each line is FORMATTED for you - " +
			"the fact itself is the sentence, while the dates say when it has held and " +
			"#tags say how it is filed; never copy those into a fact you write.",
	].join("\n");
}

/** A rendered recall is one bullet per fact; this is a bullet. */
function isFactLine(line: string): boolean {
	return line.trimStart().startsWith("-");
}

function normalise(text: string): string {
	return text.toLowerCase().replace(/\s+/gu, " ").trim();
}
