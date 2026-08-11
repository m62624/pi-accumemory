import path from "node:path";
import { describe, expect, it } from "vitest";
import { NoteStore } from "../../src/notes/store.ts";
import { FakeFs } from "../helpers/fake-fs.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

function build() {
	const memory = new FakeMemory();
	const fs = new FakeFs();
	const notes = new NoteStore(memory, {
		fs,
		dir: "/notes",
		flavour: path.posix,
	});
	return { memory, fs, notes };
}

describe("NoteStore edge cases", () => {
	it("mints a usable id when none is injected", async () => {
		// The default generator is what runs in production; a test that only
		// ever uses fixed ids never exercises it.
		const { notes, fs } = build();
		const created = await notes.create("Overview", "body");
		expect(created.noteId).toMatch(/^[0-9a-f]+$/);
		expect(fs.files.has(`/notes/${created.noteId}.md`)).toBe(true);
	});

	it("keeps ids distinct across notes", async () => {
		const { notes } = build();
		const first = await notes.create("One", "a");
		const second = await notes.create("Two", "b");
		expect(first.noteId).not.toBe(second.noteId);
	});

	it("reports a pointer whose body has gone missing", async () => {
		// The file was deleted from underneath us. Reporting absence is
		// honest; throwing would take down whatever asked.
		const { notes, fs } = build();
		const created = await notes.create("Overview", "body");
		fs.files.delete(`/notes/${created.noteId}.md`);
		expect(await notes.read(created.noteId)).toBeUndefined();
	});

	it("applies no ceiling when none is asked for", async () => {
		const { notes } = build();
		const created = await notes.create("Overview", "x".repeat(5000));
		const read = await notes.read(created.noteId);
		expect(read?.truncated).toBe(false);
		expect(read?.content).toHaveLength(5000);
	});

	it("treats a zero ceiling as no ceiling", async () => {
		const { notes } = build();
		const created = await notes.create("Overview", "x".repeat(5000));
		expect((await notes.read(created.noteId, { maxChars: 0 }))?.truncated).toBe(
			false,
		);
	});

	it("keeps the old title when an update supplies none", async () => {
		const { notes } = build();
		const created = await notes.create("Overview", "a");
		const updated = await notes.update(created.noteId, "b");
		expect(updated.title).toBe("Overview");
	});

	it("takes a new title when an update supplies one", async () => {
		const { notes } = build();
		const created = await notes.create("Overview", "a");
		expect((await notes.update(created.noteId, "b", "Renamed")).title).toBe(
			"Renamed",
		);
	});

	it("ignores a fact tagged as a note that carries no note id", async () => {
		// Something else wrote a fact with our tag. Listing must not invent a
		// note out of it.
		const { notes, memory } = build();
		await memory.remember({ text: "a stray fact", tags: ["note"] });
		expect(await notes.list()).toEqual([]);
	});

	it("falls back to the id when a pointer has lost its title", async () => {
		const { notes, memory } = build();
		const created = await notes.create("Overview", "body");
		const card = memory.live()[0];
		if (card !== undefined) delete card.metadata.title;
		expect((await notes.list())[0]?.title).toBe(created.noteId);
	});
});
