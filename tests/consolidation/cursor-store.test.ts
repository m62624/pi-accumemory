import path from "node:path";
import { describe, expect, it } from "vitest";
import { CursorStore } from "../../src/consolidation/cursor-store.ts";
import { FakeFs } from "../helpers/fake-fs.ts";

const file = "/ext/state/consolidation.json";

function store(fs: FakeFs) {
	return new CursorStore(fs, file, path.posix);
}

describe("CursorStore", () => {
	it("has nothing for a project it has never seen", async () => {
		expect(await store(new FakeFs()).get("p1")).toBeUndefined();
	});

	it("remembers a cursor across instances", async () => {
		const fs = new FakeFs();
		await store(fs).set("p1", { file: "a.jsonl", line: 12 });
		expect(await store(fs).get("p1")).toEqual({ file: "a.jsonl", line: 12 });
	});

	it("keeps one cursor per project", async () => {
		const fs = new FakeFs();
		const cursors = store(fs);
		await cursors.set("p1", { file: "a.jsonl", line: 1 });
		await cursors.set("p2", { file: "b.jsonl", line: 2 });
		expect(await cursors.get("p1")).toEqual({ file: "a.jsonl", line: 1 });
		expect(await cursors.get("p2")).toEqual({ file: "b.jsonl", line: 2 });
	});

	it("treats a corrupt state file as no state at all", async () => {
		// Losing this costs one pass re-reading what it has seen, which the
		// duplicate guard absorbs. Refusing to start would cost the session.
		const fs = new FakeFs();
		await fs.writeFile(file, "{ truncated");
		expect(await store(fs).get("p1")).toBeUndefined();
	});

	it("ignores a state file holding the wrong shape", async () => {
		const fs = new FakeFs();
		await fs.writeFile(file, "[1,2,3]");
		expect(await store(fs).get("p1")).toBeUndefined();
	});

	it("does not fail a session when the state file cannot be written", async () => {
		const fs = new FakeFs();
		fs.writeFile = async () => {
			throw new Error("read-only filesystem");
		};
		await expect(
			store(fs).set("p1", { file: "a.jsonl", line: 1 }),
		).resolves.toBeUndefined();
	});
});
