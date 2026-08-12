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
	/**
	 * Whether the engine's duplicate detector had anything to compare against.
	 *
	 * `false` means the fact was written with no guard at all. The detector is
	 * scoped to the fact's entity and walks that entity's recent live facts, so
	 * a write naming no entity has an empty candidate set and cannot be
	 * refused - now or after any number of later writes.
	 *
	 * This extension always names an entity, so `false` here is a defect on our
	 * side rather than a caller's choice, and it is the exact defect that once
	 * let one sentence be stored six times. It is surfaced rather than ignored
	 * for that reason. Available from plugmem 0.10.0.
	 */
	checked: boolean;
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
	/**
	 * Stored vector slots.
	 *
	 * Fewer of these than facts, with an embedder configured, means part of the
	 * memory has no vectors - the silent state after switching the embedder on
	 * over an existing database. Semantic recall then answers from a fraction
	 * of what is stored and says nothing about it.
	 */
	vectors: number;
	/**
	 * Records that are forgotten but not yet physically purged.
	 *
	 * `forget` sets a tombstone: the fact leaves recall at once, and its bytes
	 * leave at the next `maintain`. Until then it is still counted by `facts`,
	 * which is why anything reporting a size to a person or to the model has to
	 * subtract these - otherwise a memory that has just been tidied claims to
	 * hold more than it did before.
	 */
	tombstones: number;
}

/**
 * Live facts: what a recall can actually return.
 *
 * Clamped at zero rather than trusted. The two numbers come from the engine
 * separately, and a report that reads "-3 facts" because they disagreed for a
 * moment is worse than one that reads "0".
 */
export function liveFacts(stats: MemoryStats): number {
	return Math.max(0, stats.facts - stats.tombstones);
}

export interface EdgeRef {
	src: string;
	rel: string;
	dst: string;
	/** The fact this edge follows from — the answer to "why is it here". */
	provenance?: number;
}

/** One fact as an enumeration returns it: no score, no ranking. */
export interface ScannedFact {
	id: number;
	text: string;
	tags: string[];
	metadata: Record<string, string>;
}

export interface ScanFilter {
	/** Keep only facts carrying all of these. */
	tags?: string[];
	/**
	 * Start at this fact id rather than at the beginning.
	 *
	 * Ids are assigned in order and never reused, so this is also "start at
	 * this point in time".
	 */
	from?: number;
	/**
	 * Stop after this many, without reading the rest.
	 *
	 * Not a nicety at any real size. The engine pages at 128 facts and answers
	 * a page in 0.3 ms; walking to the end of ten thousand facts costs 23 ms
	 * and builds ten thousand JavaScript objects to throw all but twelve of
	 * them away. Anything that wants a window must say so.
	 */
	limit?: number;
}

/** Read verbs. A read-only handle offers exactly these. */
export interface ReadableMemory {
	recall(input: RecallInput): Promise<RecallResult>;
	/**
	 * Every live fact, optionally filtered by tag.
	 *
	 * Separate from `recall` because it answers a different question, and
	 * because `recall` cannot answer this one: a recall needs a retrieval
	 * *source* - query text, anchor entities or a time range - and tags are
	 * only a filter over what a source produced. Asking `recall` for "every
	 * fact tagged route" returns nothing at all, silently. Verified against
	 * the engine, and the reason enumeration has its own verb.
	 */
	scan(filter?: ScanFilter): Promise<ScannedFact[]>;
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
	/**
	 * Forgets several facts as one write, answering per id in order.
	 *
	 * Not a loop over `forget` written shorter. Every single forget syncs the
	 * journal and runs the engine's post-write policy, and on the shared memory
	 * it also takes and releases the cross-session lease and publishes a
	 * snapshot - so clearing four duplicates paid all of that four times. Here
	 * it is paid once.
	 *
	 * The ordering guarantee is what lets a caller zip the answers back onto
	 * the ids it read the text of beforehand, which is the only way anyone can
	 * still be told what went away.
	 */
	forgetMany(ids: readonly number[]): Promise<boolean[]>;
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
	/**
	 * Physically reclaims the bytes of everything forgotten.
	 *
	 * `forget` only sets a tombstone: the fact leaves recall at once and its
	 * record, vector slot and postings stay until a maintenance pass. Nothing
	 * schedules one - plugmem's own trigger is off by default - so a memory that
	 * is never maintained only grows. Measured: a thousand facts with five
	 * hundred forgotten stayed at 1278 KB until compaction took it to 674 KB.
	 *
	 * Not cheap (it is O(database)), which is why the idle pass is where it is
	 * called from rather than every write.
	 */
	maintain(): Promise<void>;
}
