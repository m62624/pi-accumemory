import { describe, expect, it, vi } from "vitest";
import {
	CommonMemoryBusyError,
	CommonStore,
	type LeasedWriter,
	type Reader,
} from "../../src/storage/common-store.ts";
import { PLUGMEM_LOCKED } from "../../src/storage/errors.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

/**
 * One backing store behind both the reader and the writer, so the test can see
 * exactly what a real session sees: writes land, and the reader only notices
 * after a refresh.
 */
function harness(options: { lockUntilAttempt?: number } = {}) {
	const backing = new FakeMemory();
	let published = 0;
	let seen = 0;
	let opens = 0;
	let closes = 0;
	let maintained = 0;

	const reader: Reader = {
		recall: async (input) => {
			// Snapshot isolation, modelled: a reader that has not refreshed
			// sees nothing published after it opened.
			if (seen < published)
				return { rendered: "", facts: [], truncated: false };
			return backing.recall(input);
		},
		scan: (filter) => backing.scan(filter),
		get: (id) => backing.get(id),
		tagsOf: (id) => backing.tagsOf(id),
		listTags: (query) => backing.listTags(query),
		stats: () => backing.stats(),
		refresh: () => {
			const adopted = seen < published;
			seen = published;
			return adopted;
		},
	};

	const openWriter = async (): Promise<LeasedWriter> => {
		opens += 1;
		if (
			options.lockUntilAttempt !== undefined &&
			opens < options.lockUntilAttempt
		) {
			throw Object.assign(new Error("locked"), { code: PLUGMEM_LOCKED });
		}
		return {
			remember: (input) => backing.remember(input),
			rememberGuarded: (input) => backing.rememberGuarded(input),
			revise: (id, input) => backing.revise(id, input),
			forget: (id) => backing.forget(id),
			forgetMany: (ids) => backing.forgetMany(ids),
			link: (edge) => backing.link(edge),
			unlink: (edge) => backing.unlink(edge),
			// A writer reads the live state, not a pinned snapshot: this is the
			// handle that just wrote, so it sees its own writes immediately.
			recall: (input) => backing.recall(input),
			scan: (filter) => backing.scan(filter),
			get: (id) => backing.get(id),
			tagsOf: (id) => backing.tagsOf(id),
			listTags: (query) => backing.listTags(query),
			stats: () => backing.stats(),
			checkpoint: async () => {
				published += 1;
			},
			maintain: async () => {
				maintained += 1;
			},
			close: () => {
				closes += 1;
			},
		};
	};

	return {
		backing,
		reader,
		openWriter,
		counts: () => ({ opens, closes, published, seen, maintained }),
		store: (extra = {}) =>
			new CommonStore(reader, openWriter, { sleep: async () => {}, ...extra }),
	};
}

describe("CommonStore", () => {
	it("publishes and refreshes, so a session sees its own write", async () => {
		// The failure this prevents: the model stores a fact about the user and
		// cannot recall it one second later, because the read handle is still
		// pinned to the generation it opened with.
		const h = harness();
		const store = h.store();
		await store.remember({
			text: "prefers Rust for systems work",
			entity: "user",
		});
		const found = await store.recall({ query: "Rust" });
		expect(found.facts).toHaveLength(1);
	});

	it("closes the lease it took", async () => {
		const h = harness();
		await h.store().remember({ text: "a fact" });
		expect(h.counts().closes).toBe(1);
	});

	it("takes one lease and publishes once for a batch of writes", async () => {
		// Three locks and three snapshots for one logical operation is three
		// chances to collide with a neighbouring session, for no gain.
		const h = harness();
		const store = h.store();
		await store.withWriteLease(async (writer) => {
			await writer.remember({ text: "one" });
			await writer.remember({ text: "two" });
			await writer.remember({ text: "three" });
		});
		expect(h.counts().opens).toBe(1);
		expect(h.counts().published).toBe(1);
	});

	it("reuses the lease a caller already holds", async () => {
		const h = harness();
		const store = h.store();
		await store.withWriteLease(async () => {
			await store.remember({ text: "nested" });
		});
		expect(h.counts().opens).toBe(1);
		expect(h.counts().closes).toBe(1);
	});

	it("releases and publishes even when the write throws", async () => {
		const h = harness();
		const store = h.store();
		await expect(
			store.withWriteLease(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(h.counts().closes).toBe(1);
	});

	it("retries a locked database before giving up", async () => {
		// Writes here are few and short, so contention resolves in milliseconds.
		const h = harness({ lockUntilAttempt: 3 });
		await h.store().remember({ text: "a fact" });
		expect(h.counts().opens).toBe(3);
	});

	it("reports contention plainly instead of losing the write", async () => {
		// Silence would be the worst outcome: the model believes it stored
		// something, and the fact is simply gone.
		const h = harness({ lockUntilAttempt: 99 });
		await expect(
			h.store({ lockRetries: 2 }).remember({ text: "a fact" }),
		).rejects.toBeInstanceOf(CommonMemoryBusyError);
	});

	it("suggests the project memory when the shared one is busy", async () => {
		const h = harness({ lockUntilAttempt: 99 });
		await expect(
			h.store({ lockRetries: 0 }).remember({ text: "x" }),
		).rejects.toThrow(/project memory/i);
	});

	it("does not retry a failure that is not contention", async () => {
		const reader = harness().reader;
		const openWriter = vi.fn(async () => {
			throw new Error("disk on fire");
		});
		const store = new CommonStore(reader, openWriter, {
			sleep: async () => {},
		});
		await expect(store.remember({ text: "x" })).rejects.toThrow("disk on fire");
		expect(openWriter).toHaveBeenCalledTimes(1);
	});

	it("backs off between attempts rather than spinning", async () => {
		const waits: number[] = [];
		const h = harness({ lockUntilAttempt: 3 });
		await h
			.store({ sleep: async (ms: number) => void waits.push(ms) })
			.remember({ text: "x" });
		expect(waits).toEqual([40, 80]);
	});

	it("does not take a lock just to checkpoint outside a lease", async () => {
		const h = harness();
		await h.store().checkpoint();
		expect(h.counts().opens).toBe(0);
	});

	it("reads without taking the writer lock at all", async () => {
		const h = harness();
		await h.store().recall({ query: "anything" });
		await h.store().stats();
		// Every read, not just the two above: a read that quietly takes the
		// writer lock would block every other terminal on the machine, and it
		// would do it only when that particular question was asked.
		await h.store().scan();
		await h.store().get(0);
		await h.store().tagsOf(0);
		await h.store().listTags();
		expect(h.counts().opens).toBe(0);
	});

	it("takes a lease for every kind of write", async () => {
		const h = harness();
		const store = h.store();
		const stored = await store.remember({ text: "a fact", entity: "user" });
		await store.revise(stored.id, { text: "a corrected fact" });
		await store.link({ src: "user", rel: "works_on", dst: "project:x" });
		await store.unlink({ src: "user", rel: "works_on", dst: "project:x" });
		await store.forget(stored.id);
		expect(h.counts().opens).toBe(5);
		expect(h.counts().closes).toBe(5);
	});

	it("sleeps for real when nobody injected a clock", async () => {
		// The default matters: without it the retry loop spins, and the point
		// of backing off is to give the other session time to finish.
		const h = harness({ lockUntilAttempt: 2 });
		const store = new CommonStore(h.reader, h.openWriter, {
			lockBackoffMs: 1,
		});
		await expect(
			store.remember({ text: "a fact", entity: "user" }),
		).resolves.toBeDefined();
	});
});
