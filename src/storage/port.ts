/**
 * The memory port: the shape everything above the storage layer talks to.
 *
 * It mirrors plugmem's verbs closely — there is no cleverness to add over a
 * fact store, and a port that renames things only makes the real API harder to
 * find. What it buys is that every module above it can be tested against an
 * in-memory fake, so the native addon is exercised by a handful of integration
 * tests rather than by all of them.
 *
 * Note the two absences. There is no `open`, because opening is the lifecycle
 * concern of the layer below, and no cross-database search, because plugmem
 * deliberately has none: a fact filed in the wrong database is lost, not merely
 * misplaced, and an API that papered over that would hide the cost of the
 * mistake instead of preventing it.
 */

/** A typed edge: `entity` gains relation `rel`. */
export interface LinkRef {
	rel: string;
	entity: string;
}

export interface RememberInput {
	text: string;
	entity?: string;
	tags?: string[];
	links?: LinkRef[];
	/**
	 * Opaque key→value pairs. Paths stored here are always canonical and
	 * relative (see `paths/path-codec.ts`): the database has to be readable on
	 * the other operating system too.
	 */
	metadata?: Record<string, string>;
	/** Truth-axis start, unix ms. Defaults to the moment of recording. */
	validFrom?: number;
}

export interface SimilarFact {
	id: number;
	score: number;
	reason: string;
}

export interface RememberResult {
	id: number;
	similar: SimilarFact[];
}

export interface GuardedRememberResult {
	status: "stored" | "blocked";
	id?: number;
	similar: SimilarFact[];
}

export interface RecallInput {
	query?: string;
	tags?: string[];
	entities?: string[];
	k?: number;
	tokenBudget?: number;
	graphDepth?: number;
	/** "What was true at" this instant, unix ms. */
	asOf?: number;
}

export interface RecalledFact {
	id: number;
	score: number;
	recordedAt: number;
	validFrom: number;
	validTo: number;
}

export interface RecallResult {
	/** The prompt-ready block; empty when nothing matched. */
	rendered: string;
	facts: RecalledFact[];
	truncated: boolean;
}

export interface FactCard {
	id: number;
	text: string;
	tags: string[];
	metadata: Record<string, string>;
	recordedAt: number;
	validFrom: number;
	validTo: number;
}

export interface TagCount {
	name: string;
	count: number;
}

export interface TagPage {
	items: TagCount[];
	nextCursor?: string;
}

export interface TagQuery {
	prefix?: string;
	cursor?: string;
	limit?: number;
}

export interface MemoryStats {
	facts: number;
	entities: number;
	edges: number;
}

export interface EdgeRef {
	src: string;
	rel: string;
	dst: string;
	/** The fact this edge follows from — the answer to "why is it here". */
	provenance?: number;
}

/** Read verbs. A read-only handle offers exactly these. */
export interface ReadableMemory {
	recall(input: RecallInput): Promise<RecallResult>;
	get(id: number): Promise<FactCard | null>;
	tagsOf(id: number): Promise<string[]>;
	listTags(query?: TagQuery): Promise<TagPage>;
	stats(): Promise<MemoryStats>;
}

/** Read and write verbs. */
export interface WritableMemory extends ReadableMemory {
	remember(input: RememberInput): Promise<RememberResult>;
	/** Stores only when the duplicate detector finds no close live fact. */
	rememberGuarded(input: RememberInput): Promise<GuardedRememberResult>;
	revise(id: number, input: RememberInput): Promise<RememberResult>;
	forget(id: number): Promise<boolean>;
	link(edge: EdgeRef): Promise<void>;
	unlink(edge: Omit<EdgeRef, "provenance">): Promise<boolean>;
	/**
	 * Publishes a snapshot.
	 *
	 * The one verb here that is not about content. A read-only handle in
	 * another session sees only published generations, so a write nobody
	 * checkpointed is a write the rest of the machine cannot see.
	 */
	checkpoint(): Promise<void>;
}
