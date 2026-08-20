import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import {
	MemoryLimitError,
	measureDatabaseFootprint,
	SizeLimitedMemory,
} from "../../src/storage/size-limits.ts";
import { FakeFs } from "../helpers/fake-fs.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

const DB = "/memory/db/common.plugmem";

function limits(userBytes: number) {
	return {
		...DEFAULT_SETTINGS.memory.sizeLimits,
		userBytes,
		projectBytes: userBytes,
	};
}

describe("measureDatabaseFootprint", () => {
	it("counts the manifest, current snapshot, journal and lock as active", async () => {
		const fs = new FakeFs();
		fs.files.set(DB, "manifest");
		fs.files.set(`${DB}.journal`, "123");
		fs.files.set(`${DB}.lock`, "12");
		fs.files.set(`${DB}.snap.7`, "current snapshot");
		fs.files.set(`${DB}.snap.6`, "old");
		fs.files.set(`${DB}.snap.7.tmp`, "temporary");
		fs.files.set("/memory/db/unrelated", "not part of this database");

		const footprint = await measureDatabaseFootprint(fs, path.posix, DB);

		expect(footprint.activeBytes).toBe(
			Buffer.byteLength("manifest12312current snapshot", "utf8"),
		);
		expect(footprint.currentSnapshotBytes).toBe(
			Buffer.byteLength("current snapshot", "utf8"),
		);
		expect(footprint.journalBytes).toBe(3);
		expect(footprint.overheadBytes).toBe(
			Buffer.byteLength("oldtemporary", "utf8"),
		);
	});

	it("uses the highest published generation on Windows-shaped paths", async () => {
		const fs = new FakeFs();
		const db = "C:\\memory\\common.plugmem";
		fs.files.set(db, "base");
		fs.files.set(`${db}.snap.2`, "old");
		fs.files.set(`${db}.snap.11`, "newest");

		const footprint = await measureDatabaseFootprint(fs, path.win32, db);

		expect(footprint.activeBytes).toBe(4 + 6);
		expect(footprint.overheadBytes).toBe(3);
	});
});

describe("SizeLimitedMemory", () => {
	it("reports pressure after a mutation and blocks growth at the limit", async () => {
		const fs = new FakeFs();
		fs.files.set(DB, "base");
		fs.files.set(`${DB}.snap.1`, "12345");
		const inner = new FakeMemory();
		const seen: string[] = [];
		const memory = new SizeLimitedMemory({
			scope: "user",
			inner,
			settings: limits(10),
			fs,
			pathModule: path.posix,
			dbPath: DB,
			onSize: (snapshot) => void seen.push(snapshot.state),
		});

		await memory.remember({ text: "The project uses Vitest." });
		expect(seen).toContain("pressure");

		fs.files.set(`${DB}.journal`, "12345");
		await expect(
			memory.remember({ text: "The project uses TypeScript." }),
		).rejects.toBeInstanceOf(MemoryLimitError);
		expect(inner.live()).toHaveLength(1);
	});

	it("leaves a disabled limit as a normal writable memory", async () => {
		const fs = new FakeFs();
		fs.files.set(DB, "a".repeat(100));
		const memory = new SizeLimitedMemory({
			scope: "project",
			inner: new FakeMemory(),
			settings: limits(0),
			fs,
			pathModule: path.posix,
			dbPath: DB,
			onSize: () => {},
		});

		expect((await memory.snapshot()).state).toBe("disabled");
		await expect(
			memory.remember({ text: "The project uses Vitest." }),
		).resolves.toMatchObject({
			id: 0,
		});
	});

	it("does not measure a rejected duplicate or an empty forget batch as growth", async () => {
		const fs = new FakeFs();
		const inner = new FakeMemory({ duplicateThreshold: 0.5 });
		const memory = new SizeLimitedMemory({
			scope: "user",
			inner,
			settings: limits(100),
			fs,
			pathModule: path.posix,
			dbPath: DB,
			onSize: () => {},
		});
		await memory.remember({
			text: "The project uses Vitest.",
			entity: "project",
		});
		const duplicate = await memory.rememberGuarded({
			text: "The project uses Vitest.",
			entity: "project",
		});
		expect(duplicate.status).toBe("blocked");
		expect(await memory.forgetMany([99])).toEqual([false]);
	});

	it("returns an empty edge list when the wrapped reader has no graph method", async () => {
		const fs = new FakeFs();
		const inner = new FakeMemory();
		(inner as unknown as { listEdges?: unknown }).listEdges = undefined;
		const memory = new SizeLimitedMemory({
			scope: "user",
			inner,
			settings: limits(100),
			fs,
			pathModule: path.posix,
			dbPath: DB,
			onSize: () => {},
		});
		expect(await memory.listEdges()).toEqual([]);
	});
});
