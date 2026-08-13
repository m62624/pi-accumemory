/**
 * Keeping the stored vectors in step with the configured embedder, without the
 * user having to know that is a thing.
 *
 * Three ways they fall out of step, and they fail very differently:
 *
 * 1. **The semantic space changed** - a different model, or a different
 *    `space_id`. plugmem guards this properly and loudly, and nothing is lost;
 *    measured against the engine, the split is exact:
 *
 *    - `open` succeeds, on a writer and on a read-only handle alike;
 *    - a recall WITH TEXT and a remember WITH TEXT fail with
 *      `vector space mismatch`, naming the stored and the requested space;
 *    - everything that does not touch the vector axis keeps working - graph
 *      recall, `exportPage`, `stats`, `get`, `tagsOf`, `listTags`, `forget`,
 *      `link`, `verify`, `maintain`.
 *
 *    So the content is safe and recovery is possible - which is a good argument
 *    for the engine NOT failing at `open`. What it costs is the two paths this
 *    extension is built on, and you only find out at the first lookup.
 * 2. **Vectors are missing** - the embedder was switched on over a database
 *    built without one, or with `dim: 0`. Nothing errors. The old facts simply
 *    have no vectors, so meaning-based recall answers from a fraction of the
 *    memory and reports nothing. This is the quietest and most misleading of
 *    the three.
 * 3. **The provider is unreachable** - with `on_error = "degrade"`, plugmem
 *    stores and answers without the vector and suspends the embedder instead of
 *    failing the call. Nothing is damaged, and the facts written meanwhile land
 *    in exactly the state case 2 describes, so the same repair finishes the job
 *    once the provider is back. What must NOT happen is repairing it now: a
 *    reembed refuses while the embedder is suspended.
 *
 * All three are repaired by the same operation, and the repair is idempotent: a
 * reembed that was interrupted leaves the facts it finished with their new
 * vectors, so running it again simply completes the job.
 *
 * Detection reads the DATABASE, not our own bookkeeping. A state file recording
 * "what we configured last time" drifts the moment somebody edits config.toml,
 * restores a backup, or copies a database between machines - and it drifts
 * towards "everything is fine", which is the wrong direction.
 */

import { isVectorSpaceMismatch, PLUGMEM_ENGINE } from "./errors.ts";
import type { EmbedderState, MemoryStats } from "./port.ts";

export { PLUGMEM_ENGINE };

/** The subset of a store this needs; keeps the module testable with a fake. */
export interface Reembeddable {
	recall(input: { query?: string; k?: number }): Promise<unknown>;
	stats(): Promise<MemoryStats>;
	reembed(): Promise<void>;
	checkpoint(): Promise<void>;
	embedderState(): EmbedderState;
}

export type VectorSyncAction =
	| "none"
	| "space-changed"
	| "backfilled"
	| "suspended"
	| "failed";

export interface VectorSyncResult {
	action: VectorSyncAction;
	/** One sentence for the user; empty when nothing happened. */
	notice: string;
}

export interface VectorSyncOptions {
	/** Set false to detect and report without rebuilding. */
	autoReembed?: boolean;
	/** Names the database in the notice. */
	label: string;
}

/**
 * Checks one database and repairs it if needed.
 *
 * Never throws: a memory that cannot be repaired is a memory that works worse,
 * and taking the session down over it would be the extension deciding it
 * matters more than the work.
 */
export async function syncVectorSpace(
	store: Reembeddable,
	options: VectorSyncOptions,
): Promise<VectorSyncResult> {
	// Asked of the engine rather than taken from settings: what matters here is
	// whether an embedder is actually there, and the answer to that lives in the
	// config file plugmem read, not in ours.
	if (embedderState(store) === "absent") {
		return { action: "none", notice: "" };
	}
	const autoReembed = options.autoReembed ?? true;

	const mismatched = await hasSpaceMismatch(store);
	if (mismatched === "unknown") return { action: "none", notice: "" };

	// The probe above is a real embedding call, so an unreachable provider has
	// just been discovered by it and, under `on_error = "degrade"`, suspended.
	// Rebuilding now is not an option the engine offers - a reembed refuses
	// while suspended rather than publishing half a vector space - and it would
	// be the wrong thing to want anyway.
	if (embedderState(store) === "suspended") {
		return {
			action: "suspended",
			notice:
				`The embedding service is not answering, so ${options.label} works without vectors for now: ` +
				"facts are still stored and still found by wording, just not by meaning. It retries by " +
				"itself, and /longterm-reembed fills in what was missed.",
		};
	}

	if (mismatched === "yes") {
		if (!autoReembed) {
			return {
				action: "space-changed",
				notice:
					`The embedding model for ${options.label} changed, so its stored vectors no ` +
					"longer match and every memory lookup will fail. Run /longterm-reembed to " +
					"rebuild them.",
			};
		}
		return rebuild(
			store,
			options.label,
			"space-changed",
			(count) =>
				`The embedding model changed, so ${options.label} was rebuilt (${count} facts). ` +
				"Nothing was lost.",
		);
	}

	// No mismatch, but possibly nothing embedded yet.
	const stats = await safeStats(store);
	if (
		stats === undefined ||
		stats.facts === 0 ||
		stats.vectors >= stats.facts
	) {
		return { action: "none", notice: "" };
	}
	if (!autoReembed) {
		return {
			action: "backfilled",
			notice:
				`${options.label} has ${stats.facts - stats.vectors} facts with no vectors, so ` +
				"meaning-based recall only sees part of it. Run /longterm-reembed to fill them in.",
		};
	}
	return rebuild(
		store,
		options.label,
		"backfilled",
		(count) =>
			`The embedder is newly available, so ${options.label} was filled in (${count} facts).`,
	);
}

async function rebuild(
	store: Reembeddable,
	label: string,
	action: VectorSyncAction,
	describe: (count: number) => string,
): Promise<VectorSyncResult> {
	const before = await safeStats(store);
	try {
		await store.reembed();
		await store.checkpoint();
		return { action, notice: describe(before?.facts ?? 0) };
	} catch (error) {
		// Partial by construction: whatever was rebuilt keeps its new vectors,
		// so saying "run it again" is honest advice rather than a shrug.
		return {
			action: "failed",
			notice:
				`Rebuilding the vectors for ${label} failed: ${message(error)}. Whatever was ` +
				"already rebuilt keeps its new vectors; run /longterm-reembed to finish. " +
				"Until then, memory lookups in it may fail.",
		};
	}
}

/**
 * Whether the stored vectors disagree with the configured space.
 *
 * Asked by making the cheapest possible query and seeing whether the engine
 * objects, because that is the only place the answer exists - `stats()` reports
 * how many vectors there are, not which space they belong to.
 *
 * Returns `"unknown"` when the probe failed for some unrelated reason. Guessing
 * either way would be worse: guessing "mismatch" triggers a needless rebuild,
 * and guessing "fine" leaves a dead memory in place.
 */
async function hasSpaceMismatch(
	store: Reembeddable,
): Promise<"yes" | "no" | "unknown"> {
	try {
		await store.recall({ query: "probe", k: 1 });
		return "no";
	} catch (error) {
		return isVectorSpaceMismatch(error) ? "yes" : "unknown";
	}
}

/**
 * The engine's own answer, and `absent` when it cannot be asked.
 *
 * Treating an unanswerable question as "no embedder" keeps this module doing
 * nothing rather than doing something on a guess, which is the same rule as
 * {@link hasSpaceMismatch}'s `"unknown"`.
 */
function embedderState(store: Reembeddable): EmbedderState {
	try {
		return store.embedderState();
	} catch {
		return "absent";
	}
}

async function safeStats(
	store: Reembeddable,
): Promise<MemoryStats | undefined> {
	try {
		return await store.stats();
	} catch {
		return undefined;
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
