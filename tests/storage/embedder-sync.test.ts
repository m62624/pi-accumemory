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
}): Reembeddable & { reembeds: number; checkpoints: number } {
	let reembeds = 0;
	let checkpoints = 0;
	let recallError = options.recallError;
	return {
		get reembeds() {
			return reembeds;
		},
		get checkpoints() {
			return checkpoints;
		},
		recall: async () => {
			if (recallError !== undefined) throw recallError;
			return {};
		},
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
		const target = store({ recallError: mismatchError(), facts: 10 });
		const result = await syncVectorSpace(target, {
			embedderEnabled: false,
			label: "this project",
		});
		expect(result.action).toBe("none");
		expect(target.reembeds).toBe(0);
	});

	it("does nothing when the vectors already agree", async () => {
		const target = store({ facts: 10, vectors: 10 });
		expect(
			(await syncVectorSpace(target, { embedderEnabled: true, label: "x" }))
				.action,
		).toBe("none");
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
			embedderEnabled: true,
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
			embedderEnabled: true,
			label: "x",
		});
		expect(result.action).toBe("backfilled");
		expect(target.reembeds).toBe(1);
	});

	it("leaves an empty memory alone", async () => {
		const target = store({ facts: 0, vectors: 0 });
		expect(
			(await syncVectorSpace(target, { embedderEnabled: true, label: "x" }))
				.action,
		).toBe("none");
		expect(target.reembeds).toBe(0);
	});

	it("only reports when automatic rebuilding is switched off", async () => {
		const target = store({
			recallError: mismatchError(),
			facts: 5,
			vectors: 5,
		});
		const result = await syncVectorSpace(target, {
			embedderEnabled: true,
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
			embedderEnabled: true,
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
			embedderEnabled: true,
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
			embedderEnabled: true,
			label: "x",
		});
		expect(result.action).toBe("none");
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
		};
		await expect(
			syncVectorSpace(hostile, { embedderEnabled: true, label: "x" }),
		).resolves.toBeDefined();
	});
});
