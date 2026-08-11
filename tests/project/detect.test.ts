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

	it("never treats the home directory as a project, on either platform", async () => {
		// pi keeps its own `~/.pi`, and `.pi` is one of the markers - so without
		// this rule EVERY user's home answers "yes, I am a project", and a
		// session started anywhere outside a real project files its facts under
		// a project named after the login. Observed live as
		// `Stored [f0] in this project (m62624)`.
		expect(
			await detectProjectRoot("/home/m", {
				fs: fsWith("/home/m/.pi"),
				flavour: posix,
				home: "/home/m",
			}),
		).toBeUndefined();

		const win = path.win32;
		expect(
			await detectProjectRoot("C:\\Users\\m", {
				fs: fsWith("C:\\Users\\m\\.pi"),
				flavour: win,
				home: "C:\\Users\\m",
			}),
		).toBeUndefined();
	});

	it("stops the walk at home rather than looking above it", async () => {
		// A directory under home with no marker of its own is not a project
		// either, however the walk would otherwise end.
		expect(
			await detectProjectRoot("/home/m/Downloads", {
				fs: fsWith("/home/m/.pi", "/home/.git"),
				flavour: posix,
				home: "/home/m",
			}),
		).toBeUndefined();
	});

	it("still finds a real project underneath home", async () => {
		// The exclusion is one directory, not a subtree.
		expect(
			await detectProjectRoot("/home/m/code/app/src", {
				fs: fsWith("/home/m/code/app/.git"),
				flavour: posix,
				home: "/home/m",
			}),
		).toBe("/home/m/code/app");
	});

	it("compares home as a resolved path, on either platform", async () => {
		// A trailing separator or a `..` in either value must not slip past the
		// exclusion, and on Windows the separator and drive shape differ from
		// what a caller may pass.
		expect(
			await detectProjectRoot("/home/m/x/..", {
				fs: fsWith("/home/m/.pi"),
				flavour: posix,
				home: "/home/m/",
			}),
		).toBeUndefined();

		const win = path.win32;
		expect(
			await detectProjectRoot("C:/Users/m", {
				fs: fsWith("C:\\Users\\m\\.pi"),
				flavour: win,
				home: "C:\\Users\\m\\",
			}),
		).toBeUndefined();
	});

	it("behaves the same on both flavours for the same shape of tree", async () => {
		// The same layout expressed twice: nested source directory, marker two
		// levels up, home above that. The answer must differ only in spelling.
		const onPosix = await detectProjectRoot("/home/m/work/api/src/deep", {
			fs: fsWith("/home/m/work/api/package.json"),
			flavour: posix,
			home: "/home/m",
		});
		const onWindows = await detectProjectRoot(
			"C:\\Users\\m\\work\\api\\src\\deep",
			{
				fs: fsWith("C:\\Users\\m\\work\\api\\package.json"),
				flavour: path.win32,
				home: "C:\\Users\\m",
			},
		);
		expect(onPosix).toBe("/home/m/work/api");
		expect(onWindows).toBe("C:\\Users\\m\\work\\api");
	});

	it("lists git first among the markers", async () => {
		// Ordering is documentation here: git is the marker that actually
		// delimits a repository; the manifests are a fallback for what is not
		// version controlled.
		expect(PROJECT_MARKERS[0]).toBe(".git");
	});
});
