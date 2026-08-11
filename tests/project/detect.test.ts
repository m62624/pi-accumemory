import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	detectProjectRoot,
	PROJECT_MARKERS,
} from "../../src/project/detect.ts";

/** A fake filesystem: the set of paths that exist. */
function fsWith(...existing: string[]) {
	const set = new Set(existing);
	return { exists: (candidate: string) => set.has(candidate) };
}

const posix = path.posix;

describe("detectProjectRoot", () => {
	it("finds the git root from a nested directory", async () => {
		const found = await detectProjectRoot("/home/m/app/src/deep", {
			fs: fsWith("/home/m/app/.git"),
			flavour: posix,
		});
		expect(found).toBe("/home/m/app");
	});

	it("accepts a manifest as a marker too, for a project with no git", async () => {
		expect(
			await detectProjectRoot("/home/m/app/src", {
				fs: fsWith("/home/m/app/Cargo.toml"),
				flavour: posix,
			}),
		).toBe("/home/m/app");
	});

	it("prefers the nearest marker when both an inner and an outer one exist", async () => {
		// A package inside a monorepo is its own project: its conventions and
		// gotchas are not the root's.
		expect(
			await detectProjectRoot("/home/m/mono/packages/api/src", {
				fs: fsWith(
					"/home/m/mono/.git",
					"/home/m/mono/packages/api/package.json",
				),
				flavour: posix,
			}),
		).toBe("/home/m/mono/packages/api");
	});

	it("returns undefined for a directory that is not a project", async () => {
		// No project database is created for a home directory or /tmp. Minting
		// one per visited folder is how the workspace turns into a junkyard.
		expect(
			await detectProjectRoot("/home/m", { fs: fsWith(), flavour: posix }),
		).toBeUndefined();
		expect(
			await detectProjectRoot("/tmp", { fs: fsWith(), flavour: posix }),
		).toBeUndefined();
	});

	it("stops at the filesystem root instead of looping", async () => {
		expect(
			await detectProjectRoot("/", { fs: fsWith(), flavour: posix }),
		).toBeUndefined();
	});

	it("walks up on windows too, and stops at the drive root", async () => {
		const win = path.win32;
		expect(
			await detectProjectRoot("C:\\Users\\m\\app\\src", {
				fs: fsWith("C:\\Users\\m\\app\\.git"),
				flavour: win,
			}),
		).toBe("C:\\Users\\m\\app");
		expect(
			await detectProjectRoot("C:\\", { fs: fsWith(), flavour: win }),
		).toBeUndefined();
	});

	it("treats the marker directory itself as the root", async () => {
		expect(
			await detectProjectRoot("/home/m/app", {
				fs: fsWith("/home/m/app/.git"),
				flavour: posix,
			}),
		).toBe("/home/m/app");
	});

	it("lists git first among the markers", async () => {
		// Ordering is documentation here: git is the marker that actually
		// delimits a repository; the manifests are a fallback for what is not
		// version controlled.
		expect(PROJECT_MARKERS[0]).toBe(".git");
	});
});
