/**
 * Notes: bodies too long to be facts, indexed by facts.
 *
 * A fact is one sentence. Some things a project needs remembered are not one
 * sentence - an architecture overview, a runbook, the shape of a subsystem.
 * Those live as markdown files, and every one of them has a pointer fact in the
 * database. Nothing exists in `notes/` without a pointer: an orphan file is
 * unreachable, and an orphan pointer is a broken promise.
 *
 * **The model never handles a path.** It passes a title and a body and gets an
 * id back; the id is the only handle it ever holds. That is not politeness
 * about abstraction, it is the containment boundary - a model that could name
 * the file could name a file belonging to the extension, or one outside the
 * directory entirely. The same reasoning plugmem applies when it refuses to let
 * a database name be a path.
 *
 * **The stored pointer is relative and forward-slashed.** The database has to
 * be readable from the other operating system, and has to survive the extension
 * directory being moved; an absolute native path in metadata breaks both.
 */

import type { FileOps } from "../fs-ops.ts";
import type { WritableMemory } from "../storage/port.ts";

/** A note id is a bare identifier - nothing that can act as a path. */
const NOTE_ID = /^[A-Za-z0-9_-]+$/;

export const NOTE_TAG = "note";
/** Metadata key holding the body's path, relative to the notes directory. */
export const NOTE_PATH_KEY = "notePath";
export const NOTE_ID_KEY = "noteId";
export const NOTE_TITLE_KEY = "title";

/** The subset of `node:path` this module needs. */
export interface PathFlavour {
	join(...parts: string[]): string;
}

export interface NoteStoreOptions {
	fs: FileOps;
	/** Native path of the directory holding this scope's bodies. */
	dir: string;
	flavour: PathFlavour;
	newId?: () => string;
}

export interface NoteRef {
	noteId: string;
	title: string;
	factId: number;
}

export interface NoteBody {
	noteId: string;
	title: string;
	content: string;
	truncated: boolean;
}

export class NoteStore {
	private readonly fs: FileOps;
	private readonly dir: string;
	private readonly flavour: PathFlavour;
	private readonly newId: () => string;

	constructor(
		private readonly memory: WritableMemory,
		options: NoteStoreOptions,
	) {
		this.fs = options.fs;
		this.dir = options.dir;
		this.flavour = options.flavour;
		this.newId = options.newId ?? defaultId;
	}

	async create(title: string, content: string): Promise<NoteRef> {
		const noteId = this.newId();
		assertNoteId(noteId);
		await this.fs.mkdir(this.dir);
		await this.fs.writeFile(this.nativePath(noteId), content);

		const stored = await this.memory.remember({
			text: `Note "${title}"`,
			// One entity per note: the duplicate detector compares a fact
			// against its entity's recent history, so notes sharing an entity
			// would each look like a duplicate of the last one written.
			entity: noteEntity(noteId),
			tags: [NOTE_TAG],
			metadata: {
				[NOTE_ID_KEY]: noteId,
				[NOTE_TITLE_KEY]: title,
				[NOTE_PATH_KEY]: storedPointer(noteId),
			},
		});
		return { noteId, title, factId: stored.id };
	}

	async read(
		noteId: string,
		options: { maxChars?: number } = {},
	): Promise<NoteBody | undefined> {
		assertNoteId(noteId);
		const pointer = await this.pointer(noteId);
		if (pointer === undefined) return undefined;
		const raw = await this.fs.readFile(this.nativePath(noteId));
		if (raw === undefined) return undefined;

		const maxChars = options.maxChars;
		const overLong =
			maxChars !== undefined && maxChars > 0 && raw.length > maxChars;
		return {
			noteId,
			title: pointer.title,
			// Truncation is announced rather than silent: a note that stops
			// mid-sentence with no explanation reads as a corrupt note.
			content: overLong
				? `${raw.slice(0, maxChars)}\n\n[... truncated; read this note directly for the rest]`
				: raw,
			truncated: overLong,
		};
	}

	async update(
		noteId: string,
		content: string,
		title?: string,
	): Promise<NoteRef> {
		assertNoteId(noteId);
		const pointer = await this.pointer(noteId);
		if (pointer === undefined) throw new Error(`notes: unknown note ${noteId}`);
		await this.fs.writeFile(this.nativePath(noteId), content);

		const newTitle = title ?? pointer.title;
		// `revise`, not a second `remember`: two pointers to one body would
		// diverge, and forgetting one would leave the other lying.
		const stored = await this.memory.revise(pointer.factId, {
			text: `Note "${newTitle}"`,
			entity: noteEntity(noteId),
			tags: [NOTE_TAG],
			metadata: {
				[NOTE_ID_KEY]: noteId,
				[NOTE_TITLE_KEY]: newTitle,
				[NOTE_PATH_KEY]: storedPointer(noteId),
			},
		});
		return { noteId, title: newTitle, factId: stored.id };
	}

	async remove(noteId: string): Promise<boolean> {
		assertNoteId(noteId);
		const pointer = await this.pointer(noteId);
		if (pointer === undefined) return false;
		// Pointer first: an interruption then leaves an unreferenced file,
		// which is recoverable clutter. The other order leaves a pointer to
		// nothing, which every later read reports as an error.
		await this.memory.forget(pointer.factId);
		await this.fs.remove(this.nativePath(noteId));
		return true;
	}

	/** Every note, as ids and titles. Never as paths. */
	async list(): Promise<NoteRef[]> {
		// `scan`, not `recall`: listing has no query, and a tag on its own is a
		// filter with nothing to filter - the engine answers such a recall with
		// silence.
		const notes: NoteRef[] = [];
		for (const fact of await this.memory.scan({ tags: [NOTE_TAG] })) {
			const noteId = fact.metadata[NOTE_ID_KEY];
			if (noteId === undefined) continue;
			notes.push({
				noteId,
				title: fact.metadata[NOTE_TITLE_KEY] ?? noteId,
				factId: fact.id,
			});
		}
		return notes;
	}

	private async pointer(noteId: string): Promise<NoteRef | undefined> {
		const found = await this.memory.recall({ entities: [noteEntity(noteId)] });
		for (const hit of found.facts) {
			const card = await this.memory.get(hit.id);
			if (card?.metadata[NOTE_ID_KEY] !== noteId) continue;
			return {
				noteId,
				title: card.metadata[NOTE_TITLE_KEY] ?? noteId,
				factId: hit.id,
			};
		}
		return undefined;
	}

	private nativePath(noteId: string): string {
		return this.flavour.join(this.dir, `${noteId}.md`);
	}
}

export function noteEntity(noteId: string): string {
	return `note:${noteId}`;
}

/** What goes into metadata: relative, forward-slashed, OS-independent. */
function storedPointer(noteId: string): string {
	return `${noteId}.md`;
}

function assertNoteId(noteId: string): void {
	if (!NOTE_ID.test(noteId)) {
		throw new Error(`notes: invalid note id ${JSON.stringify(noteId)}`);
	}
}

function defaultId(): string {
	return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(5)))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
