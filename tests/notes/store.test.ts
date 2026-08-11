import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NOTE_PATH_KEY, NOTE_TAG, NoteStore } from "../../src/notes/store.ts";
import { FakeFs } from "../helpers/fake-fs.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

function fixedIds(...ids: string[]): () => string {
	const queue = [...ids];
	return () => queue.shift() ?? "exhausted";
}

describe("NoteStore", () => {
	let fs: FakeFs;
	let memory: FakeMemory;
	let notes: NoteStore;

	beforeEach(() => {
		fs = new FakeFs();
		memory = new FakeMemory();
		notes = new NoteStore(memory, {
			fs,
			dir: "/notes/common",
			flavour: path.posix,
			newId: fixedIds("n1", "n2"),
		});
	});

	it("mints the id and the path itself, given only a title and a body", () => {
		// The model never supplies a path. It cannot construct one, cannot
		// substitute one, and cannot reach anything outside this directory -
		// which is what keeps a stray note from landing on top of the
		// extension's own files.
		return notes
			.create("Project overview", "It builds a thing.")
			.then((created) => {
				expect(created.noteId).toBe("n1");
				expect(fs.files.get("/notes/common/n1.md")).toContain(
					"It builds a thing.",
				);
			});
	});

	it("stores the pointer path relative and forward-slashed", async () => {
		// The database has to be readable on the other operating system, and
		// has to survive the extension directory moving. An absolute native
		// path in metadata breaks both.
		await notes.create("Overview", "body");
		const card = await memory.get(0);
		expect(card?.metadata[NOTE_PATH_KEY]).toBe("n1.md");
		expect(card?.metadata[NOTE_PATH_KEY]).not.toContain("\\");
		expect(card?.metadata[NOTE_PATH_KEY]?.startsWith("/")).toBe(false);
	});

	it("uses native separators when actually touching the disk", async () => {
		const winFs = new FakeFs();
		const winNotes = new NoteStore(new FakeMemory(), {
			fs: winFs,
			dir: "C:\\notes\\common",
			flavour: path.win32,
			newId: fixedIds("n1"),
		});
		await winNotes.create("Overview", "body");
		expect([...winFs.files.keys()]).toEqual(["C:\\notes\\common\\n1.md"]);
	});

	it("files the pointer under its own entity and the note tag", async () => {
		// One entity per note, so the duplicate detector compares a note
		// against its own history rather than against every note there is.
		await notes.create("Overview", "body");
		const card = await memory.get(0);
		expect(card?.tags).toContain(NOTE_TAG);
		expect(memory.facts[0]?.entity).toBe("note:n1");
	});

	it("reads a note back by id", async () => {
		const { noteId } = await notes.create("Overview", "the body");
		const read = await notes.read(noteId);
		expect(read?.title).toBe("Overview");
		expect(read?.content).toBe("the body");
	});

	it("returns nothing for an id it never issued", async () => {
		expect(await notes.read("nope")).toBeUndefined();
	});

	it("refuses an id shaped like a path", async () => {
		// The one route by which a note id could escape its directory.
		await expect(notes.read("../../../etc/passwd")).rejects.toThrow(/note id/i);
		await expect(notes.remove("a/b")).rejects.toThrow(/note id/i);
	});

	it("revises the pointer instead of duplicating it on update", async () => {
		const { noteId } = await notes.create("Overview", "first");
		await notes.update(noteId, "second");
		expect((await notes.read(noteId))?.content).toBe("second");
		expect(
			memory.live().filter((fact) => fact.tags.includes(NOTE_TAG)),
		).toHaveLength(1);
	});

	it("refuses to update a note that does not exist", async () => {
		await expect(notes.update("ghost", "x")).rejects.toThrow(/unknown note/i);
	});

	it("removes the body and the pointer together", async () => {
		const { noteId } = await notes.create("Overview", "body");
		expect(await notes.remove(noteId)).toBe(true);
		expect(fs.files.size).toBe(0);
		expect(
			memory.live().filter((fact) => fact.tags.includes(NOTE_TAG)),
		).toHaveLength(0);
	});

	it("reports a delete of something that was never there", async () => {
		expect(await notes.remove("ghost")).toBe(false);
	});

	it("lists notes with their titles but never their paths", async () => {
		// A path handed to the model is a path the model can paste into
		// another call. It gets ids, which only this store can resolve.
		await notes.create("Overview", "a");
		await notes.create("Conventions", "b");
		const listed = await notes.list();
		expect(listed.map((note) => note.title).sort()).toEqual([
			"Conventions",
			"Overview",
		]);
		expect(JSON.stringify(listed)).not.toContain("/notes/");
	});

	it("truncates an oversized body on read, saying so", async () => {
		// A note pasted into the prompt at session start would otherwise eat
		// the window without anyone choosing to spend it.
		const { noteId } = await notes.create("Overview", "x".repeat(5000));
		const read = await notes.read(noteId, { maxChars: 100 });
		expect(read?.content.length).toBeLessThan(200);
		expect(read?.truncated).toBe(true);
	});
});
