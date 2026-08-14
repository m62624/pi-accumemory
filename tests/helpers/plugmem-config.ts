/**
 * Writing the `config.toml` a test's session should open with.
 *
 * The embedder is plugmem's business, said in plugmem's file - so "configure an
 * embedder" means "put a file where the extension will find it". A test that
 * changes the embedder between two sessions has to rewrite that file, because
 * the extension writes one only when there is none and never touches it again.
 *
 * The TOML is assembled here rather than by anything in `src/`: production code
 * has exactly one config file to write, the default one, and a builder that
 * exists only for tests belongs with the tests.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface EmbedderConfig {
	enabled?: boolean;
	url?: string;
	model?: string;
	dim?: number;
	spaceId?: string | null;
	/** plugmem's own behaviour when the provider will not answer. */
	onError?: "degrade" | "fail";
}

/** Writes (or overwrites) the config file, embedder section and all. */
export async function writeEmbedderConfig(
	file: string,
	embedder: EmbedderConfig = {},
): Promise<void> {
	const {
		enabled = true,
		url = "http://localhost:11434/v1/embeddings",
		model = "bge-m3",
		dim = 1024,
		spaceId = null,
		onError = "degrade",
	} = embedder;
	const lines = [
		"# Written by a test.",
		"",
		"[engine]",
		`dim = ${dim}`,
		"",
		"[embedder]",
		`enabled = ${enabled}`,
		`url = ${quote(url)}`,
		`model = ${quote(model)}`,
		`on_error = ${quote(onError)}`,
	];
	if (spaceId) lines.push(`space_id = ${quote(spaceId)}`);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${lines.join("\n")}\n`, "utf8");
}

/** A config with no embedder at all, which is the default a machine gets. */
export async function writeConfigWithoutEmbedder(file: string): Promise<void> {
	await writeEmbedderConfig(file, { enabled: false, dim: 0 });
}

function quote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
