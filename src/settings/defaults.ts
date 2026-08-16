/**
 * The complete settings document with its defaults.
 *
 * Written out in full rather than assembled from fragments so no key's nesting
 * is ever a guess — this object is the one SETTINGS.md publishes, and a test
 * holds the two in sync.
 */

export interface RefreshSettings {
	/** Tool calls before the memory block is recomputed mid-loop; 0 disables. */
	afterToolCalls: number;
	onCompact: boolean;
	/** Consecutive tool-less inferences before hinting that memory can be asked. */
	askHintAfterIdleInferences: number;
}

/**
 * How a folder is matched to a memory.
 *
 * Two questions are asked walking up from the working directory: does an
 * ancestor already have a memory, and does one look like a project root. The
 * first has priority - a memory somebody bound is a statement, a file lying in
 * a folder is a guess - and this is where the guessing part is configured.
 */
export interface ProjectSettings {
	/**
	 * File or directory names that make a folder a project root.
	 *
	 * Just `.git` by default. The old list tried to name every ecosystem's
	 * manifest and got the granularity wrong in both directions: a package
	 * inside a repository became its own memory, and a folder with no manifest
	 * got none at all. Whoever knows which is which is the person working
	 * there, so the list is theirs - add `Cargo.toml`, `go.mod`, whatever this
	 * machine actually uses.
	 *
	 * An empty list switches detection off entirely: then a folder has a memory
	 * only if somebody asked for one with `/longterm-new`.
	 */
	markers: string[];
	/**
	 * How many parent folders the walk may climb before giving up.
	 *
	 * A bound rather than "up to the filesystem root", because both walks are
	 * per-session work on someone's machine, and a session started in a deeply
	 * nested directory should not pay for a hundred lookups to learn there is
	 * nothing above it. `0` looks at the working directory alone.
	 */
	maxParents: number;
}

export interface NudgeSettings {
	enabled: boolean;
	afterMessages: number;
	afterToolCalls: number;
	/** Without this the reminder, once due, repeats on every following turn. */
	cooldownTurns: number;
}

/** The independent automatic pass that re-reads the oldest stored facts. */
export interface ReviewSettings {
	enabled: boolean;
	/** Milliseconds between automatic review passes; 0 disables the scheduler. */
	intervalMs: number;
	/**
	 * How many old facts one pass looks at, per memory.
	 *
	 * Small on purpose. The window walks forward every pass and wraps at the
	 * end, so the whole memory is covered over time; a large window instead
	 * spends one long pass on material that is mostly fine.
	 */
	sampleSize: number;
}

export interface InspectSettings {
	/** Facts shown in one inspector result page before terminal-height clipping. */
	pageSize: number;
}

export interface CustomSecretPattern {
	name: string;
	pattern: string;
	description: string;
}

export interface SecuritySettings {
	/** Additional blocking rules; built-in rules cannot be disabled or overridden. */
	customPatterns: CustomSecretPattern[];
}

/**
 * The habit phase: a mistake the model has repeated across sessions.
 *
 * Off is a defensible choice, which is why it is a setting. What it produces
 * lands in the head of every request forever, and somebody who would rather
 * write those rules themselves should be able to say so.
 */
export interface HabitsSettings {
	enabled: boolean;
	/**
	 * Separate sessions a mistake must appear in before it is raised.
	 *
	 * Three, because two is a coincidence and one is a bad evening. A mistake
	 * made in three different sessions is a property of this model on this
	 * machine, which is the only thing worth spending permanent context on.
	 */
	afterSessions: number;
}

export interface ConsolidationSettings {
	enabled: boolean;
	quietMs: number;
	maxSteps: number;
	maxNudges: number;
	maxTranscriptChars: number;
	promoteToCommon: boolean;
	review: ReviewSettings;
	habits: HabitsSettings;
	/**
	 * Reclaim the bytes of forgotten facts at the end of a pass.
	 *
	 * On, because nothing else ever does it: `forget` only tombstones, and
	 * plugmem schedules no maintenance of its own. Off is for someone who wants
	 * to run `maintain` on their own terms - the space is not lost either way,
	 * only unreclaimed.
	 */
	maintain: boolean;
}

/**
 * How much of a memory write is echoed into the terminal.
 *
 * Only what the PERSON sees. The model is always given the full account -
 * which memory, which entity, which tags, and which existing facts the new one
 * sits next to - because every one of those is something it needs to choose a
 * tag consistently, to notice a near-duplicate, or to address a fact later.
 * Trimming what the model reads to make the terminal tidier would be paying for
 * a quiet screen with a worse memory.
 *
 * - `short`  - one line: what was stored and where.
 * - `full`   - everything the model was told. Useful while tuning the setup.
 * - `hidden` - nothing at all.
 */
export type WriteOutput = "short" | "full" | "hidden";

export interface Settings {
	timezone: string | null;
	memory: {
		enabled: boolean;
		/**
		 * What the TERMINAL shows for a memory call; the model always sees all.
		 *
		 * Every tool reports what it did, and every one of them has a one-line
		 * form for the person watching.
		 */
		output: WriteOutput;
		recallTokenBudget: number;
		/** 0 leaves the engine's own default in charge. */
		recallK: number;
		graphDepth: number | null;
		manifest: boolean;
		queryMaxChars: number;
		/**
		 * Where plugmem's own `config.toml` is; `null` means the extension's
		 * directory.
		 *
		 * The only thing this file says about the engine. Everything else -
		 * the embedder, recall weights, maintenance - is said in that file,
		 * which plugmem reads and documents itself.
		 *
		 * Relative paths are read from the extension's directory, and a leading
		 * `~` is the home directory.
		 */
		plugmemConfig: string | null;
		/**
		 * Rebuild stored vectors by itself when they no longer match the
		 * embedder, or were never computed.
		 *
		 * Ours, not plugmem's: the engine reports the mismatch, this decides
		 * whether to repair it without being asked. On by default because the
		 * alternative is a memory that stops answering and says so only at the
		 * first lookup. Off, the repair is one `/longterm-reembed` away.
		 */
		autoReembed: boolean;
		refresh: RefreshSettings;
		project: ProjectSettings;
		instructions: { alwaysMax: number; alwaysMaxChars: number };
		notes: { overviewMaxChars: number };
		nudge: NudgeSettings;
		inspect: InspectSettings;
		security: SecuritySettings;
		consolidation: ConsolidationSettings;
		crossProject: { enabled: boolean };
	};
}

/**
 * `Object.freeze` is shallow, and these defaults are nested. Freezing every
 * level turns "the parser accidentally wrote into the defaults" from a bug that
 * surfaces one session later into a `TypeError` on the spot.
 */
function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const nested of Object.values(value)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}

export const DEFAULT_SETTINGS: Settings = deepFreeze({
	/** `null` means "read the host's zone"; a string pins it. */
	timezone: null,
	memory: {
		enabled: true,
		output: "short",
		recallTokenBudget: 512,
		recallK: 0,
		graphDepth: null,
		manifest: true,
		queryMaxChars: 600,
		plugmemConfig: null,
		autoReembed: true,
		refresh: {
			afterToolCalls: 10,
			onCompact: true,
			askHintAfterIdleInferences: 2,
		},
		project: {
			markers: [".git"],
			maxParents: 16,
		},
		instructions: {
			alwaysMax: 8,
			alwaysMaxChars: 1200,
		},
		notes: {
			overviewMaxChars: 4000,
		},
		nudge: {
			enabled: true,
			afterMessages: 20,
			afterToolCalls: 30,
			cooldownTurns: 15,
		},
		inspect: {
			pageSize: 40,
		},
		security: {
			customPatterns: [],
		},
		consolidation: {
			enabled: true,
			quietMs: 420_000,
			maxSteps: 12,
			maxNudges: 2,
			maxTranscriptChars: 20_000,
			promoteToCommon: true,
			review: {
				enabled: true,
				intervalMs: 1_800_000,
				sampleSize: 12,
			},
			habits: {
				enabled: true,
				afterSessions: 3,
			},
			maintain: true,
		},
		crossProject: {
			enabled: true,
		},
	},
}) as Settings;
