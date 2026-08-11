/**
 * An in-memory stand-in for one plugmem database.
 *
 * It is deliberately dumb — token overlap, no vectors, no ranking fusion — but
 * it is faithful about the properties the code above it depends on: ids are
 * allocated in order, `revise` closes the predecessor instead of overwriting
 * it, `forget` hides a fact without renumbering anything, and the duplicate
 * detector is scoped to the fact's entity. Everything the extension gets wrong
 * about those it gets wrong here too, which is the point.
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
	SimilarFact,
	TagPage,
	TagQuery,
	WritableMemory,
} from "../../src/storage/port.ts";

/** plugmem's open sentinel for the truth axis. */
export const OPEN_VALID_TO = Number.MAX_SAFE_INTEGER;

interface StoredFact extends FactCard {
	entity: string | undefined;
	closed: boolean;
	tombstoned: boolean;
}

export interface FakeMemoryOptions {
	/** Fixed clock, so recorded timestamps are assertable. */
	now?: () => number;
	/** Jaccard threshold above which the guard blocks a write. */
	duplicateThreshold?: number;
}

export class FakeMemory implements WritableMemory {
	readonly facts: StoredFact[] = [];
	readonly edges: EdgeRef[] = [];
	/** Every `checkpoint()` call, so tests can assert it was not forgotten. */
	checkpoints = 0;
	/** Set to make the next write reject, standing in for PLUGMEM_LOCKED. */
	failNextWrite: Error | undefined;

	private nextId = 1;
	private readonly now: () => number;
	private readonly duplicateThreshold: number;

	constructor(options: FakeMemoryOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.duplicateThreshold = options.duplicateThreshold ?? 0.6;
	}

	async remember(input: RememberInput): Promise<RememberResult> {
		this.throwIfArmed();
		const at = this.now();
		const fact: StoredFact = {
			id: this.nextId++,
			text: input.text,
			tags: [...(input.tags ?? [])],
			metadata: { ...(input.metadata ?? {}) },
			recordedAt: at,
			validFrom: input.validFrom ?? at,
			validTo: OPEN_VALID_TO,
			entity: input.entity,
			closed: false,
			tombstoned: false,
		};
		this.facts.push(fact);
		for (const link of input.links ?? []) {
			this.edges.push({
				src: input.entity ?? "",
				rel: link.rel,
				dst: link.entity,
			});
		}
		return { id: fact.id, similar: this.similarTo(input, fact.id) };
	}

	async rememberGuarded(input: RememberInput): Promise<GuardedRememberResult> {
		this.throwIfArmed();
		const similar = this.similarTo(input, -1);
		if (similar.length > 0) return { status: "blocked", similar };
		const stored = await this.remember(input);
		return { status: "stored", id: stored.id, similar: [] };
	}

	async revise(id: number, input: RememberInput): Promise<RememberResult> {
		this.throwIfArmed();
		const previous = this.live().find((fact) => fact.id === id);
		if (previous === undefined)
			throw new Error(`fake-memory: no live fact ${id}`);
		previous.closed = true;
		previous.validTo = this.now();
		return this.remember({ entity: previous.entity, ...input });
	}

	async forget(id: number): Promise<boolean> {
		this.throwIfArmed();
		const fact = this.live().find((candidate) => candidate.id === id);
		if (fact === undefined) return false;
		fact.tombstoned = true;
		return true;
	}

	async link(edge: EdgeRef): Promise<void> {
		this.throwIfArmed();
		this.unlinkSync(edge);
		this.edges.push({ ...edge });
	}

	async unlink(edge: Omit<EdgeRef, "provenance">): Promise<boolean> {
		this.throwIfArmed();
		return this.unlinkSync(edge);
	}

	async recall(input: RecallInput): Promise<RecallResult> {
		const wanted = tokenise(input.query ?? "");
		const asOf = input.asOf;
		let pool = this.live();
		if (asOf !== undefined) {
			pool = this.facts.filter(
				(fact) =>
					!fact.tombstoned && fact.validFrom <= asOf && fact.validTo > asOf,
			);
		}
		if (input.tags !== undefined && input.tags.length > 0) {
			pool = pool.filter((fact) =>
				input.tags?.every((tag) => fact.tags.includes(tag)),
			);
		}
		if (input.entities !== undefined && input.entities.length > 0) {
			pool = pool.filter((fact) => input.entities?.includes(fact.entity ?? ""));
		}
		const scored = pool
			.map((fact) => ({ fact, score: overlap(wanted, tokenise(fact.text)) }))
			// With no query every candidate scores 0, and the filters above are
			// then the whole answer — which is how a tag- or entity-only recall
			// behaves in the real engine too.
			.filter(({ score }) => wanted.size === 0 || score > 0)
			.sort((a, b) => b.score - a.score || b.fact.id - a.fact.id);

		const k = input.k !== undefined && input.k > 0 ? input.k : scored.length;
		const selected = scored.slice(0, k);
		return {
			rendered: selected
				.map(({ fact }) => `[f${fact.id}] ${fact.text}`)
				.join("\n"),
			facts: selected.map(({ fact, score }) => ({
				id: fact.id,
				score,
				recordedAt: fact.recordedAt,
				validFrom: fact.validFrom,
				validTo: fact.validTo,
			})),
			truncated: selected.length < scored.length,
		};
	}

	async get(id: number): Promise<FactCard | null> {
		const fact = this.facts.find(
			(candidate) => candidate.id === id && !candidate.tombstoned,
		);
		return fact === undefined ? null : { ...fact, tags: [...fact.tags] };
	}

	async tagsOf(id: number): Promise<string[]> {
		return (await this.get(id))?.tags ?? [];
	}

	async listTags(query: TagQuery = {}): Promise<TagPage> {
		const counts = new Map<string, number>();
		for (const fact of this.live()) {
			for (const tag of fact.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
		let items = [...counts]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => a.name.localeCompare(b.name));
		if (query.prefix !== undefined) {
			items = items.filter((item) => item.name.startsWith(query.prefix ?? ""));
		}
		const start = query.cursor === undefined ? 0 : Number(query.cursor);
		const limit = query.limit ?? 64;
		const page = items.slice(start, start + limit);
		const next = start + limit;
		return next < items.length
			? { items: page, nextCursor: String(next) }
			: { items: page };
	}

	async stats(): Promise<MemoryStats> {
		const entities = new Set(
			this.live()
				.map((fact) => fact.entity)
				.filter((name): name is string => name !== undefined),
		);
		return {
			facts: this.live().length,
			entities: entities.size,
			edges: this.edges.length,
		};
	}

	async checkpoint(): Promise<void> {
		this.checkpoints += 1;
	}

	/** Live facts: neither closed by a revision nor forgotten. */
	live(): StoredFact[] {
		return this.facts.filter((fact) => !fact.closed && !fact.tombstoned);
	}

	private unlinkSync(edge: Omit<EdgeRef, "provenance">): boolean {
		const at = this.edges.findIndex(
			(candidate) =>
				candidate.src === edge.src &&
				candidate.rel === edge.rel &&
				candidate.dst === edge.dst,
		);
		if (at === -1) return false;
		this.edges.splice(at, 1);
		return true;
	}

	/**
	 * Scoped to the fact's entity and to its 32 most recent facts, exactly as
	 * the real detector is. Code that dumps everything under one entity breaks
	 * against this fake for the same reason it breaks in production.
	 */
	private similarTo(input: RememberInput, ignoreId: number): SimilarFact[] {
		const mine = tokenise(input.text);
		return this.live()
			.filter((fact) => fact.entity === input.entity && fact.id !== ignoreId)
			.slice(-32)
			.map((fact) => ({
				id: fact.id,
				score: overlap(mine, tokenise(fact.text)),
				reason: "LexicalOverlap",
			}))
			.filter((hit) => hit.score >= this.duplicateThreshold)
			.sort((a, b) => b.score - a.score);
	}

	private throwIfArmed(): void {
		const error = this.failNextWrite;
		if (error !== undefined) {
			this.failNextWrite = undefined;
			throw error;
		}
	}
}

function tokenise(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((token) => token.length > 0),
	);
}

function overlap(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared += 1;
	return shared / new Set([...a, ...b]).size;
}
