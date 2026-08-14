/**
 * A map-backed filesystem, so the modules that write files are testable
 * without laying down real directories - and so the Windows path shape is
 * testable at all.
 */

import type { FileOps } from "../../src/fs-ops.ts";

export class FakeFs implements FileOps {
	readonly files = new Map<string, string>();
	readonly dirs = new Set<string>();
	/** Set to make every write throw, standing in for a read-only disk. */
	failWrites: Error | undefined;

	async mkdir(dir: string): Promise<void> {
		this.dirs.add(dir);
	}

	async readFile(file: string): Promise<string | undefined> {
		return this.files.get(file);
	}

	async writeFile(file: string, content: string): Promise<void> {
		if (this.failWrites !== undefined) throw this.failWrites;
		this.files.set(file, content);
	}

	async remove(file: string): Promise<boolean> {
		return this.files.delete(file);
	}

	/** Drops the directory, everything under it, and the directory entries. */
	async removeDir(dir: string): Promise<boolean> {
		const trimmed = dir.replace(/[/\\]+$/, "");
		const inside = (path: string): boolean =>
			path === trimmed ||
			path.startsWith(`${trimmed}/`) ||
			path.startsWith(`${trimmed}\\`);
		let removed = this.dirs.delete(trimmed);
		for (const file of [...this.files.keys()]) {
			if (inside(file)) removed = this.files.delete(file) || removed;
		}
		for (const known of [...this.dirs]) {
			if (inside(known)) removed = this.dirs.delete(known) || removed;
		}
		return removed;
	}

	/**
	 * Symlinks in the fake are a map from a path to what it really is; anything
	 * not in it is already real.
	 */
	readonly links = new Map<string, string>();

	async realPath(candidate: string): Promise<string> {
		return this.links.get(candidate) ?? candidate;
	}

	async exists(candidate: string): Promise<boolean> {
		return this.files.has(candidate) || this.dirs.has(candidate);
	}

	/**
	 * Paths reaching a FileOps are NATIVE - `C:\a\b` on Windows, `/a/b`
	 * elsewhere - so this splits on either separator. Assuming `/` here would
	 * make every Windows test pass against a fake that behaves like no real
	 * filesystem, which is worse than having no test.
	 */
	async listFiles(dir: string): Promise<string[]> {
		const trimmed = dir.replace(/[/\\]+$/, "");
		return [...this.files.keys()]
			.filter(
				(file) =>
					file.startsWith(`${trimmed}/`) || file.startsWith(`${trimmed}\\`),
			)
			.map((file) => file.slice(trimmed.length + 1))
			.filter((name) => !name.includes("/") && !name.includes("\\"));
	}
}
