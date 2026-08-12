/**
 * The mistakes this model keeps making, counted across sessions.
 *
 * `RepeatGuard` next door stops a failing call being sent a third time, and it
 * dies with the session. So a model that has opened with the same wrong call in
 * five consecutive sessions is corrected five times and learned from zero times:
 * nothing outlives the process that saw it.
 *
 * This does. Not by reading the transcript afterwards and inferring what went
 * wrong - that is a guess about a guess - but by labelling the failure at the
 * branch that produced it. Every kind below is an existing refusal in
 * `controller.ts` with a message already written for it; all this adds is a
 * name and a counter.
 *
 * ## One mistake is not a habit
 *
 * A kind counts toward a session only after it happens {@link REPEATS_PER_SESSION}
 * times in it. Everyone gets a scope wrong once. Getting it wrong twice in one
 * sitting is the start of a pattern, and a pattern repeated across separate
 * sessions is the only thing worth spending context on.
 *
 * ## What it is for
 *
 * The consolidation pass reads this and, above the threshold, asks the model to
 * write itself ONE standing rule about it - a fact tagged `instruction` and
 * `always`, which every later session reads at the top of every turn. The loop
 * closes: the system learns where THIS model on THIS machine trips.
 *
 * ## And what happens when it does not work
 *
 * A kind whose rule was written and which keeps happening is not a model
 * problem any more. It is ours: a bug, or an instruction that says the wrong
 * thing. So `covered` stops the pass proposing a second rule, the count keeps
 * going, and `/longterm-status` tells the human. A system that can say "I cannot
 * fix this myself" is worth more than one that writes itself a third commandment.
 */

import type { FileOps } from "../fs-ops.ts";

/**
 * Every mistake the runtime can name with certainty.
 *
 * Each is one branch of `MemoryController`. Nothing here is inferred, and
 * nothing is added that the code cannot detect exactly - a kind that needs
 * interpretation would put a guess in front of the model as though it were an
 * observation.
 */
export const STUMBLE_KINDS = [
	/** A fact id passed to revise or forget with no scope, or with `both`. */
	"id_without_scope",
	/** The id was real, but in the memory that was not asked. */
	"id_in_the_other_memory",
	/** The id is in neither memory, live or otherwise. */
	"id_not_there",
	/** A write addressed to `both`, which is a reading scope. */
	"wrote_to_a_reading_scope",
	/** The duplicate guard refused a write because the fact is already held. */
	"duplicate_refused",
	/** The same question asked of the memory twice in one run. */
	"asked_the_same_question",
] as const;

export type StumbleKind = (typeof STUMBLE_KINDS)[number];

/** Occurrences in ONE session before that session counts toward the habit. */
export const REPEATS_PER_SESSION = 2;

/** What the human is told about a kind, and what the pass shows the model. */
export const STUMBLE_DESCRIPTIONS: Record<StumbleKind, string> = {
	id_without_scope:
		"called longterm_revise, longterm_forget or longterm_forget_many with a " +
		"fact id but no scope " +
		'(or scope: "both"), which cannot name a fact because the two memories ' +
		"number theirs independently",
	id_in_the_other_memory:
		"used a fact id against one memory while the fact was in the other one",
	id_not_there:
		"used a fact id that exists in neither memory, and had to be told so",
	wrote_to_a_reading_scope:
		'tried to write a fact with scope: "both", which reads from the two ' +
		"memories and cannot be written to",
	duplicate_refused:
		"tried to store a fact the memory already holds, and was refused by the " +
		"duplicate guard",
	asked_the_same_question:
		"asked the memory a question it had already answered in the same run",
};

interface Entry {
	/** Sessions in which this kind happened at least REPEATS_PER_SESSION times. */
	sessions: number;
	/** The last session id counted, so one session is never counted twice. */
	lastSession: string;
	/** ISO date, for the human-facing report. */
	lastSeen: string;
	/** True once a standing rule has been written about this kind. */
	covered: boolean;
	/** Sessions counted AFTER the rule was written - the "it did not work" number. */
	sinceCovered: number;
}

export interface StumbleReport {
	kind: StumbleKind;
	sessions: number;
	lastSeen: string;
	covered: boolean;
	sinceCovered: number;
}

export interface StumbleLogOptions {
	fs: FileOps;
	file: string;
	flavour: { dirname(file: string): string };
	/** Distinct per process; two sessions must not share one. */
	sessionId: string;
	now?: () => Date;
}

/**
 * The counters, on disk.
 *
 * Loaded lazily and written after each counted session, with every failure
 * swallowed: losing this file costs the system some patience about a habit it
 * had noticed, and nothing else. Refusing to work because a small JSON file is
 * malformed would cost the session.
 */
export class StumbleLog {
	private entries: Partial<Record<StumbleKind, Entry>> = {};
	private readonly seenThisSession = new Map<StumbleKind, number>();
	private loaded = false;
	private readonly now: () => Date;

	constructor(private readonly options: StumbleLogOptions) {
		this.now = options.now ?? (() => new Date());
	}

	/**
	 * Records one occurrence.
	 *
	 * Cheap and synchronous in the common case: the counting happens in memory,
	 * and only the {@link REPEATS_PER_SESSION}-th occurrence of a kind touches
	 * the disk. Every call site is inside a refusal that was already being
	 * built, so this must never be able to make one slower or throw.
	 */
	async note(kind: StumbleKind): Promise<void> {
		const seen = (this.seenThisSession.get(kind) ?? 0) + 1;
		this.seenThisSession.set(kind, seen);
		if (seen !== REPEATS_PER_SESSION) return;
		try {
			await this.count(kind);
		} catch {
			// See the class comment: this file is never worth an interruption.
		}
	}

	/** Everything known, worst first. */
	async report(): Promise<StumbleReport[]> {
		await this.load();
		const rows: StumbleReport[] = [];
		for (const kind of STUMBLE_KINDS) {
			const entry = this.entries[kind];
			if (entry === undefined) continue;
			rows.push({
				kind,
				sessions: entry.sessions,
				lastSeen: entry.lastSeen,
				covered: entry.covered,
				sinceCovered: entry.sinceCovered,
			});
		}
		return rows.sort((a, b) => b.sessions - a.sessions);
	}

	/**
	 * The one kind a consolidation pass should raise, if any.
	 *
	 * ONE, deliberately. A pass that hands over four habits at once gets four
	 * rules written in one go, each of them costing head room in every later
	 * request, and the model is worse at all four than it would have been at
	 * the worst one alone. The next pass raises the next.
	 */
	async worstUncovered(
		afterSessions: number,
	): Promise<StumbleReport | undefined> {
		const rows = await this.report();
		return rows.find((row) => !row.covered && row.sessions >= afterSessions);
	}

	/** Kinds whose rule was written and which went on happening anyway. */
	async unfixable(afterSessions: number): Promise<StumbleReport[]> {
		const rows = await this.report();
		return rows.filter(
			(row) => row.covered && row.sinceCovered >= afterSessions,
		);
	}

	/** Marks a kind as having a standing rule, so no second one is proposed. */
	async markCovered(kind: StumbleKind): Promise<void> {
		try {
			await this.load();
			const entry = this.entries[kind];
			if (entry === undefined) return;
			entry.covered = true;
			entry.sinceCovered = 0;
			await this.save();
		} catch {
			// Worst case a later pass proposes the same rule again, and the
			// duplicate guard refuses to store it twice.
		}
	}

	private async count(kind: StumbleKind): Promise<void> {
		await this.load();
		const entry = this.entries[kind] ?? {
			sessions: 0,
			lastSession: "",
			lastSeen: "",
			covered: false,
			sinceCovered: 0,
		};
		// The same session can raise a kind twenty times; it is still one
		// session, and it is sessions that say whether a habit outlived a
		// correction.
		if (entry.lastSession === this.options.sessionId) return;
		entry.lastSession = this.options.sessionId;
		entry.sessions += 1;
		if (entry.covered) entry.sinceCovered += 1;
		entry.lastSeen = this.now().toISOString().slice(0, 10);
		this.entries[kind] = entry;
		await this.save();
	}

	private async save(): Promise<void> {
		const { fs, file, flavour } = this.options;
		await fs.mkdir(flavour.dirname(file));
		await fs.writeFile(file, JSON.stringify(this.entries, null, "\t"));
	}

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const raw = await this.options.fs.readFile(this.options.file);
			if (raw === undefined) return;
			const parsed: unknown = JSON.parse(raw);
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				return;
			}
			// Only known kinds, and only well-shaped entries. A file edited by
			// hand must not be able to put an unknown string in front of the
			// model as though the runtime had observed it.
			for (const kind of STUMBLE_KINDS) {
				const entry = (parsed as Record<string, unknown>)[kind];
				if (isEntry(entry)) this.entries[kind] = entry;
			}
		} catch {
			// A corrupt file starts the counting over, which is the safe way to
			// be wrong: it delays a rule rather than inventing one.
		}
	}
}

/**
 * What `/longterm-status` says about a habit a standing rule did not cure.
 *
 * This is the honest end of the loop. A mistake that goes on after the model
 * wrote itself a rule about it is not a model that will not learn - it is a
 * rule that says the wrong thing, or a tool that behaves differently from how
 * it is described. Neither is fixable by writing a third rule, and going on
 * writing them would spend permanent context to hide our own bug.
 *
 * So the system stops and tells the human. Empty when there is nothing to say,
 * because a status line that always has an opinion is a status line nobody
 * reads.
 */
export function unfixableNotice(rows: readonly StumbleReport[]): string {
	if (rows.length === 0) return "";
	const lines = rows.map(
		(row) =>
			`- ${row.kind}: ${row.sessions} sessions, ${row.sinceCovered} of them after ` +
			"a standing rule was written about it",
	);
	return [
		"Repeated mistakes a standing rule did not fix:",
		...lines,
		"That usually means the rule says the wrong thing, or the tool behaves",
		"differently from how it is described - not that the model will not learn.",
		"The rules are facts tagged instruction+always in the memory about you.",
	].join("\n");
}

function isEntry(value: unknown): value is Entry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.sessions === "number" &&
		Number.isInteger(entry.sessions) &&
		entry.sessions >= 0 &&
		typeof entry.lastSession === "string" &&
		typeof entry.lastSeen === "string" &&
		typeof entry.covered === "boolean" &&
		typeof entry.sinceCovered === "number" &&
		Number.isInteger(entry.sinceCovered) &&
		entry.sinceCovered >= 0
	);
}
