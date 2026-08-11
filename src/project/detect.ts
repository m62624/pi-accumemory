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

	let current = from;
	for (;;) {
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
