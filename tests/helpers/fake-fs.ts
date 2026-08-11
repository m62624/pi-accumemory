/**
 * A map-backed filesystem, so the modules that write files are testable
 * without laying down real directories - and so the Windows path shape is
 * testable at all.
 */

import type { FileOps } from "../../src/fs-ops.ts";

export class FakeFs implements FileOps {
	readonly files = new Map<string, string>();
	readonly dirs = new Set<string>();

	async mkdir(dir: string): Promise<void> {
		this.dirs.add(dir);
	}

	async readFile(file: string): Promise<string | undefined> {
		return this.files.get(file);
	}

	async writeFile(file: string, content: string): Promise<void> {
		this.files.set(file, content);
	}

	async remove(file: string): Promise<boolean> {
		return this.files.delete(file);
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
