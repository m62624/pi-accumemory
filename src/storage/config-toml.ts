/**
 * What goes into a `config.toml` this extension writes.
 *
 * It writes one exactly twice: the first time a workspace exists at all, and
 * the first time an older installation's `memory.embedder` settings need a home.
 * After that the file is the user's, and plugmem is the only thing that reads
 * it. See `config-file.ts` for who owns what.
 *
 * Pure: settings in, a string out. Writing it is someone else's job.
 */

import {
	DEFAULT_SETTINGS,
	type EmbedderSettings,
} from "../settings/defaults.ts";

/**
 * The file a fresh installation gets.
 *
 * Deliberately short. plugmem's own `config.example.toml` lists every key it
 * takes with its default, and copying that here would freeze today's defaults
 * into every user's file; what belongs here is the handful of lines somebody
 * has to change to get semantic memory working, and a pointer to the rest.
 */
export const DEFAULT_PLUGMEM_CONFIG = `# plugmem's configuration for pi-accumemory's memories.
#
# This file is yours. pi-accumemory writes it once, when it is not there, and
# never edits it afterwards - so delete it to get these defaults back.
#
# Only the keys below are set; everything else stays at plugmem's own tuned
# defaults. The full list, with every default and what it is for, is in
# plugmem's config.example.toml and SETTINGS.md.
#
# Four keys are read by nothing here, so setting them is wasted effort:
#
#   [database].path            - every memory is opened by an explicit path (one
#   [workspace].dir              per project, plus the shared one), so neither of
#                                these decides where anything lives. Moving THIS
#                                file elsewhere does not move the databases.
#   [workspace].max_open       - the workspace pool is not used at all: this
#   [workspace].idle_timeout_ms  extension opens each database itself.
#
# Everything else applies to every memory here - [engine], [embedder], and
# [recall] / [maintenance] if you add them.

[engine]
# Embedding width. It has to match what the model actually returns, and it is
# written into each database at creation - changing it later means a rebuild
# (/longterm-reembed), which the extension can also do by itself.
dim = 1024

[embedder]
# Off by default, so a machine with no embedding service still works. Switching
# it on is what lets a question worded differently from the stored fact find it
# at all, which is most of the point of this extension.
enabled = false
url = "http://localhost:11434/v1/embeddings"
model = "bge-m3"
# An unreachable provider stores and answers WITHOUT a vector rather than
# failing the call, and suspends itself until it can be reached again. The
# facts written meanwhile get their vectors on the next start, or from
# /longterm-reembed. Set to "fail" to be refused instead.
on_error = "degrade"
# The NAME of an environment variable holding the bearer token - never a token.
# api_key_env = "OPENAI_API_KEY"
`;

/**
 * Whether these embedder settings were ever touched.
 *
 * The question a migration has to answer is "does this user have an embedder
 * worth carrying over", and settings that are byte-for-byte the defaults are
 * the ones nobody chose. They carry no information, so they are not carried.
 */
export function embedderWasConfigured(embedder: EmbedderSettings): boolean {
	const defaults = DEFAULT_SETTINGS.memory.embedder;
	return (Object.keys(defaults) as (keyof EmbedderSettings)[]).some(
		(key) => embedder[key] !== defaults[key],
	);
}

/**
 * Rejects an embedder plugmem would reject.
 *
 * Only ever applied to the settings being migrated: they came from a file the
 * user wrote, so naming the offending key beats handing them the engine's
 * complaint about a TOML file they have never seen. Anything typed into
 * `config.toml` afterwards is plugmem's to judge, and it does.
 */
export function validateEmbedder(
	embedder: EmbedderSettings,
	at = "memory.embedder",
): void {
	// A disabled embedder keeps its settings, dimension included. That is what
	// lets it be switched back on without changing a database's fixed width.
	if (!embedder.enabled) return;
	if (embedder.url.trim() === "") {
		throw new TypeError(`${at}.url is required when ${at}.enabled is true`);
	}
	if (embedder.model.trim() === "") {
		throw new TypeError(`${at}.model is required when ${at}.enabled is true`);
	}
	if (embedder.dim <= 0) {
		throw new TypeError(
			`${at}.dim must be greater than 0 when ${at}.enabled is true`,
		);
	}
}

/**
 * A TOML basic string.
 *
 * These are a URL, a model name and an environment variable name, all typed by
 * hand. Escaped rather than trusted: an unescaped quote here surfaces later as
 * "the memory will not open", which is a long way from its cause.
 */
function tomlString(value: string): string {
	const escaped = value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t");
	return `"${escaped}"`;
}

/**
 * The same embedder, said in TOML - the one-time move out of `settings.json`.
 *
 * Only `[engine].dim` and `[embedder]` are written, because those are the only
 * things the old settings could say. From here on the file is edited by hand,
 * and everything else plugmem takes is available there.
 *
 * `dim` is written even when the embedder is disabled. Not because the width is
 * frozen at creation - an existing file is authoritative about its own stride,
 * and a reembed rebuilds the pool at a new width from the stored text - but
 * because it is what the user had, and a migration that quietly changed a number
 * would be a migration that lost something.
 *
 * `on_error` is the one thing added rather than translated: settings.json had no
 * such key, the old behaviour was to fail, and the new default is worth having.
 * It is written explicitly so the file says what it does.
 */
export function buildPlugmemConfig(embedder: EmbedderSettings): string {
	const lines = [
		"# Moved here from settings.json (memory.embedder.*) by pi-accumemory.",
		"#",
		"# This file is yours now: nothing overwrites it, and plugmem is the only",
		"# thing that reads it. Every other key it takes - recall weights, the",
		"# maintenance triggers - is documented in plugmem's config.example.toml.",
		"",
		"[engine]",
		`dim = ${embedder.dim}`,
		"",
		"[embedder]",
		`enabled = ${embedder.enabled}`,
		`url = ${tomlString(embedder.url)}`,
		`model = ${tomlString(embedder.model)}`,
		"# An unreachable provider stores and answers without a vector instead of",
		'# failing the call, and retries by itself. Set to "fail" to be refused.',
		'on_error = "degrade"',
	];
	// Written only when pinned. Left out, plugmem derives the space from the
	// model name, so changing the model changes the space - which is the safe
	// default, because vectors from two models are not comparable.
	const spaceId = embedder.spaceId?.trim();
	if (spaceId) lines.push(`space_id = ${tomlString(spaceId)}`);
	const apiKeyEnv = embedder.apiKeyEnv?.trim();
	if (apiKeyEnv) lines.push(`api_key_env = ${tomlString(apiKeyEnv)}`);
	return `${lines.join("\n")}\n`;
}
