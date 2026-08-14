/**
 * Which memory belongs to the folder a session was started in.
 *
 * Two questions, asked walking up from the working directory, and the order
 * between them is the whole design:
 *
 * 1. **does an ancestor already have a memory?** A memory bound to a folder is
 *    something a person decided, or something that was created for them once
 *    and has been in use since. It beats anything derived from the files lying
 *    around, and it is what lets one memory serve a whole tree - bind the root
 *    of a monorepo and every package inside it inherits, until somebody gives a
 *    package its own with `/longterm-new`, which then wins by being nearer.
 * 2. **does an ancestor look like a project root?** Only if the first question
 *    found nothing. This is the guess, and it is configurable precisely because
 *    it is a guess: `memory.project.markers` defaults to `.git` alone, and an
 *    empty list switches guessing off entirely.
 *
 * The walk is bounded (`memory.project.maxParents`) and starts from the REAL
 * path. Resolving symlinks first is not a detail: without it the same folder
 * reached through a link and through its own name is two identities with two
 * memories, and a link pointing back up its own tree is a walk with no end.
 *
 * The filesystem is injected so all of this is testable without laying down
 * real directories - and so the Windows path shape is testable at all.
 */

import type path from "node:path";

/** The subset of `node:path` this module needs. */
export type PathFlavour = Pick<
	typeof path.posix,
	"dirname" | "join" | "resolve"
>;

/**
 * Just enough filesystem to answer "does this exist" and "what is this really".
 *
 * `exists` accepts either shape so the real async `FileOps` satisfies it
 * directly, with no sync bridge to maintain, while a test can hand over a plain
 * set.
 */
export interface ExistenceCheck {
	exists(candidate: string): boolean | Promise<boolean>;
	/**
	 * The path with every symlink resolved, or the path itself when it cannot
	 * be resolved (it does not exist yet, or the platform refuses).
	 */
	realPath?(candidate: string): string | Promise<string>;
}

/**
 * What makes a directory a project root when nothing else has claimed it.
 *
 * One entry, and that is the point. The list used to name every ecosystem's
 * manifest, which got the granularity wrong in both directions at once: a
 * package inside a repository became a separate memory nobody asked for, and a
 * folder with no manifest got none at all. `.git` is the marker that actually
 * delimits a body of work; anything else is a preference, and preferences live
 * in settings.
 */
export const PROJECT_MARKERS: readonly string[] = [".git"];

/** How far up the tree the search goes when nothing says otherwise. */
export const DEFAULT_MAX_PARENTS = 16;

export interface LocateOptions {
	fs: ExistenceCheck;
	flavour: PathFlavour;
	/** Names that make a folder a project root; empty means "never guess". */
	markers?: readonly string[];
	/** Parent folders the walk may climb; `0` looks at `from` alone. */
	maxParents?: number;
	/**
	 * Whether this exact folder already has a memory. Native path in.
	 *
	 * Injected rather than imported: this module knows about folders, and the
	 * router knows about memories, and neither needs the other's dependencies.
	 */
	hasMemory?: (dir: string) => boolean | Promise<boolean>;
	/**
	 * A directory that is never a project BY MARKER - the user's home.
	 *
	 * It has to be excluded by name rather than by marker: people keep a `.git`
	 * in their home directory for their dotfiles, and without this every
	 * session started anywhere outside a real project files its facts under a
	 * project named after the user's login. Observed live, back when `.pi` was
	 * a marker: `Stored [f0] in this project (m62624)`.
	 *
	 * An existing memory at home is still honoured. The rule is about guessing,
	 * and somebody who ran `/longterm-new` there was not guessing.
	 */
	home?: string;
}

export interface LocatedProject {
	/** The folder whose memory this is, as a real, resolved path. */
	root: string;
	/** `"memory"` when an existing binding was found, `"marker"` when guessed. */
	source: "memory" | "marker";
}

/**
 * The folder whose memory covers `from`, or `undefined` when there is none.
 *
 * Nearest wins in both passes: a package inside a monorepo can have its own
 * memory, because its gotchas are not the root's - but only if somebody said
 * so.
 */
export async function locateProject(
	from: string,
	options: LocateOptions,
): Promise<LocatedProject | undefined> {
	const chain = await ancestry(from, options);

	if (options.hasMemory !== undefined) {
		for (const dir of chain) {
			if (await options.hasMemory(dir)) return { root: dir, source: "memory" };
		}
	}

	const markers = options.markers ?? PROJECT_MARKERS;
	if (markers.length === 0) return undefined;
	const home =
		options.home === undefined
			? undefined
			: options.flavour.resolve(options.home);
	for (const dir of chain) {
		if (dir === home) return undefined;
		for (const marker of markers) {
			if (await options.fs.exists(options.flavour.join(dir, marker))) {
				return { root: dir, source: "marker" };
			}
		}
	}
	return undefined;
}

/**
 * `from` and its parents, nearest first, real paths, bounded.
 *
 * Two stop conditions, and both are needed. `dirname` of a root is that root,
 * which is the natural end of the climb; `maxParents` is the one that holds
 * when the path is pathological - a resolved path cannot loop, but the cost of
 * assuming so is an unbounded loop on somebody's machine, and the cost of the
 * check is one comparison.
 */
async function ancestry(
	from: string,
	options: LocateOptions,
): Promise<string[]> {
	const { flavour } = options;
	const resolved = flavour.resolve(from);
	const start =
		options.fs.realPath === undefined
			? resolved
			: await options.fs.realPath(resolved);
	const limit = Math.max(0, options.maxParents ?? DEFAULT_MAX_PARENTS);

	const chain = [start];
	const seen = new Set(chain);
	let current = start;
	for (let climbed = 0; climbed < limit; climbed += 1) {
		const parent = flavour.dirname(current);
		if (parent === current || seen.has(parent)) break;
		chain.push(parent);
		seen.add(parent);
		current = parent;
	}
	return chain;
}
