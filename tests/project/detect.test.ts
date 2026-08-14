import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_PARENTS,
	locateProject,
	PROJECT_MARKERS,
} from "../../src/project/detect.ts";

/** A fake filesystem: the set of paths that exist, plus optional symlinks. */
function fsWith(...existing: string[]) {
	const set = new Set(existing);
	return { exists: (candidate: string) => set.has(candidate) };
}

/** The same, with a symlink table for `realPath`. */
function fsLinking(links: Record<string, string>, ...existing: string[]) {
	return {
		...fsWith(...existing),
		realPath: (candidate: string) => links[candidate] ?? candidate,
	};
}

/** The folders that already have a memory bound to them. */
function memoriesAt(...dirs: string[]) {
	const set = new Set(dirs);
	return (dir: string) => set.has(dir);
}

const posix = path.posix;

describe("locateProject, by marker", () => {
	it("finds the git root from a nested directory", async () => {
		const found = await locateProject("/home/m/app/src/deep", {
			fs: fsWith("/home/m/app/.git"),
			flavour: posix,
		});
		expect(found).toEqual({ root: "/home/m/app", source: "marker" });
	});

	it("takes the marker list it is given, since the default is only .git", async () => {
		// The list is a preference about this machine, which is why it moved to
		// settings: a Rust project with no git is a project, and only its owner
		// knows that.
		expect(
			await locateProject("/home/m/app/src", {
				fs: fsWith("/home/m/app/Cargo.toml"),
				flavour: posix,
				markers: ["Cargo.toml"],
			}),
		).toEqual({ root: "/home/m/app", source: "marker" });

		// With the default list, the same tree is not a project at all.
		expect(
			await locateProject("/home/m/app/src", {
				fs: fsWith("/home/m/app/Cargo.toml"),
				flavour: posix,
			}),
		).toBeUndefined();
	});

	it("guesses nothing at all when the marker list is empty", async () => {
		expect(
			await locateProject("/home/m/app/src", {
				fs: fsWith("/home/m/app/.git"),
				flavour: posix,
				markers: [],
			}),
		).toBeUndefined();
	});

	it("prefers the nearest marker when both an inner and an outer one exist", async () => {
		expect(
			await locateProject("/home/m/mono/packages/api/src", {
				fs: fsWith("/home/m/mono/.git", "/home/m/mono/packages/api/.git"),
				flavour: posix,
			}),
		).toEqual({ root: "/home/m/mono/packages/api", source: "marker" });
	});

	it("returns undefined for a directory that is not a project", async () => {
		expect(
			await locateProject("/tmp/scratch", { fs: fsWith(), flavour: posix }),
		).toBeUndefined();
	});

	it("stops at the filesystem root instead of looping", async () => {
		expect(
			await locateProject("/a/b/c", { fs: fsWith(), flavour: posix }),
		).toBeUndefined();
	});

	it("walks up on windows too, and stops at the drive root", async () => {
		expect(
			await locateProject("C:\\work\\app\\src", {
				fs: fsWith("C:\\work\\app\\.git"),
				flavour: path.win32,
			}),
		).toEqual({ root: "C:\\work\\app", source: "marker" });
		expect(
			await locateProject("C:\\work\\app", {
				fs: fsWith(),
				flavour: path.win32,
			}),
		).toBeUndefined();
	});

	it("treats the marker directory itself as the root", async () => {
		expect(
			await locateProject("/home/m/app", {
				fs: fsWith("/home/m/app/.git"),
				flavour: posix,
			}),
		).toEqual({ root: "/home/m/app", source: "marker" });
	});

	it("never guesses the home directory, however it is spelled", async () => {
		// People keep a `.git` in their home for their dotfiles. Without this,
		// every session outside a real project files its facts under a project
		// named after the user's login.
		for (const home of ["/home/m", "/home/m/", "/home/m/x/.."]) {
			expect(
				await locateProject("/home/m", {
					fs: fsWith("/home/m/.git"),
					flavour: posix,
					home,
				}),
			).toBeUndefined();
		}
	});

	it("stops the walk at home rather than looking above it", async () => {
		expect(
			await locateProject("/home/m/notes", {
				fs: fsWith("/home/.git"),
				flavour: posix,
				home: "/home/m",
			}),
		).toBeUndefined();
	});

	it("still finds a real project underneath home", async () => {
		expect(
			await locateProject("/home/m/app/src", {
				fs: fsWith("/home/m/app/.git"),
				flavour: posix,
				home: "/home/m",
			}),
		).toEqual({ root: "/home/m/app", source: "marker" });
	});

	it("lists git as its only default marker", async () => {
		expect([...PROJECT_MARKERS]).toEqual([".git"]);
	});
});

describe("locateProject, by existing memory", () => {
	it("prefers a bound folder over anything the markers say", async () => {
		// A package inside a bound monorepo inherits the monorepo's memory. The
		// marker is a guess; the binding is a decision somebody made.
		expect(
			await locateProject("/home/m/mono/packages/api/src", {
				fs: fsWith("/home/m/mono/.git", "/home/m/mono/packages/api/.git"),
				flavour: posix,
				hasMemory: memoriesAt("/home/m/mono"),
			}),
		).toEqual({ root: "/home/m/mono", source: "memory" });
	});

	it("lets a nearer memory win over a farther one", async () => {
		// Which is how a package gets its own memory back: `/longterm-new` binds
		// it here, and here is nearer.
		expect(
			await locateProject("/home/m/mono/packages/api/src", {
				fs: fsWith("/home/m/mono/.git"),
				flavour: posix,
				hasMemory: memoriesAt("/home/m/mono", "/home/m/mono/packages/api"),
			}),
		).toEqual({ root: "/home/m/mono/packages/api", source: "memory" });
	});

	it("gives a folder with no marker at all a memory it was bound to", async () => {
		expect(
			await locateProject("/home/m/scripts/deep", {
				fs: fsWith(),
				flavour: posix,
				hasMemory: memoriesAt("/home/m/scripts"),
			}),
		).toEqual({ root: "/home/m/scripts", source: "memory" });
	});

	it("honours a memory bound at home, unlike a marker there", async () => {
		// The home rule is about guessing. Somebody who asked for a memory there
		// was not guessing.
		expect(
			await locateProject("/home/m", {
				fs: fsWith("/home/m/.git"),
				flavour: posix,
				home: "/home/m",
				hasMemory: memoriesAt("/home/m"),
			}),
		).toEqual({ root: "/home/m", source: "memory" });
	});
});

describe("locateProject, walking", () => {
	it("resolves symlinks first, so one folder is one memory", async () => {
		// Reached through a link and through its own name, a folder would
		// otherwise be two identities with two memories, neither aware of the
		// other.
		expect(
			await locateProject("/home/m/link/src", {
				fs: fsLinking(
					{ "/home/m/link/src": "/home/m/app/src" },
					"/home/m/app/.git",
				),
				flavour: posix,
			}),
		).toEqual({ root: "/home/m/app", source: "marker" });
	});

	it("climbs no further than it was told to", async () => {
		const fs = fsWith("/a/.git");
		expect(
			await locateProject("/a/b/c/d", { fs, flavour: posix, maxParents: 2 }),
		).toBeUndefined();
		expect(
			await locateProject("/a/b/c/d", { fs, flavour: posix, maxParents: 3 }),
		).toEqual({ root: "/a", source: "marker" });
	});

	it("looks at the working directory alone when the limit is zero", async () => {
		const fs = fsWith("/a/.git");
		expect(
			await locateProject("/a/b", { fs, flavour: posix, maxParents: 0 }),
		).toBeUndefined();
		expect(
			await locateProject("/a", { fs, flavour: posix, maxParents: 0 }),
		).toEqual({ root: "/a", source: "marker" });
	});

	it("has a default limit deep enough for a real tree", async () => {
		expect(DEFAULT_MAX_PARENTS).toBeGreaterThan(8);
	});

	it("behaves the same on both flavours for the same shape of tree", async () => {
		const posixFound = await locateProject("/root/app/src", {
			fs: fsWith("/root/app/.git"),
			flavour: posix,
		});
		const winFound = await locateProject("C:\\root\\app\\src", {
			fs: fsWith("C:\\root\\app\\.git"),
			flavour: path.win32,
		});
		expect(posixFound?.root).toBe("/root/app");
		expect(winFound?.root).toBe("C:\\root\\app");
	});
});
