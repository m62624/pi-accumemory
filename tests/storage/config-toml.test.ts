import { describe, expect, it } from "vitest";
import type { EmbedderSettings } from "../../src/settings/defaults.ts";
import {
	buildPlugmemConfig,
	validateEmbedder,
} from "../../src/storage/config-toml.ts";

const base: EmbedderSettings = {
	enabled: true,
	url: "http://localhost:11434/v1/embeddings",
	model: "bge-m3",
	apiKeyEnv: null,
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

	it("ends with a newline", () => {
		expect(buildPlugmemConfig(base).endsWith("\n")).toBe(true);
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
