/**
 * The complete settings document with its defaults.
 *
 * Written out in full rather than assembled from fragments so no key's nesting
 * is ever a guess — this object is the one SETTINGS.md publishes, and a test
 * holds the two in sync.
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
	 * Written into the database file at creation. A database refuses to open
	 * under a different dim, so changing this needs a reembed.
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

export interface ConsolidationSettings {
	enabled: boolean;
	quietMs: number;
	maxSteps: number;
	maxNudges: number;
	maxTranscriptChars: number;
	promoteToCommon: boolean;
}

export interface Settings {
	timezone: string | null;
	memory: {
		enabled: boolean;
		recallTokenBudget: number;
		/** 0 leaves the engine's own default in charge. */
		recallK: number;
		graphDepth: number | null;
		manifest: boolean;
		queryMaxChars: number;
		refresh: RefreshSettings;
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
		recallTokenBudget: 512,
		recallK: 0,
		graphDepth: null,
		manifest: true,
		queryMaxChars: 600,
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
		},
		crossProject: {
			enabled: true,
		},
	},
}) as Settings;
