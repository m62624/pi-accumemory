/**
 * Writing the `config.toml` a test's session should open with.
 *
 * Since the embedder left `settings.json`, "configure an embedder" means "put a
 * file where the extension will find it" - and a test that changes the embedder
 * between two sessions has to rewrite that file, because the extension will not
 * touch one that already exists.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import { buildPlugmemConfig } from "../../src/storage/config-toml.ts";

export interface EmbedderConfig {
	enabled?: boolean;
	url?: string;
	model?: string;
	dim?: number;
	spaceId?: string | null;
}

/** Writes (or overwrites) the config file, embedder section and all. */
export async function writeEmbedderConfig(
	file: string,
	embedder: EmbedderConfig = {},
): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(
		file,
		buildPlugmemConfig({
			...DEFAULT_SETTINGS.memory.embedder,
			enabled: true,
			...embedder,
		}),
		"utf8",
	);
}

/** A config with no embedder at all, which is the default a machine gets. */
export async function writeConfigWithoutEmbedder(file: string): Promise<void> {
	await writeEmbedderConfig(file, { enabled: false, dim: 0 });
}
