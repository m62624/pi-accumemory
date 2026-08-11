/**
 * One storage format for filesystem paths, readable identically on Windows,
 * Linux and macOS.
 *
 * The memory outlives the machine that wrote it: a database synced between a
 * laptop and a desktop, or simply a project opened from WSL and from Windows,
 * has to agree on what "this path" means. So paths are stored in one canonical
 * shape — forward slashes, drive letter preserved and upper-cased — and turned
 * back into the host's native form only at the moment they touch the disk.
 *
 * Every function takes the `path` flavour as an argument instead of reading
 * `process.platform`. That is what makes the Windows behaviour testable on a
 * Linux machine, which is the only reason it is verified at all.
 */

import type path from "node:path";

/** The subset of `node:path` this module needs; `path.win32` or `path.posix`. */
export type PathFlavour = Pick<
	typeof path.posix,
	"isAbsolute" | "normalize" | "relative" | "sep"
>;

/** `C:/…` or `C:` alone. */
const DRIVE_PREFIX = /^([A-Za-z]):/;
/** A canonical stored path: posix-absolute, UNC, or drive-absolute. */
const STORED_PATH = /^(?:\/|[A-Za-z]:\/)/;

/**
 * Converts a native absolute path into its stored form.
 *
 * @throws if `native` is empty or relative — a stored path is an identity, and
 * a relative one means a different place in every process that reads it.
 */
export function toStoredPath(native: string, flavour: PathFlavour): string {
	if (native === "")
		throw new Error("path-codec: refusing to store an empty path");
	if (!flavour.isAbsolute(native)) {
		throw new Error(`path-codec: refusing to store a relative path: ${native}`);
	}

	let stored = flavour.normalize(native).replaceAll("\\", "/");
	stored = stored.replace(
		DRIVE_PREFIX,
		(_, letter: string) => `${letter.toUpperCase()}:`,
	);

	// `normalize` leaves a trailing separator when the input had one. Strip it,
	// except where it *is* the root: "/" and "C:/" are paths, "" and "C:" are not.
	if (stored.length > 1 && stored.endsWith("/") && !isStoredRoot(stored)) {
		stored = stored.slice(0, -1);
	}
	return stored;
}

/**
 * Converts a stored path back into the host's native form.
 *
 * @throws if `stored` is not canonical — a backslash here means someone stored
 * a native path by mistake, and silently accepting it would let the two formats
 * mix inside one database.
 */
export function fromStoredPath(stored: string, flavour: PathFlavour): string {
	if (!isStoredPath(stored)) {
		throw new Error(`path-codec: not a canonical stored path: ${stored}`);
	}
	if (flavour.sep === "/") return stored;
	return stored.replaceAll("/", "\\");
}

/**
 * Stores `native` relative to `root`, forward-slashed.
 *
 * Paths inside a project are stored this way on purpose: when the project
 * folder moves, the router revises the single fact holding the root and every
 * relative pointer under it keeps resolving. An absolute pointer would have to
 * be rewritten one by one.
 *
 * @throws if `native` is not inside `root`. Returning `../…` would let a note
 * pointer walk out of the project, and refusing it here is cheaper than
 * re-validating it at every use.
 */
export function toStoredRelative(
	root: string,
	native: string,
	flavour: PathFlavour,
): string {
	const rel = flavour.relative(root, native);
	if (rel.startsWith("..") || flavour.isAbsolute(rel)) {
		throw new Error(`path-codec: ${native} is outside ${root}`);
	}
	return rel.replaceAll("\\", "/");
}

/** Joins stored segments, skipping empties and never doubling the separator. */
export function joinStored(base: string, ...segments: string[]): string {
	let out = base;
	for (const segment of segments) {
		if (segment === "") continue;
		out = out.endsWith("/") ? `${out}${segment}` : `${out}/${segment}`;
	}
	return out;
}

/** The last segment of a stored path; empty for a root. */
export function storedBasename(stored: string): string {
	if (isStoredRoot(stored)) return "";
	const cut = stored.lastIndexOf("/");
	return cut === -1 ? stored : stored.slice(cut + 1);
}

/** Whether `value` is in the canonical stored shape. */
export function isStoredPath(value: string): boolean {
	return value !== "" && !value.includes("\\") && STORED_PATH.test(value);
}

/** Whether `stored` is a filesystem root — `/` or `C:/`. */
export function isStoredRoot(stored: string): boolean {
	return stored === "/" || /^[A-Za-z]:\/$/.test(stored);
}
