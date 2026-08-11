/**
 * Is this directory a project?
 *
 * The question matters because the answer decides whether a database is
 * created. A session started in `~` or `/tmp` gets the common memory and no
 * project memory at all: minting one per visited folder turns the workspace
 * into a junkyard of near-empty databases, each of which then has to be
 * explained to whoever opens the folder later.
 *
 * The filesystem is injected so the walk is testable without laying down real
 * directories, and so the Windows path shape is testable at all.
 */

import type path from "node:path";

/** The subset of `node:path` this module needs. */
export type PathFlavour = Pick<
	typeof path.posix,
	"dirname" | "join" | "resolve"
>;

/**
 * Just enough filesystem to answer "does this exist".
 *
 * Either shape is accepted so the real async `FileOps` satisfies it directly,
 * with no sync bridge to maintain, while a test can hand over a plain set.
 */
export interface ExistenceCheck {
	exists(candidate: string): boolean | Promise<boolean>;
}

/**
 * What makes a directory a project root, nearest match winning.
 *
 * `.git` is first because it is the marker that actually delimits a repository;
 * the manifests behind it cover what is not version controlled yet.
 */
export const PROJECT_MARKERS: readonly string[] = [
	".git",
	"package.json",
	"Cargo.toml",
	"pyproject.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"composer.json",
	"Gemfile",
	"deno.json",
	"pubspec.yaml",
	"CMakeLists.txt",
	".pi",
];

export interface DetectOptions {
	fs: ExistenceCheck;
	flavour: PathFlavour;
	markers?: readonly string[];
	/**
	 * A directory that is never a project, however it looks - the user's home.
	 *
	 * It has to be excluded by name rather than by marker, because pi itself
	 * keeps `~/.pi`, and `.pi` is one of the markers. Without this, EVERY user
	 * has a home directory that answers "yes, I am a project", so a session
	 * started anywhere outside a real project files its facts under a project
	 * named after the user's login. Observed live: `Stored [f0] in this project
	 * (m62624)`.
	 *
	 * Excluded rather than reordered: dropping `.pi` from the markers would also
	 * stop a real project-local `.pi/` from being recognised, which is the case
	 * the marker exists for.
	 */
	home?: string;
}

/**
 * The nearest ancestor of `from` (inclusive) that looks like a project root, or
 * `undefined` when there is none.
 *
 * Nearest, not outermost: a package inside a monorepo is its own project,
 * because its conventions and its gotchas are not the root's.
 */
export async function detectProjectRoot(
	from: string,
	options: DetectOptions,
): Promise<string | undefined> {
	const { fs, flavour } = options;
	const markers = options.markers ?? PROJECT_MARKERS;
	// Compared as resolved paths so `~/x/..` and a trailing separator do not
	// slip past the exclusion; `resolve` also settles the Windows separator and
	// drive-letter shape, which is why the flavour is injected.
	const home =
		options.home === undefined ? undefined : flavour.resolve(options.home);

	let current = flavour.resolve(from);
	for (;;) {
		if (home !== undefined && current === home) return undefined;
		for (const marker of markers) {
			if (await fs.exists(flavour.join(current, marker))) return current;
		}
		const parent = flavour.dirname(current);
		// `dirname` of a root is that root; that fixed point is the stop
		// condition, and without it this walks forever on `/`.
		if (parent === current) return undefined;
		current = parent;
	}
}
