/**
 * The real filesystem behind {@link FileOps}.
 *
 * Absence is normal here - a note that was never written, a settings file that
 * does not exist, a session directory for a project nobody has opened - so
 * `ENOENT` becomes `undefined` / `false` / `[]` rather than an exception. Every
 * other error is a real fault and propagates.
 */

import {
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import type { FileOps } from "./fs-ops.ts";

export const nodeFileOps: FileOps = {
	async mkdir(dir: string): Promise<void> {
		await mkdir(dir, { recursive: true });
	},

	async readFile(file: string): Promise<string | undefined> {
		try {
			return await readFile(file, "utf8");
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
	},

	async writeFile(file: string, content: string): Promise<void> {
		await writeFile(file, content, "utf8");
	},

	async remove(file: string): Promise<boolean> {
		try {
			await rm(file);
			return true;
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
	},

	async removeDir(dir: string): Promise<boolean> {
		try {
			await rm(dir, { recursive: true });
			return true;
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
	},

	async exists(candidate: string): Promise<boolean> {
		try {
			await stat(candidate);
			return true;
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
	},

	async realPath(candidate: string): Promise<string> {
		try {
			return await realpath(candidate);
		} catch {
			// Not only ENOENT: a path can be unresolvable for permissions too,
			// and neither is a reason to refuse to start. The unresolved path is
			// still a usable identity - just possibly a second one for a folder
			// that already had one.
			return candidate;
		}
	},

	async listFiles(dir: string): Promise<string[]> {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			return entries
				.filter((entry) => entry.isFile())
				.map((entry) => entry.name);
		} catch (error) {
			if (isMissing(error)) return [];
			throw error;
		}
	},
};

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
