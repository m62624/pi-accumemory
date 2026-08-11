import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeFileOps } from "../src/node-fs.ts";

describe("nodeFileOps", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-accumemory-fs-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("treats a missing file as absence, not as an error", async () => {
		// Absence is normal here - an unwritten note, a settings file nobody
		// created, a session directory for a project nobody has opened.
		expect(await nodeFileOps.readFile(join(dir, "nope.md"))).toBeUndefined();
		expect(await nodeFileOps.exists(join(dir, "nope.md"))).toBe(false);
		expect(await nodeFileOps.remove(join(dir, "nope.md"))).toBe(false);
		expect(await nodeFileOps.listFiles(join(dir, "nope"))).toEqual([]);
	});

	it("writes and reads a file back", async () => {
		await nodeFileOps.writeFile(join(dir, "a.md"), "body");
		expect(await nodeFileOps.readFile(join(dir, "a.md"))).toBe("body");
		expect(await nodeFileOps.exists(join(dir, "a.md"))).toBe(true);
	});

	it("creates nested directories in one call", async () => {
		await nodeFileOps.mkdir(join(dir, "a", "b", "c"));
		expect(await nodeFileOps.exists(join(dir, "a", "b", "c"))).toBe(true);
	});

	it("removes a file and reports it", async () => {
		await nodeFileOps.writeFile(join(dir, "a.md"), "body");
		expect(await nodeFileOps.remove(join(dir, "a.md"))).toBe(true);
		expect(await nodeFileOps.exists(join(dir, "a.md"))).toBe(false);
	});

	it("lists files but not directories", async () => {
		await nodeFileOps.writeFile(join(dir, "a.md"), "a");
		await nodeFileOps.writeFile(join(dir, "b.md"), "b");
		await nodeFileOps.mkdir(join(dir, "sub"));
		expect((await nodeFileOps.listFiles(dir)).sort()).toEqual(["a.md", "b.md"]);
	});

	it("propagates a failure that is not absence", async () => {
		// A read that fails for any other reason is a real fault, and swallowing
		// it would present as an empty memory.
		await expect(nodeFileOps.readFile(dir)).rejects.toThrow();
	});
});
