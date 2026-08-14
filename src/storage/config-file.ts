/**
 * Finding plugmem's `config.toml`, and putting one there when there is none.
 *
 * The file belongs to the user, not to this extension. plugmem already
 * documents every key it takes, validates them itself and reports what it did
 * not understand; mirroring a chosen few of them into `settings.json` bought
 * nothing but two places to state the same thing and a code change for every
 * key the engine gains. So `settings.json` says only WHERE the file is, and
 * everything about the engine is said in the file.
 *
 * What that costs is the early complaint: an impossible embedder is now caught
 * when the database opens rather than while the user is still looking at their
 * settings. plugmem names the file and the key when it refuses, which is the
 * same information one step later.
 */

import type { FileOps } from "../fs-ops.ts";
import { DEFAULT_PLUGMEM_CONFIG } from "./config-toml.ts";

/** The `node:path` surface this needs; `path.win32` or `path.posix`. */
export interface PathFlavour {
	join(...parts: string[]): string;
	dirname(file: string): string;
	isAbsolute(candidate: string): boolean;
	normalize(candidate: string): string;
}

export interface ConfigFileOptions {
	fs: FileOps;
	flavour: PathFlavour;
	/** The extension's own directory; a relative setting is read from here. */
	root: string;
	/** Where the file lives when the setting is `null`. */
	defaultPath: string;
	/** `memory.plugmemConfig`. */
	configured: string | null;
	/** Expands a leading `~`; injected so the rule is testable. */
	home?: string;
}

export interface ConfigFile {
	path: string;
	/** True when this call wrote it, which is what a caller reports. */
	created: boolean;
	/** One sentence for the user; empty when there is nothing to say. */
	notice: string;
}

/**
 * Resolves the configured path.
 *
 * Relative to the extension's own directory rather than the working directory:
 * pi starts wherever the user happens to be, and a config file that moves with
 * the shell is a config file nobody can find twice.
 */
export function resolveConfigPath(
	options: Pick<
		ConfigFileOptions,
		"flavour" | "root" | "defaultPath" | "configured" | "home"
	>,
): string {
	const { flavour, configured } = options;
	const raw = configured?.trim() ?? "";
	if (raw === "") return options.defaultPath;
	const expanded =
		options.home !== undefined && (raw === "~" || raw.startsWith("~/"))
			? flavour.join(options.home, raw.slice(1))
			: raw;
	return flavour.normalize(
		flavour.isAbsolute(expanded)
			? expanded
			: flavour.join(options.root, expanded),
	);
}

/**
 * The file plugmem will be opened with, guaranteed to exist.
 *
 * Missing means missing, in both directions: at the default location it is
 * simply written back, so deleting the file is how you return to the defaults.
 * At a location the user NAMED, it is written back too - but said out loud,
 * because a path that points at nothing is a typo far more often than it is a
 * request, and quietly running on defaults is how somebody edits a file for an
 * hour and wonders why nothing changes.
 */
export async function ensurePlugmemConfig(
	options: ConfigFileOptions,
): Promise<ConfigFile> {
	const { fs, flavour } = options;
	const path = resolveConfigPath(options);
	const named = (options.configured?.trim() ?? "") !== "";

	if (await fs.exists(path)) return { path, created: false, notice: "" };

	await fs.mkdir(flavour.dirname(path));
	await fs.writeFile(path, DEFAULT_PLUGMEM_CONFIG);
	return {
		path,
		created: true,
		notice: named
			? `There was no config file at ${path}, so a default one was written there. ` +
				"Edit it to configure plugmem."
			: "",
	};
}
