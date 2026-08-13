/**
 * The complete settings document with its defaults.
 *
 * Written out in full rather than assembled from fragments so no key's nesting
 * is ever a guess — this object is the one SETTINGS.md publishes, and a test
 * holds the two in sync.
 */

/**
 * The embedder as `settings.json` used to describe it - kept only to carry an
 * existing installation over.
 *
 * plugmem is configured in its own `config.toml` now (`memory.plugmemConfig`
 * says where). These keys are still parsed, and they are still honoured exactly
 * once: to write that file the first time, so an upgrade does not silently turn
 * a working embedder off. Nothing reads them afterwards.
 */
export interface EmbedderSettings {
	/**
	 * Off by default so a machine with no embedding service still works. It is
	 * *recommended* on, though: without vectors a question phrased differently
	 * from the stored fact never finds it, and asking the memory in your own
	 * words is the point of the whole extension.
	 */
	enabled: boolean;
	url: string;
	/** Multilingual on purpose — one memory holds Russian and English. */
	model: string;
	/** Name of the environment variable holding the key, never the key itself. */
	apiKeyEnv: string | null;
	/**
	 * The semantic space the stored vectors belong to.
	 *
	 * `null` lets plugmem use its own default, which is the model name - so
	 * changing the model changes the space, which is usually what you want.
	 * Pin it to a name of your own when you are swapping endpoints or aliases
	 * for the SAME model and do not want a rebuild.
	 */
	spaceId: string | null;
	/**
	 * Embedding width, written into the database at creation.
	 *
	 * Changing it does NOT stop the database opening - measured, not assumed -
	 * but the stored vectors then belong to a width nothing else uses, so a
	 * rebuild is still needed. With `autoReembed` on, that happens by itself.
	 */
	dim: number;
}

export interface RefreshSettings {
	/** Tool calls before the memory block is recomputed mid-loop; 0 disables. */
	afterToolCalls: number;
	onCompact: boolean;
	/** Consecutive tool-less inferences before hinting that memory can be asked. */
	askHintAfterIdleInferences: number;
}

export interface NudgeSettings {
	enabled: boolean;
	afterMessages: number;
	afterToolCalls: number;
	/** Without this the reminder, once due, repeats on every following turn. */
	cooldownTurns: number;
}

/**
 * The second phase of a pass: re-reading what is already stored.
 *
 * Separate from the first because it answers a different question and can be
 * wanted on its own. The first phase reads the transcript, so it only ever
 * considers what was just discussed; this one walks the oldest facts, which
 * nothing else would ever bring up again.
 */
export interface ReviewSettings {
	enabled: boolean;
	/**
	 * How many old facts one pass looks at, per memory.
	 *
	 * Small on purpose. The window walks forward every pass and wraps at the
	 * end, so the whole memory is covered over time; a large window instead
	 * spends one long pass on material that is mostly fine.
	 */
	sampleSize: number;
}

/**
 * The third phase: a mistake the model has repeated across sessions.
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
		 * Named `output` rather than `writeOutput` since it stopped being about
		 * writes: every tool now reports what it did, and every one of them has
		 * a one-line form for the person watching.
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
		/** @deprecated Carried over into `config.toml` once, then unused. */
		embedder: EmbedderSettings;
		instructions: { alwaysMax: number; alwaysMaxChars: number };
		notes: { overviewMaxChars: number };
		nudge: NudgeSettings;
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
		embedder: {
			enabled: false,
			url: "http://localhost:11434/v1/embeddings",
			model: "bge-m3",
			apiKeyEnv: null,
			spaceId: null,
			dim: 1024,
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
			afterMessages: 25,
			afterToolCalls: 40,
			cooldownTurns: 15,
		},
		consolidation: {
			enabled: true,
			quietMs: 1_800_000,
			maxSteps: 12,
			maxNudges: 2,
			maxTranscriptChars: 20_000,
			promoteToCommon: true,
			review: {
				enabled: true,
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
