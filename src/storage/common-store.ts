/**
 * How a session reads and writes the common database while other sessions do
 * the same.
 *
 * The common database is the one file every pi session on the machine touches,
 * so its concurrency story has to be deliberate. It is:
 *
 * - **read through a read-only handle**, held open for the session. That takes
 *   a shared lock, so any number of terminals coexist and none of them blocks
 *   another. The price is snapshot isolation.
 * - **written under a short writer lease**, taken only for the moment of the
 *   write, followed immediately by `checkpoint()` so the neighbouring sessions
 *   can see it, and then by `refresh()` on our own reader - because without
 *   that last step a session does not see its own write. That one is easy to
 *   forget and presents as the memory losing a fact the moment after storing it.
 *
 * A lease can be nested: a logical operation that writes three facts takes one
 * lease and publishes once, rather than three leases and three snapshots.
 */

import { isLocked } from "./errors.ts";
import type {
	EdgeRef,
	FactCard,
	GuardedRememberResult,
	MemoryStats,
	RecallInput,
	RecallResult,
	RememberInput,
	RememberResult,
	ScanFilter,
	ScannedFact,
	TagPage,
	TagQuery,
	WritableMemory,
} from "./port.ts";

/** A writer that can be handed back when the lease ends. */
export interface LeasedWriter extends WritableMemory {
	close(): void;
}

export interface Reader {
	recall(input: RecallInput): Promise<RecallResult>;
	scan(filter?: ScanFilter): Promise<ScannedFact[]>;
	get(id: number): Promise<FactCard | null>;
	tagsOf(id: number): Promise<string[]>;
	listTags(query?: TagQuery): Promise<TagPage>;
	stats(): Promise<MemoryStats>;
	refresh(): boolean;
}

export interface CommonStoreOptions {
	/** Attempts to take the writer lock before giving up. */
	lockRetries?: number;
	/** Base backoff in milliseconds; doubled per attempt. */
	lockBackoffMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export class CommonMemoryBusyError extends Error {
	constructor() {
		super(
			"The shared memory is being written by another session right now. Try again " +
				"in a moment, or store this in the project memory instead.",
		);
		this.name = "CommonMemoryBusyError";
	}
}

export class CommonStore implements WritableMemory {
	/** Non-undefined exactly while a lease is held; that is the whole reentrancy check. */
	private writer: LeasedWriter | undefined;
	private readonly lockRetries: number;
	private readonly lockBackoffMs: number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(
		private readonly reader: Reader,
		private readonly openWriter: () => Promise<LeasedWriter>,
		options: CommonStoreOptions = {},
	) {
		this.lockRetries = options.lockRetries ?? 3;
		this.lockBackoffMs = options.lockBackoffMs ?? 40;
		this.sleep =
			options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
	}

	// -- reads go straight to the shared-lock handle ------------------------

	async recall(input: RecallInput): Promise<RecallResult> {
		return this.reader.recall(input);
	}

	async scan(filter: ScanFilter = {}): Promise<ScannedFact[]> {
		return this.reader.scan(filter);
	}

	async get(id: number): Promise<FactCard | null> {
		return this.reader.get(id);
	}

	async tagsOf(id: number): Promise<string[]> {
		return this.reader.tagsOf(id);
	}

	async listTags(query: TagQuery = {}): Promise<TagPage> {
		return this.reader.listTags(query);
	}

	async stats(): Promise<MemoryStats> {
		return this.reader.stats();
	}

	// -- writes take a lease -------------------------------------------------

	/**
	 * Runs `fn` under one writer lease, publishing once at the end.
	 *
	 * Nesting is by design: a caller that already holds the lease reuses it, so
	 * a three-write operation costs one lock acquisition and one snapshot.
	 */
	async withWriteLease<T>(
		fn: (writer: WritableMemory) => Promise<T>,
	): Promise<T> {
		// Already inside a lease: use it, and let the outermost call publish.
		if (this.writer !== undefined) return fn(this.writer);

		const writer = await this.acquire();
		this.writer = writer;
		try {
			return await fn(writer);
		} finally {
			this.writer = undefined;
			try {
				// Publish before releasing: an unpublished write is one the
				// neighbouring sessions cannot see, and the next session to
				// look would conclude it never happened.
				await writer.checkpoint();
			} finally {
				writer.close();
			}
			// See our own write. Without this the session that just stored a
			// fact cannot recall it.
			this.reader.refresh();
		}
	}

	/**
	 * Reclaims forgotten bytes under one lease.
	 *
	 * A lease and not a bare writer, for the same reason every other write takes
	 * one: another session may be holding it, and the lease already knows how to
	 * wait and how to give up. The lease publishes on the way out, which is what
	 * makes the smaller file visible to everyone else.
	 */
	async maintain(): Promise<void> {
		await this.withWriteLease((writer) => writer.maintain());
	}

	async remember(input: RememberInput): Promise<RememberResult> {
		return this.withWriteLease((writer) => writer.remember(input));
	}

	async rememberGuarded(input: RememberInput): Promise<GuardedRememberResult> {
		return this.withWriteLease((writer) => writer.rememberGuarded(input));
	}

	async revise(id: number, input: RememberInput): Promise<RememberResult> {
		return this.withWriteLease((writer) => writer.revise(id, input));
	}

	async forget(id: number): Promise<boolean> {
		return this.withWriteLease((writer) => writer.forget(id));
	}

	async link(edge: EdgeRef): Promise<void> {
		return this.withWriteLease((writer) => writer.link(edge));
	}

	async unlink(edge: Omit<EdgeRef, "provenance">): Promise<boolean> {
		return this.withWriteLease((writer) => writer.unlink(edge));
	}

	/**
	 * A no-op outside a lease.
	 *
	 * Every lease already publishes on the way out, so a caller asking for a
	 * checkpoint has already got one. Taking a fresh lock just to publish
	 * nothing would be a second chance to collide for no gain.
	 */
	async checkpoint(): Promise<void> {
		if (this.writer !== undefined) await this.writer.checkpoint();
	}

	private async acquire(): Promise<LeasedWriter> {
		let wait = this.lockBackoffMs;
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await this.openWriter();
			} catch (error) {
				// Only contention is worth retrying. Anything else is a real
				// fault and repeating it just delays the report.
				if (!isLocked(error) || attempt >= this.lockRetries) {
					if (isLocked(error)) throw new CommonMemoryBusyError();
					throw error;
				}
				await this.sleep(wait);
				wait *= 2;
			}
		}
	}
}
