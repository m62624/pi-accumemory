/**
 * A writable memory that publishes a snapshot after every write.
 *
 * A writer holds its changes in a journal until something checkpoints them, and
 * a read-only open sees only *published* generations. So a project database
 * that is written but never checkpointed cannot be read from anywhere else -
 * it rejects a read-only open outright with `PLUGMEM_NEEDS_CHECKPOINT`.
 *
 * That is not a theoretical concern: it is exactly what a cross-project
 * question hits. Asking "how did I do auth in api?" while a session is open in
 * `api` opens that database read-only, and without this wrapper the answer is
 * an error rather than the memory.
 *
 * The cost is small and known: a checkpoint writes a snapshot without fsync,
 * measured under 50 ms, and memory writes are rare compared to reads.
 */

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

export class CheckpointingStore implements WritableMemory {
	constructor(private readonly inner: WritableMemory) {}

	async remember(input: RememberInput): Promise<RememberResult> {
		return this.published(() => this.inner.remember(input));
	}

	async rememberGuarded(input: RememberInput): Promise<GuardedRememberResult> {
		return this.published(() => this.inner.rememberGuarded(input));
	}

	async revise(id: number, input: RememberInput): Promise<RememberResult> {
		return this.published(() => this.inner.revise(id, input));
	}

	async forget(id: number): Promise<boolean> {
		return this.published(() => this.inner.forget(id));
	}

	async link(edge: EdgeRef): Promise<void> {
		return this.published(() => this.inner.link(edge));
	}

	async unlink(edge: Omit<EdgeRef, "provenance">): Promise<boolean> {
		return this.published(() => this.inner.unlink(edge));
	}

	async recall(input: RecallInput): Promise<RecallResult> {
		return this.inner.recall(input);
	}

	async scan(filter?: ScanFilter): Promise<ScannedFact[]> {
		return this.inner.scan(filter);
	}

	async get(id: number): Promise<FactCard | null> {
		return this.inner.get(id);
	}

	async tagsOf(id: number): Promise<string[]> {
		return this.inner.tagsOf(id);
	}

	async listTags(query?: TagQuery): Promise<TagPage> {
		return this.inner.listTags(query);
	}

	async stats(): Promise<MemoryStats> {
		return this.inner.stats();
	}

	/**
	 * Reclaims the bytes of everything forgotten, then publishes.
	 *
	 * Forwarded rather than left off the wrapper: this is the handle the session
	 * writes through, so it is the only one that can compact what the session
	 * removed.
	 */
	async maintain(): Promise<void> {
		await this.inner.maintain();
	}

	async checkpoint(): Promise<void> {
		return this.inner.checkpoint();
	}

	/**
	 * Runs the write, then publishes.
	 *
	 * The result is returned even if publishing fails: the fact IS stored at
	 * that point, and reporting a failure would tell the model to store it
	 * again. An unpublished write is a visibility problem, not a lost one.
	 */
	private async published<T>(write: () => Promise<T>): Promise<T> {
		const result = await write();
		try {
			await this.inner.checkpoint();
		} catch {
			// See above: the write landed. Publication can wait for the next one.
		}
		return result;
	}
}
