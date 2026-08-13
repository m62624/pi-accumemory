import { describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	type EmbedderSettings,
} from "../../src/settings/defaults.ts";
import {
	buildPlugmemConfig,
	DEFAULT_PLUGMEM_CONFIG,
	embedderWasConfigured,
	validateEmbedder,
} from "../../src/storage/config-toml.ts";

const base: EmbedderSettings = {
	enabled: true,
	url: "http://localhost:11434/v1/embeddings",
	model: "bge-m3",
	apiKeyEnv: null,
	spaceId: null,
	dim: 1024,
};

describe("buildPlugmemConfig", () => {
	it("writes the engine width and the embedder section", () => {
		const toml = buildPlugmemConfig(base);
		expect(toml).toContain("[engine]\ndim = 1024");
		expect(toml).toContain("[embedder]");
		expect(toml).toContain('model = "bge-m3"');
		expect(toml).toContain("enabled = true");
	});

	it("writes the width even when the embedder is off", () => {
		// The width is baked into every database at creation. Declaring the
		// intended one now means switching the embedder on later is a reembed,
		// not a rebuild.
		expect(buildPlugmemConfig({ ...base, enabled: false })).toContain(
			"dim = 1024",
		);
	});

	it("omits api_key_env when there is none", () => {
		expect(buildPlugmemConfig(base)).not.toContain("api_key_env");
		expect(buildPlugmemConfig({ ...base, apiKeyEnv: "  " })).not.toContain(
			"api_key_env",
		);
	});

	it("writes only the variable name, never a key", () => {
		const toml = buildPlugmemConfig({ ...base, apiKeyEnv: "OLLAMA_TOKEN" });
		expect(toml).toContain('api_key_env = "OLLAMA_TOKEN"');
	});

	it("escapes quotes and backslashes so the file still parses", () => {
		const toml = buildPlugmemConfig({ ...base, model: 'we"ird\\name' });
		expect(toml).toContain('model = "we\\"ird\\\\name"');
	});

	it("omits space_id unless it is pinned", () => {
		// Left out, plugmem derives the space from the model name - so changing
		// the model changes the space, which is the safe default: vectors from
		// two different models are not comparable.
		expect(buildPlugmemConfig(base)).not.toContain("space_id");
		expect(buildPlugmemConfig({ ...base, spaceId: "  " })).not.toContain(
			"space_id",
		);
	});

	it("writes a pinned space_id", () => {
		// Pinning it is how you swap endpoints or aliases for the SAME model
		// without triggering a rebuild.
		expect(buildPlugmemConfig({ ...base, spaceId: "my-space" })).toContain(
			'space_id = "my-space"',
		);
	});

	it("ends with a newline", () => {
		expect(buildPlugmemConfig(base).endsWith("\n")).toBe(true);
	});

	it("adds the policy the old settings had no way to state", () => {
		// settings.json never had an equivalent, the old behaviour was to fail,
		// and an outage is worth surviving - so the migration writes the new
		// default explicitly rather than leaving it to whatever plugmem ships.
		expect(buildPlugmemConfig(base)).toContain('on_error = "degrade"');
	});

	it("does not promise to overwrite a file that is now the user's", () => {
		expect(buildPlugmemConfig(base)).not.toMatch(/overwritten/i);
	});
});

describe("DEFAULT_PLUGMEM_CONFIG", () => {
	it("degrades rather than fails when the provider is unreachable", () => {
		expect(DEFAULT_PLUGMEM_CONFIG).toContain('on_error = "degrade"');
	});

	it("leaves the embedder off, so a machine without one still works", () => {
		expect(DEFAULT_PLUGMEM_CONFIG).toContain("enabled = false");
	});

	it("says that [database] and [workspace] do nothing here", () => {
		// Every database is opened by an explicit path, so those two sections
		// are the one trap this file can set for somebody configuring it.
		expect(DEFAULT_PLUGMEM_CONFIG).toMatch(
			/\[database\] and \[workspace\] .*do nothing/,
		);
	});

	it("carries no credential, only the name of a variable", () => {
		expect(DEFAULT_PLUGMEM_CONFIG).toContain("api_key_env");
		expect(DEFAULT_PLUGMEM_CONFIG).toMatch(/never a token/i);
	});
});

describe("embedderWasConfigured", () => {
	it("is false for settings nobody touched", () => {
		// The defaults carry no information, so a migration must not treat them
		// as an embedder worth carrying over.
		expect(embedderWasConfigured(DEFAULT_SETTINGS.memory.embedder)).toBe(false);
	});

	it("is true once any key differs", () => {
		expect(
			embedderWasConfigured({
				...DEFAULT_SETTINGS.memory.embedder,
				enabled: true,
			}),
		).toBe(true);
	});
});

describe("validateEmbedder", () => {
	it("accepts a complete enabled embedder", () => {
		expect(() => validateEmbedder(base)).not.toThrow();
	});

	it("ignores an incomplete disabled embedder", () => {
		expect(() =>
			validateEmbedder({ ...base, enabled: false, url: "", dim: 0 }),
		).not.toThrow();
	});

	it("names the offending key", () => {
		expect(() => validateEmbedder({ ...base, url: "" })).toThrow(
			/memory\.embedder\.url/,
		);
		expect(() => validateEmbedder({ ...base, model: " " })).toThrow(
			/memory\.embedder\.model/,
		);
		expect(() => validateEmbedder({ ...base, dim: 0 })).toThrow(
			/memory\.embedder\.dim/,
		);
	});
});
