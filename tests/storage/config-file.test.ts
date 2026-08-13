/**
 * Who owns plugmem's `config.toml`, and what happens when it is not where it
 * was said to be.
 *
 * The rules are asymmetric on purpose, and that asymmetry is the whole point of
 * these tests: a missing file at the DEFAULT location is how somebody asks for
 * the defaults back, while a missing file at a location they NAMED is almost
 * always a typo - and one that would otherwise be discovered by editing a file
 * nothing reads.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import {
	ensurePlugmemConfig,
	resolveConfigPath,
} from "../../src/storage/config-file.ts";
import { FakeFs } from "../helpers/fake-fs.ts";

const ROOT = "/agent/extensions/pi-accumemory";
const DEFAULT_PATH = path.posix.join(ROOT, "memory", "config.toml");

function base(fs: FakeFs, configured: string | null = null) {
	return {
		fs,
		flavour: path.posix,
		root: ROOT,
		defaultPath: DEFAULT_PATH,
		configured,
	};
}

describe("resolveConfigPath", () => {
	it("falls back to the extension's own directory", () => {
		expect(resolveConfigPath(base(new FakeFs()))).toBe(DEFAULT_PATH);
	});

	it("treats blank as unset, because a blank path is not a path", () => {
		expect(resolveConfigPath(base(new FakeFs(), "   "))).toBe(DEFAULT_PATH);
	});

	it("takes an absolute path as given", () => {
		expect(resolveConfigPath(base(new FakeFs(), "/etc/plugmem.toml"))).toBe(
			"/etc/plugmem.toml",
		);
	});

	it("reads a relative path from the extension, not the shell", () => {
		// pi starts wherever the user happens to be. A config file that moves
		// with the working directory is one nobody can find twice.
		expect(resolveConfigPath(base(new FakeFs(), "custom/plug.toml"))).toBe(
			path.posix.join(ROOT, "custom/plug.toml"),
		);
	});

	it("expands a leading ~ against the home it was handed", () => {
		expect(
			resolveConfigPath({
				...base(new FakeFs(), "~/plugmem.toml"),
				home: "/home/mansur",
			}),
		).toBe("/home/mansur/plugmem.toml");
	});

	it("leaves a ~ inside the path alone", () => {
		// Only the leading segment is the home directory; `a/~/b` is a directory
		// called `~`, however strange.
		expect(resolveConfigPath(base(new FakeFs(), "/tmp/a/~/b.toml"))).toBe(
			"/tmp/a/~/b.toml",
		);
	});
});

describe("ensurePlugmemConfig", () => {
	it("writes the default file when there is none, and says nothing", async () => {
		const fs = new FakeFs();
		const result = await ensurePlugmemConfig(base(fs));
		expect(result.created).toBe(true);
		expect(result.notice).toBe("");
		expect(fs.files.get(DEFAULT_PATH)).toContain("[embedder]");
	});

	it("never touches a file that is already there", async () => {
		const fs = new FakeFs();
		await fs.writeFile(DEFAULT_PATH, "[engine]\ndim = 7\n");
		const result = await ensurePlugmemConfig(base(fs));
		expect(result.created).toBe(false);
		expect(fs.files.get(DEFAULT_PATH)).toBe("[engine]\ndim = 7\n");
	});

	it("puts the defaults back when the file was deleted", async () => {
		// The documented way to start over: delete it, restart.
		const fs = new FakeFs();
		await ensurePlugmemConfig(base(fs));
		await fs.remove(DEFAULT_PATH);
		const again = await ensurePlugmemConfig(base(fs));
		expect(again.created).toBe(true);
	});

	it("says so out loud when a NAMED path had no file", async () => {
		// Quietly running on defaults is how somebody edits a file for an hour
		// and wonders why nothing changes.
		const fs = new FakeFs();
		const result = await ensurePlugmemConfig(base(fs, "/etc/plugmem.toml"));
		expect(result.created).toBe(true);
		expect(result.notice).toContain("/etc/plugmem.toml");
		// Written where they pointed, so the next edit lands in the right file.
		expect(fs.files.has("/etc/plugmem.toml")).toBe(true);
	});

	it("carries an older installation's embedder into the file", async () => {
		const fs = new FakeFs();
		const result = await ensurePlugmemConfig({
			...base(fs),
			legacy: {
				...DEFAULT_SETTINGS.memory.embedder,
				enabled: true,
				model: "bge-m3",
				dim: 1024,
			},
		});
		const written = fs.files.get(DEFAULT_PATH) ?? "";
		expect(written).toContain("enabled = true");
		expect(written).toContain('model = "bge-m3"');
		expect(written).toContain("dim = 1024");
		expect(result.notice).toMatch(/moved to/i);
	});

	it("does not migrate over a file that already exists", async () => {
		// The file wins - it is the one plugmem reads - and the settings that no
		// longer do anything are named rather than left to be edited in vain.
		const fs = new FakeFs();
		await fs.writeFile(DEFAULT_PATH, "[engine]\ndim = 7\n");
		const result = await ensurePlugmemConfig({
			...base(fs),
			legacy: { ...DEFAULT_SETTINGS.memory.embedder, enabled: true },
		});
		expect(fs.files.get(DEFAULT_PATH)).toBe("[engine]\ndim = 7\n");
		expect(result.notice).toMatch(/memory\.embedder/);
		expect(result.notice).toContain(DEFAULT_PATH);
	});

	it("refuses to migrate an embedder plugmem would refuse", async () => {
		// Those values came out of a file the user wrote, so the complaint names
		// their key rather than arriving later as an opinion about TOML.
		const fs = new FakeFs();
		await expect(
			ensurePlugmemConfig({
				...base(fs),
				legacy: {
					...DEFAULT_SETTINGS.memory.embedder,
					enabled: true,
					url: "",
				},
			}),
		).rejects.toThrow(/memory\.embedder\.url/);
		expect(fs.files.has(DEFAULT_PATH)).toBe(false);
	});

	it("works on Windows paths too", async () => {
		const fs = new FakeFs();
		const result = await ensurePlugmemConfig({
			fs,
			flavour: path.win32,
			root: "C:\\agent\\extensions\\pi-accumemory",
			defaultPath: "C:\\agent\\extensions\\pi-accumemory\\memory\\config.toml",
			configured: "custom\\plug.toml",
		});
		expect(result.path).toBe(
			"C:\\agent\\extensions\\pi-accumemory\\custom\\plug.toml",
		);
	});
});
