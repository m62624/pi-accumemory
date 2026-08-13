/**
 * Keeping stored vectors in step with the configured embedder.
 *
 * The two states this repairs were both measured against the real engine:
 *
 * - a changed semantic space makes text recall and text remember fail loudly
 *   (`vector space mismatch`), while enumeration, graph recall and forget keep
 *   working. Content is safe; the two paths this extension leans on are not.
 * - vectors missing entirely - the embedder switched on over an older database
 *   - fails nothing at all. Recall just answers from the fraction that has
 *   vectors, and says nothing.
 */

import { describe, expect, it } from "vitest";
import {
	PLUGMEM_ENGINE,
	type Reembeddable,
	syncVectorSpace,
} from "../../src/storage/embedder-sync.ts";
import type { EmbedderState } from "../../src/storage/port.ts";

function mismatchError(): Error {
	return Object.assign(
		new Error(
			'vector space mismatch: stored "nomic-embed-text", requested "bge-m3"; run an explicit reembed',
		),
		{ code: PLUGMEM_ENGINE },
	);
}

function store(options: {
	recallError?: Error;
	facts?: number;
	vectors?: number;
	reembedError?: Error;
	/** What the engine says about the embedder; `active` unless a test says otherwise. */
	state?: EmbedderState;
	/** The state AFTER the probe, which is how a degrade suspension shows up. */
	stateAfterProbe?: EmbedderState;
}): Reembeddable & { reembeds: number; checkpoints: number } {
	let reembeds = 0;
	let checkpoints = 0;
	let probed = false;
	let recallError = options.recallError;
	return {
		get reembeds() {
			return reembeds;
		},
		get checkpoints() {
			return checkpoints;
		},
		recall: async () => {
			probed = true;
			if (recallError !== undefined) throw recallError;
			return {};
		},
		embedderState: () =>
			(probed ? options.stateAfterProbe : undefined) ??
			options.state ??
			"active",
		stats: async () => ({
			facts: options.facts ?? 0,
			entities: 0,
			edges: 0,
			vectors: options.vectors ?? 0,
			tombstones: 0,
		}),
		reembed: async () => {
			reembeds += 1;
			if (options.reembedError !== undefined) throw options.reembedError;
			// A successful rebuild is what clears the mismatch.
			recallError = undefined;
		},
		checkpoint: async () => {
			checkpoints += 1;
		},
	};
}

describe("syncVectorSpace", () => {
	it("does nothing at all when there is no embedder", async () => {
		// Asked of the engine, not of our settings: the answer lives in the
		// config file plugmem read, which this extension does not parse.
		const target = store({
			recallError: mismatchError(),
			facts: 10,
			state: "absent",
		});
		const result = await syncVectorSpace(target, {
			label: "this project",
		});
		expect(result.action).toBe("none");
		expect(target.reembeds).toBe(0);
	});

	it("does nothing when the vectors already agree", async () => {
		const target = store({ facts: 10, vectors: 10 });
		expect((await syncVectorSpace(target, { label: "x" })).action).toBe("none");
		expect(target.reembeds).toBe(0);
	});

	it("rebuilds when the semantic space changed", async () => {
		// Until this runs, every text lookup and every text write fails.
		const target = store({
			recallError: mismatchError(),
			facts: 42,
			vectors: 42,
		});
		const result = await syncVectorSpace(target, {
			label: "this project",
		});
		expect(result.action).toBe("space-changed");
		expect(target.reembeds).toBe(1);
		expect(target.checkpoints).toBe(1);
		expect(result.notice).toContain("42");
		expect(result.notice).toMatch(/nothing was lost/i);
	});

	it("fills in vectors that were never computed", async () => {
		// The quiet case: nothing errors, recall just answers from part of the
		// memory and reports nothing.
		const target = store({ facts: 10, vectors: 3 });
		const result = await syncVectorSpace(target, {
			label: "x",
		});
		expect(result.action).toBe("backfilled");
		expect(target.reembeds).toBe(1);
	});

	it("leaves an empty memory alone", async () => {
		const target = store({ facts: 0, vectors: 0 });
		expect((await syncVectorSpace(target, { label: "x" })).action).toBe("none");
		expect(target.reembeds).toBe(0);
	});

	it("only reports when automatic rebuilding is switched off", async () => {
		const target = store({
			recallError: mismatchError(),
			facts: 5,
			vectors: 5,
		});
		const result = await syncVectorSpace(target, {
			autoReembed: false,
			label: "this project",
		});
		expect(result.action).toBe("space-changed");
		expect(target.reembeds).toBe(0);
		expect(result.notice).toContain("/longterm-reembed");
	});

	it("reports missing vectors without rebuilding when told not to", async () => {
		const target = store({ facts: 10, vectors: 4 });
		const result = await syncVectorSpace(target, {
			autoReembed: false,
			label: "x",
		});
		expect(result.notice).toContain("6 facts");
		expect(target.reembeds).toBe(0);
	});

	it("says a failed rebuild is resumable, because it is", async () => {
		// Each fact is rebuilt in place, so whatever finished keeps its new
		// vectors and running it again completes the job.
		const target = store({
			recallError: mismatchError(),
			facts: 5,
			vectors: 5,
			reembedError: new Error("the embedding service is unreachable"),
		});
		const result = await syncVectorSpace(target, {
			label: "x",
		});
		expect(result.action).toBe("failed");
		expect(result.notice).toContain("unreachable");
		expect(result.notice).toMatch(/run it again|finish/i);
	});

	it("does nothing when the probe failed for an unrelated reason", async () => {
		// Guessing "mismatch" would rebuild for no reason; guessing "fine" would
		// leave an unusable memory in place. Neither guess is acceptable.
		const target = store({
			recallError: Object.assign(new Error("disk on fire"), {
				code: "PLUGMEM_OPEN",
			}),
			facts: 10,
			vectors: 0,
		});
		const result = await syncVectorSpace(target, {
			label: "x",
		});
		expect(result.action).toBe("none");
		expect(target.reembeds).toBe(0);
	});

	it("reports an unreachable provider instead of trying to rebuild", async () => {
		// `degrade` answers the probe without a vector and suspends the
		// embedder, and a reembed refuses while it is suspended - so the only
		// correct move is to say so and leave the vectors alone.
		const target = store({
			facts: 10,
			vectors: 3,
			stateAfterProbe: "suspended",
		});
		const result = await syncVectorSpace(target, { label: "this project" });
		expect(result.action).toBe("suspended");
		expect(target.reembeds).toBe(0);
		expect(result.notice).toMatch(/not answering/i);
		expect(result.notice).toContain("/longterm-reembed");
	});

	it("does not mistake a suspension for a changed model", async () => {
		// Both end in "meaning-based search is not working", and the repairs are
		// opposite: one rebuilds every vector, the other must not touch them.
		const target = store({
			recallError: mismatchError(),
			facts: 5,
			vectors: 5,
			stateAfterProbe: "suspended",
		});
		const result = await syncVectorSpace(target, { label: "x" });
		expect(result.action).toBe("suspended");
		expect(target.reembeds).toBe(0);
	});

	it("never throws, whatever the store does", async () => {
		const hostile: Reembeddable = {
			recall: async () => {
				throw mismatchError();
			},
			stats: async () => {
				throw new Error("stats exploded");
			},
			reembed: async () => {
				throw new Error("reembed exploded");
			},
			checkpoint: async () => {
				throw new Error("checkpoint exploded");
			},
			embedderState: () => {
				throw new Error("embedderState exploded");
			},
		};
		await expect(
			syncVectorSpace(hostile, { label: "x" }),
		).resolves.toBeDefined();
	});
});
