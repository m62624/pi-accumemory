import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	fromStoredPath,
	isStoredPath,
	joinStored,
	storedBasename,
	toStoredPath,
	toStoredRelative,
} from "../../src/paths/path-codec.ts";

// Every case runs against an *injected* path flavour rather than the real
// `process.platform`. Half of these are unverifiable on a Linux machine
// otherwise, which is exactly how a Windows-only bug ships unnoticed.
const win32 = path.win32;
const posix = path.posix;

describe("toStoredPath", () => {
	it("keeps a posix path as-is", () => {
		expect(toStoredPath("/home/m/Projects/app", posix)).toBe(
			"/home/m/Projects/app",
		);
	});

	it("turns windows separators into forward slashes", () => {
		expect(toStoredPath("C:\\Users\\m\\app", win32)).toBe("C:/Users/m/app");
	});

	it("keeps the drive letter", () => {
		// Dropping it would collapse C:\x and D:\x into the same stored path,
		// which silently merges the memory of two different projects.
		expect(toStoredPath("C:\\x", win32)).toBe("C:/x");
		expect(toStoredPath("D:\\x", win32)).toBe("D:/x");
		expect(toStoredPath("C:\\x", win32)).not.toBe(toStoredPath("D:\\x", win32));
	});

	it("upper-cases the drive letter so c: and C: are one project", () => {
		expect(toStoredPath("c:\\Users\\m", win32)).toBe("C:/Users/m");
	});

	it("preserves a UNC share", () => {
		expect(toStoredPath("\\\\server\\share\\app", win32)).toBe(
			"//server/share/app",
		);
	});

	it("normalises . and .. segments", () => {
		expect(toStoredPath("/home/m/./Projects/../Projects/app", posix)).toBe(
			"/home/m/Projects/app",
		);
		expect(toStoredPath("C:\\a\\b\\..\\c", win32)).toBe("C:/a/c");
	});

	it("drops a trailing separator but never the root itself", () => {
		expect(toStoredPath("/home/m/app/", posix)).toBe("/home/m/app");
		expect(toStoredPath("/", posix)).toBe("/");
		expect(toStoredPath("C:\\", win32)).toBe("C:/");
	});

	it("rejects a relative path", () => {
		// A stored path is an identity. A relative one means something different
		// in every process that reads it.
		expect(() => toStoredPath("app/src", posix)).toThrow(/relative/i);
	});

	it("rejects an empty path", () => {
		expect(() => toStoredPath("", posix)).toThrow(/empty/i);
	});
});

describe("fromStoredPath", () => {
	it("round-trips a posix path", () => {
		const native = "/home/m/Projects/app";
		expect(fromStoredPath(toStoredPath(native, posix), posix)).toBe(native);
	});

	it("round-trips a windows path", () => {
		const native = "C:\\Users\\m\\app";
		expect(fromStoredPath(toStoredPath(native, win32), win32)).toBe(native);
	});

	it("round-trips a UNC path", () => {
		const native = "\\\\server\\share\\app";
		expect(fromStoredPath(toStoredPath(native, win32), win32)).toBe(native);
	});

	it("round-trips the windows drive root", () => {
		expect(fromStoredPath("C:/", win32)).toBe("C:\\");
	});

	it("leaves a posix path untouched on posix", () => {
		expect(fromStoredPath("/home/m/app", posix)).toBe("/home/m/app");
	});

	it("rejects a stored path that is not canonical", () => {
		expect(() => fromStoredPath("C:\\Users", win32)).toThrow(/canonical/i);
	});
});

describe("toStoredRelative", () => {
	it("stores a path inside the project relative to its root", () => {
		// Relative-to-root is what survives the project folder being moved:
		// the router revises one path fact and every note pointer still resolves.
		const stored = toStoredRelative(
			"/home/m/app",
			"/home/m/app/src/main.ts",
			posix,
		);
		expect(stored).toBe("src/main.ts");
	});

	it("uses forward slashes for a windows child path", () => {
		expect(toStoredRelative("C:\\app", "C:\\app\\src\\main.ts", win32)).toBe(
			"src/main.ts",
		);
	});

	it("is empty for the root itself", () => {
		expect(toStoredRelative("/home/m/app", "/home/m/app", posix)).toBe("");
	});

	it("rejects a path outside the root instead of emitting ../", () => {
		// An escaping relative path is how a note pointer walks out of the
		// project directory; refusing it here is cheaper than validating later.
		expect(() =>
			toStoredRelative("/home/m/app", "/home/m/other/x", posix),
		).toThrow(/outside/i);
	});
});

describe("joinStored", () => {
	it("joins segments with forward slashes", () => {
		expect(joinStored("/home/m/app", "notes", "n1.md")).toBe(
			"/home/m/app/notes/n1.md",
		);
	});

	it("does not double a separator at the root", () => {
		expect(joinStored("/", "notes")).toBe("/notes");
		expect(joinStored("C:/", "notes")).toBe("C:/notes");
	});

	it("ignores empty segments", () => {
		expect(joinStored("/home/m", "", "app")).toBe("/home/m/app");
	});
});

describe("storedBasename", () => {
	it("returns the last segment", () => {
		expect(storedBasename("/home/m/Projects/app")).toBe("app");
	});

	it("returns an empty string for a root", () => {
		expect(storedBasename("/")).toBe("");
		expect(storedBasename("C:/")).toBe("");
	});
});

describe("isStoredPath", () => {
	it("accepts canonical absolute forms", () => {
		expect(isStoredPath("/home/m/app")).toBe(true);
		expect(isStoredPath("C:/app")).toBe(true);
		expect(isStoredPath("//server/share")).toBe(true);
	});

	it("rejects backslashes and relative forms", () => {
		expect(isStoredPath("C:\\app")).toBe(false);
		expect(isStoredPath("app/src")).toBe(false);
		expect(isStoredPath("")).toBe(false);
	});
});
