/**
 * Where everything this extension owns lives on disk.
 *
 * One module, so that no other file ever joins a path by hand. Nothing here
 * touches the filesystem — it is pure string work, which is what makes the
 * Windows layout checkable from a Linux test run.
 */

import type path from "node:path";

/** The subset of `node:path` this module needs; `path.win32` or `path.posix`. */
export type PathFlavour = Pick<typeof path.posix, "join" | "sep">;

/** The extension's directory name under `<agentDir>/extensions`. */
export const EXTENSION_DIR = "pi-accumemory";

/** The shared database: facts about the user, plus the project router. */
export const COMMON_DB = "common";

/** A project id is a bare identifier — nothing that can act as a path. */
const PROJECT_ID = /^[A-Za-z0-9_-]+$/;

export interface ExtensionLayout {
	/** `<agentDir>/extensions/pi-accumemory` */
	root: string;
	/** The plugmem workspace root; `db/` and `registry.plugmem` appear inside. */
	memoryDir: string;
	/** Generated from settings; one per workspace because `dim` is per workspace. */
	configToml: string;
	notesDir: string;
	commonNotesDir: string;
	/** Note bodies for one project. */
	projectNotesDir(projectId: string): string;
	/** Bundled instruction text; overwritten on upgrade. */
	instructionsDefaultsDir: string;
	/** The user's global additions; never overwritten. */
	instructionsAppendDir: string;
	stateDir: string;
	/** How far the consolidation pass has read each project's transcript. */
	consolidationStateFile: string;
	/** How far the review phase has walked each memory. */
	reviewStateFile: string;
	/** Mistakes this model has repeated, counted across sessions. */
	stumbleStateFile: string;
	settingsFile: string;
}

/** Derives the whole layout from pi's agent directory. */
export function extensionLayout(
	agentDir: string,
	flavour: PathFlavour,
): ExtensionLayout {
	const join = (...parts: string[]) => flavour.join(...parts);
	const root = join(agentDir, "extensions", EXTENSION_DIR);
	const notesDir = join(root, "notes");
	const instructionsDir = join(root, "instructions");
	const stateDir = join(root, "state");

	return {
		root,
		memoryDir: join(root, "memory"),
		configToml: join(root, "memory", "config.toml"),
		notesDir,
		commonNotesDir: join(notesDir, "common"),
		projectNotesDir: (projectId: string) => {
			assertProjectId(projectId);
			return join(notesDir, "projects", projectId);
		},
		instructionsDefaultsDir: join(instructionsDir, "defaults"),
		instructionsAppendDir: join(instructionsDir, "append"),
		stateDir,
		consolidationStateFile: join(stateDir, "consolidation.json"),
		reviewStateFile: join(stateDir, "review.json"),
		stumbleStateFile: join(stateDir, "stumbles.json"),
		settingsFile: join(root, "settings.json"),
	};
}

/**
 * The workspace name of a project's database.
 *
 * Prefixed so it can never collide with {@link COMMON_DB} — the shared database
 * is the one file whose contents reach every project, and a project that
 * managed to be named `common` would write into all of them.
 */
export function projectDbName(projectId: string): string {
	assertProjectId(projectId);
	return `p_${projectId}`;
}

/**
 * The project's own instruction append directory.
 *
 * It sits inside the project rather than beside the databases so a team can
 * commit it: instructions about *this* codebase belong to the codebase.
 */
export function projectAppendDir(
	projectRoot: string,
	flavour: PathFlavour,
): string {
	return flavour.join(
		projectRoot,
		".pi",
		EXTENSION_DIR,
		"instructions",
		"append",
	);
}

function assertProjectId(projectId: string): void {
	if (!PROJECT_ID.test(projectId)) {
		throw new Error(`layout: invalid project id ${JSON.stringify(projectId)}`);
	}
}
