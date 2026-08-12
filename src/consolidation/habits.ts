/**
 * The third phase of a pass: a mistake this model keeps making.
 *
 * The other two phases curate what the memory KNOWS. This one is about how the
 * model USES it, and it exists because nothing else could. `RepeatGuard` breaks
 * a loop inside one session and forgets; the transcript records the correction
 * but not that it was the fifth. Only the counter in `session/stumbles.ts` can
 * see a habit, and only a pass has the quiet in which to do something about it.
 *
 * What it produces is one fact tagged `instruction` + `always`, which lands in
 * the head of every request of every later session. That is the most expensive
 * thing this extension can write, which shapes everything below.
 *
 * ## One kind per pass
 *
 * Handing over four habits gets four rules in one sitting, each charged to
 * every future request, and a model worse at all four than it would have been
 * at the worst one. The next pass raises the next.
 *
 * ## The rule must name the right move
 *
 * A model asked to write a rule about a failure writes a prohibition - "never
 * use longterm_forget" - which is obeyed exactly and ruins the tool. So the
 * prompt asks for the correct action, in one sentence, and says what it must
 * not be.
 *
 * ## Nothing here writes anything
 *
 * As everywhere else in this extension: the runtime shows what the model cannot
 * otherwise see, the model decides. If it judges the habit not worth a standing
 * rule, that is a legitimate outcome and the prompt says so - a phase that
 * cannot end in "no" is a machine for manufacturing rules.
 */

import {
	STUMBLE_DESCRIPTIONS,
	type StumbleReport,
} from "../session/stumbles.ts";

export interface HabitsContext {
	clock: string;
	habit: StumbleReport;
	/** Standing rules already in force, so a duplicate is not proposed. */
	standing: readonly string[];
	/** The cap this installation puts on standing rules, quoted honestly. */
	limits: { alwaysMax: number; alwaysMaxChars: number };
}

/** The opening message of a habits phase. */
export function habitsPrompt(context: HabitsContext): string {
	const { habit, standing, limits } = context;
	const parts = [
		context.clock,
		"",
		"This is not a conversation and nobody is waiting. You are looking at one " +
			"thing: a mistake you have made in several separate sessions.",
		"",
		`In ${habit.sessions} different sessions - most recently on ${habit.lastSeen} - you ` +
			`${STUMBLE_DESCRIPTIONS[habit.kind]}. Each time the tool told you what was wrong ` +
			"and each time it worked afterwards. The correction did not survive the end of " +
			"the session, so the next session made it again.",
		"",
		"Write yourself ONE standing rule about it: a fact tagged `instruction` and " +
			'`always`, stored with scope: "user", because it is about how you work rather ' +
			"than about this codebase. A rule tagged that way is read at the top of every " +
			"turn of every future session, in every project.",
		"",
		"The rule must:",
		'- state the CORRECT action, not a prohibition. "Never use X" is obeyed exactly ' +
			"and costs you the tool.",
		"- fit in one sentence. It is charged to every request you will ever make.",
		"- be specific enough to act on without the context you have right now.",
		"",
		`This installation shows at most ${limits.alwaysMax} standing rules and ` +
			`${limits.alwaysMaxChars} characters of them. A rule that does not fit is refused ` +
			"when you try to store it, so keep it short rather than complete.",
	];
	if (standing.length > 0) {
		parts.push(
			"",
			"Standing rules you have already written:",
			...standing.map((rule) => `- ${rule}`),
			"",
			"If one of them already covers this, do not write a second - say so and call " +
				"longterm_done. Two rules about one mistake are worse than one, because they " +
				"disagree at the edges.",
		);
	}
	parts.push(
		"",
		"If you judge that this does not warrant a standing rule, that is a real answer: " +
			"call longterm_done without writing one. When you have written it, call " +
			"longterm_done.",
	);
	return parts.join("\n");
}
