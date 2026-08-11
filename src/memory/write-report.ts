/**
 * What the model is told after a write, and what the person is shown.
 *
 * These are two different questions and this module keeps them apart, because
 * the answer to one is "as much as possible" and to the other "as little as
 * suffices".
 *
 * **The model always gets everything.** Which memory the fact landed in, under
 * which entity, with which tags, and which existing facts it sits closest to.
 * Every one of those is something it needs later and cannot recover on its own:
 * the scope to address the fact at all (the two memories number facts
 * separately), the entity because that is what the duplicate guard compares
 * against, the tags because filtering matches them exactly and a second
 * spelling splits the pile, and the neighbours because that is the only way it
 * learns which tags this memory already uses and what it nearly repeated.
 * Trimming any of it to tidy the terminal would be buying a quiet screen with a
 * worse memory.
 *
 * **The person gets what they asked for** - `memory.writeOutput`, one line by
 * default.
 */

export interface Neighbour {
	id: number;
	text: string;
	score: number;
	/**
	 * How that neighbour is filed.
	 *
	 * Carried because it is the answer to "which tag does this memory already
	 * use for this kind of thing" at the exact moment the model is choosing
	 * one. A tag filter matches exactly, so a second spelling splits the pile;
	 * showing what the closest facts are tagged with is the cheapest way to
	 * keep the vocabulary from drifting.
	 */
	tags: readonly string[];
}

export interface WriteReport {
	id: number;
	/** The memory it landed in, as the model must pass it back. */
	scope: "project" | "user";
	/** What a person calls that memory. */
	scopeLabel: string;
	entity: string;
	tags: readonly string[];
	/**
	 * The tags this memory already uses, most used first.
	 *
	 * Not a similarity list, and deliberately so. A recall always returns its
	 * best match however weak - it has no threshold below which it says
	 * "nothing is close" - so presenting recall hits as near-duplicates invites
	 * exactly the mistake pi-telegram-manager paid a lost fact for: a nearest
	 * neighbour at a fused score of 0.02 read as a duplicate of an unrelated
	 * statement. What the engine genuinely judged too close is reported where
	 * it is genuine: on a refusal.
	 *
	 * What this IS for is the tag decision, which has no other source at the
	 * moment it is made: filtering matches tags exactly, so a second spelling
	 * splits the pile and neither half answers the other's question.
	 */
	vocabulary: readonly string[];
	/** Tag-drift warnings, already worded. */
	notes: readonly string[];
}

/** The full account, for the model. */
export function modelReport(report: WriteReport): string {
	const lines = [
		`Stored [f${report.id}] in ${report.scopeLabel}.`,
		`  scope  : ${report.scope}   <- pass this with [f${report.id}] to revise or forget it`,
		`  entity : ${report.entity}`,
		`  tags   : ${report.tags.length === 0 ? "(none)" : report.tags.join(", ")}`,
	];
	if (report.vocabulary.length > 0) {
		// Shown on every write because the alternative is a separate
		// longterm_tags call the model rarely thinks to make, and by then the
		// tag is already chosen.
		lines.push(`  in use : ${report.vocabulary.join(" ")}`);
	}
	lines.push(...report.notes);
	return lines.join("\n");
}

/** One line, for the terminal. */
export function shortReport(report: WriteReport): string {
	return `Stored [f${report.id}] in ${report.scopeLabel}.`;
}
