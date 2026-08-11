import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	INSTRUCTION_KEYS,
	InstructionManager,
} from "../../src/instructions/manager.ts";
import { FakeFs } from "../helpers/fake-fs.ts";

const bundled: Record<string, string> = {
	reading: "how to read the block you are shown",
	memory: "when to ask and when to save",
	placement: "project or common",
	consolidation: "how the idle pass works",
	notes: "when a note beats a fact",
	tags: "tag conventions",
	secrets: "NEVER store credentials",
};

function manager(fs: FakeFs, projectAppendDir?: string) {
	return new InstructionManager({
		fs,
		flavour: path.posix,
		defaultsDir: "/ext/instructions/defaults",
		globalAppendDir: "/ext/instructions/append",
		projectAppendDir,
		bundled,
	});
}

describe("InstructionManager.sync", () => {
	let fs: FakeFs;

	beforeEach(() => {
		fs = new FakeFs();
	});

	it("writes every bundled default on a fresh install", async () => {
		const report = await manager(fs).sync();
		expect(report.created.sort()).toEqual([...INSTRUCTION_KEYS].sort());
		expect(fs.files.get("/ext/instructions/defaults/memory.md")).toBe(
			bundled.memory,
		);
	});

	it("leaves an unchanged default alone on the next start", async () => {
		await manager(fs).sync();
		const report = await manager(fs).sync();
		expect(report.created).toEqual([]);
		expect(report.updated).toEqual([]);
		expect(report.unchanged).toHaveLength(INSTRUCTION_KEYS.length);
	});

	it("restores a default the user edited, because defaults are ours", async () => {
		// Editing a default is how an upgrade silently stops applying. The
		// append file is the supported way to change the text, and it is never
		// touched by this.
		await manager(fs).sync();
		await fs.writeFile("/ext/instructions/defaults/memory.md", "hand edited");
		const report = await manager(fs).sync();
		expect(report.updated).toEqual(["memory"]);
		expect(fs.files.get("/ext/instructions/defaults/memory.md")).toBe(
			bundled.memory,
		);
	});

	it("never writes into the append directory", async () => {
		await fs.writeFile("/ext/instructions/append/memory.md", "mine");
		await manager(fs).sync();
		expect(fs.files.get("/ext/instructions/append/memory.md")).toBe("mine");
	});
});

describe("InstructionManager.read", () => {
	let fs: FakeFs;

	beforeEach(async () => {
		fs = new FakeFs();
		await manager(fs).sync();
	});

	it("is the bundled default when nothing was added", async () => {
		expect(await manager(fs).read("memory")).toBe(bundled.memory);
	});

	it("appends the user's global addition after the default", async () => {
		await fs.writeFile(
			"/ext/instructions/append/memory.md",
			"also check migrations",
		);
		const text = await manager(fs).read("memory");
		expect(text.indexOf(bundled.memory ?? "")).toBeLessThan(
			text.indexOf("also check"),
		);
	});

	it("lets a project append win outright over the global one", async () => {
		// pi-planner's rule, carried over with its trap: they are NOT merged.
		// A project file replaces the global one for that key entirely, and
		// anyone who does not know that will wonder why their global text
		// stopped applying.
		await fs.writeFile("/ext/instructions/append/memory.md", "global text");
		await fs.writeFile("/project/.pi/append/memory.md", "project text");
		const text = await manager(fs, "/project/.pi/append").read("memory");
		expect(text).toContain("project text");
		expect(text).not.toContain("global text");
	});

	it("falls back to the global append when the project has none for that key", async () => {
		await fs.writeFile("/ext/instructions/append/tags.md", "global tags");
		await fs.writeFile("/project/.pi/append/memory.md", "project memory");
		expect(await manager(fs, "/project/.pi/append").read("tags")).toContain(
			"global tags",
		);
	});

	it("ignores a whitespace-only append", async () => {
		await fs.writeFile("/ext/instructions/append/memory.md", "   \n\n ");
		expect(await manager(fs).read("memory")).toBe(bundled.memory);
	});
});

describe("InstructionManager.compose", () => {
	let fs: FakeFs;

	beforeEach(async () => {
		fs = new FakeFs();
		await manager(fs).sync();
	});

	it("puts the secrets rule last, after everything the user added", async () => {
		// The order is the safeguard. A model acts on the last instruction it
		// read, and an append that widens what may be stored must not be able
		// to end up below the rule that forbids storing credentials.
		await fs.writeFile(
			"/ext/instructions/append/memory.md",
			"store anything useful",
		);
		const composed = await manager(fs).compose(["memory", "secrets"]);
		expect(composed.lastIndexOf("NEVER store credentials")).toBeGreaterThan(
			composed.lastIndexOf("store anything useful"),
		);
	});

	it("keeps secrets last even when it was asked for first", async () => {
		const composed = await manager(fs).compose(["secrets", "memory"]);
		expect(composed.lastIndexOf("NEVER store credentials")).toBeGreaterThan(
			composed.lastIndexOf(bundled.memory ?? ""),
		);
	});

	it("includes the secrets rule even when nobody asked for it", async () => {
		// It is not an option. An extension that can be configured into
		// storing tokens is an extension that will.
		expect(await manager(fs).compose(["memory"])).toContain(
			"NEVER store credentials",
		);
	});

	it("cannot have the secrets rule weakened by an append", async () => {
		// Adding to the list is supported; a user append can only ever make it
		// stricter, because it is composed above the rule, not below it.
		await fs.writeFile(
			"/ext/instructions/append/secrets.md",
			"also never store client names",
		);
		const composed = await manager(fs).compose(["secrets"]);
		expect(composed).toContain("also never store client names");
		expect(composed).toContain("NEVER store credentials");
	});
});

describe("InstructionManager with gaps", () => {
	/** A bundle missing keys, which is what a partial upgrade looks like. */
	function sparse(fs: FakeFs, text: Record<string, string>) {
		return new InstructionManager({
			fs,
			flavour: path.posix,
			defaultsDir: "/ext/instructions/defaults",
			globalAppendDir: "/ext/instructions/append",
			bundled: text,
		});
	}

	it("syncs only the keys it actually has text for", async () => {
		// A key added to the list before its text exists must not write an
		// empty default file - an empty instruction reads as "no rule here"
		// and is indistinguishable from one that was deleted on purpose.
		const fs = new FakeFs();
		const report = await sparse(fs, { memory: "ask first" }).sync();
		expect(report.created).toEqual(["memory"]);
		expect(fs.files.has("/ext/instructions/defaults/tags.md")).toBe(false);
	});

	it("reads an absent key as empty rather than as undefined", async () => {
		const fs = new FakeFs();
		expect(await sparse(fs, {}).read("tags")).toBe("");
	});

	it("leaves empty sections out of a composition", async () => {
		// Otherwise the prompt grows blank-line gaps for every key that has no
		// text, and every one of those is paid for on each turn.
		const fs = new FakeFs();
		const composed = await sparse(fs, {
			memory: "ask first",
			secrets: "NEVER store credentials",
		}).compose(["memory", "tags", "notes"]);
		expect(composed).toBe("ask first\n\nNEVER store credentials");
	});

	it("composes to nothing when there is no text at all", async () => {
		const fs = new FakeFs();
		expect(await sparse(fs, {}).compose(["memory"])).toBe("");
	});
});
