/**
 * The adapter over the plugmem addon.
 *
 * It is thin on purpose: translate the port's shapes to plugmem's and back, and
 * hold nothing back. The value here is not abstraction, it is that everything
 * above this file can be driven by a fake, so the native addon is exercised by
 * a handful of integration tests instead of by all of them.
 *
 * The one piece of judgement is {@link openReadable}'s checkpoint fallback,
 * which is not optional: without it, the first session on a clean machine
 * cannot open the common database at all.
 */

import { Plugmem } from "plugmem";
import { defined } from "../tools/args.ts";
import { needsCheckpoint } from "./errors.ts";
import type {
	EdgeRef,
	FactCard,
	GuardedRememberResult,
	MemoryStats,
	ReadableMemory,
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

export interface OpenOptions {
	/** Embedding width; written into the file at creation. */
	dim?: number;
	/** Path to the generated `config.toml`. */
	config?: string;
}

/** A writable handle. Holds the file's exclusive lock until closed. */
export class PlugmemStore implements WritableMemory {
	constructor(private readonly db: Plugmem) {}

	static async open(
		path: string,
		options: OpenOptions = {},
	): Promise<PlugmemStore> {
		return new PlugmemStore(await Plugmem.open(path, toOpenOptions(options)));
	}

	async remember(input: RememberInput): Promise<RememberResult> {
		const outcome = await this.db.remember(toRememberArgs(input));
		return { id: outcome.id, similar: outcome.similar };
	}

	async rememberGuarded(input: RememberInput): Promise<GuardedRememberResult> {
		const outcome = await this.db.rememberGuarded(toRememberArgs(input));
		return {
			status: outcome.status,
			id: outcome.outcome?.id,
			similar: outcome.similar,
			checked: outcome.checked,
		};
	}

	async revise(id: number, input: RememberInput): Promise<RememberResult> {
		const outcome = await this.db.revise(id, toRememberArgs(input));
		return { id: outcome.id, similar: outcome.similar };
	}

	async forget(id: number): Promise<boolean> {
		return this.db.forget(id);
	}

	async link(edge: EdgeRef): Promise<void> {
		await this.db.link({
			src: edge.src,
			rel: edge.rel,
			dst: edge.dst,
			...defined({ provenance: edge.provenance }),
		});
	}

	async unlink(edge: Omit<EdgeRef, "provenance">): Promise<boolean> {
		return this.db.unlink({ src: edge.src, rel: edge.rel, dst: edge.dst });
	}

	async recall(input: RecallInput): Promise<RecallResult> {
		return recallVia(this.db, input);
	}

	async scan(filter: ScanFilter = {}): Promise<ScannedFact[]> {
		return scanVia(this.db, filter);
	}

	async get(id: number): Promise<FactCard | null> {
		return cardOf(this.db, id);
	}

	async tagsOf(id: number): Promise<string[]> {
		return this.db.tagsOf(id);
	}

	async listTags(query: TagQuery = {}): Promise<TagPage> {
		return this.db.listTags(query);
	}

	async stats(): Promise<MemoryStats> {
		const stats = this.db.stats();
		return {
			facts: stats.facts,
			entities: stats.entities,
			edges: stats.edges,
			vectors: stats.vectors,
		};
	}

	async checkpoint(): Promise<void> {
		await this.db.checkpoint();
	}

	async maintain(): Promise<void> {
		await this.db.maintain("auto");
	}

	/**
	 * Recomputes every vector with the currently configured embedder.
	 *
	 * Needed after the model or the dimension changes, and after switching the
	 * embedder on for the first time. That last case is the quiet one: nothing
	 * breaks, the old facts simply have no vectors, and semantic search answers
	 * from half the memory without saying so.
	 */
	async reembed(): Promise<void> {
		await this.db.reembed();
	}

	close(): void {
		this.db.close();
	}

	/** The addon's own complaints about `config.toml`; log them once. */
	configWarnings(): string[] {
		return this.db.configWarnings();
	}
}

/**
 * A read-only handle.
 *
 * It takes a *shared* lock on the published snapshot, so any number of these
 * coexist across processes alongside a live writer. That property is what makes
 * several pi sessions on one machine possible at all, and what makes asking
 * another project's memory safe while somebody is working in it.
 *
 * The cost is snapshot isolation: this sees the generation it opened, and only
 * adopts newer ones on {@link refresh}. So a session that writes to a database
 * it also reads must refresh afterwards, or it will not see its own write.
 */
export class PlugmemReader implements ReadableMemory {
	constructor(private readonly db: Plugmem) {}

	static async open(
		path: string,
		options: OpenOptions = {},
	): Promise<PlugmemReader> {
		return new PlugmemReader(
			await Plugmem.open(path, { ...toOpenOptions(options), readOnly: true }),
		);
	}

	async recall(input: RecallInput): Promise<RecallResult> {
		return recallVia(this.db, input);
	}

	async scan(filter: ScanFilter = {}): Promise<ScannedFact[]> {
		return scanVia(this.db, filter);
	}

	async get(id: number): Promise<FactCard | null> {
		return cardOf(this.db, id);
	}

	async tagsOf(id: number): Promise<string[]> {
		return this.db.tagsOf(id);
	}

	async listTags(query: TagQuery = {}): Promise<TagPage> {
		return this.db.listTags(query);
	}

	async stats(): Promise<MemoryStats> {
		const stats = this.db.stats();
		return {
			facts: stats.facts,
			entities: stats.entities,
			edges: stats.edges,
			vectors: stats.vectors,
		};
	}

	/** Adopts the writer's latest published checkpoint. */
	refresh(): boolean {
		return this.db.refresh();
	}

	generation(): number {
		return this.db.generation();
	}

	close(): void {
		this.db.close();
	}
}

/**
 * Opens a database read-only, publishing a first snapshot if it has none.
 *
 * A database that has never been checkpointed - which includes one that has
 * never existed - rejects a read-only open with `PLUGMEM_NEEDS_CHECKPOINT`.
 * The recovery is one brief writer lease. Skipping this branch means the very
 * first session on a clean machine fails to start, and it fails in the least
 * obvious place: the common database, before any project is even resolved.
 */
export async function openReadable(
	path: string,
	options: OpenOptions = {},
): Promise<PlugmemReader> {
	try {
		return await PlugmemReader.open(path, options);
	} catch (error) {
		if (!needsCheckpoint(error)) throw error;
		const writer = await PlugmemStore.open(path, options);
		try {
			await writer.checkpoint();
		} finally {
			writer.close();
		}
		return PlugmemReader.open(path, options);
	}
}

function toOpenOptions(options: OpenOptions): {
	dim?: number;
	config?: string;
} {
	return defined({ dim: options.dim, config: options.config });
}

function toRememberArgs(input: RememberInput) {
	return {
		text: input.text,
		...defined({
			entity: input.entity,
			tags: input.tags,
			links: input.links,
			metadata: input.metadata,
			validFrom: input.validFrom,
		}),
	};
}

async function recallVia(
	db: Plugmem,
	input: RecallInput,
): Promise<RecallResult> {
	const result = await db.recall(
		defined({
			query: input.query,
			tags: input.tags,
			entities: input.entities,
			k: input.k,
			tokenBudget: input.tokenBudget,
			graphDepth: input.graphDepth,
			asOf: input.asOf,
		}),
	);
	return {
		rendered: result.rendered,
		truncated: result.truncated,
		facts: result.facts.map((fact) => ({
			id: fact.id,
			score: fact.score,
			recordedAt: fact.recordedAt,
			validFrom: fact.validFrom,
			validTo: fact.validTo,
		})),
	};
}

/**
 * Enumerates every live fact, page by page.
 *
 * `exportPage` rather than `export`: the unbounded form materialises the whole
 * database into one array and builds a JavaScript object per fact on the main
 * thread - measured by the addon's own authors at 244 ms of a 289 ms call over
 * 100 000 facts. Paging costs nothing and cannot stall the event loop.
 */
async function scanVia(
	db: Plugmem,
	filter: ScanFilter,
): Promise<ScannedFact[]> {
	const wanted = filter.tags ?? [];
	const found: ScannedFact[] = [];
	let cursor: number | undefined;
	do {
		const page = await db.exportPage(cursor);
		for (const fact of page.facts) {
			if (!wanted.every((tag) => fact.tags.includes(tag))) continue;
			found.push({
				id: fact.id,
				text: fact.text,
				tags: fact.tags,
				metadata: fact.metadata,
			});
		}
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return found;
}

async function cardOf(db: Plugmem, id: number): Promise<FactCard | null> {
	const snapshot = db.get(id);
	if (snapshot === null) return null;
	return {
		id: snapshot.record.id,
		text: snapshot.text,
		tags: db.tagsOf(id),
		metadata: snapshot.metadata,
		recordedAt: snapshot.record.recordedAt,
		validFrom: snapshot.record.validFrom,
		validTo: snapshot.record.validTo,
	};
}
