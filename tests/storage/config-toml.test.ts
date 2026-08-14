/**
 * The one file this extension writes for plugmem.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_PLUGMEM_CONFIG } from "../../src/storage/config-toml.ts";

describe("DEFAULT_PLUGMEM_CONFIG", () => {
	it("degrades rather than fails when the provider is unreachable", () => {
		expect(DEFAULT_PLUGMEM_CONFIG).toContain('on_error = "degrade"');
	});

	it("leaves the embedder off, so a machine without one still works", () => {
		expect(DEFAULT_PLUGMEM_CONFIG).toContain("enabled = false");
	});

	it("names every key it would be wasted effort to set", () => {
		// The one trap this file can set for somebody configuring it. Named one by
		// one rather than as "those two sections", because a person setting
		// max_open has no other way to learn that the extension overrides it.
		for (const key of [
			"[database].path",
			"[workspace].dir",
			"[workspace].max_open",
			"[workspace].idle_timeout_ms",
			"[server].workers",
		]) {
			expect(
				DEFAULT_PLUGMEM_CONFIG,
				`${key} is not named as ineffective`,
			).toContain(key);
		}
		expect(DEFAULT_PLUGMEM_CONFIG).toMatch(/does not move the databases/);
	});

	it("points at the full list rather than pretending to be it", () => {
		// The file sets a handful of keys, and somebody reading it has no way to
		// know that every other key plugmem takes works here too - unless it says
		// so and links to where they are documented.
		expect(DEFAULT_PLUGMEM_CONFIG).toContain(
			"https://github.com/m62624/plugmem/blob/main/config.example.toml",
		);
		expect(DEFAULT_PLUGMEM_CONFIG).toMatch(
			/every key plugmem\s+# takes works/i,
		);
	});

	it("carries no credential, only the name of a variable", () => {
		expect(DEFAULT_PLUGMEM_CONFIG).toContain("api_key_env");
		expect(DEFAULT_PLUGMEM_CONFIG).toMatch(/never a token/i);
	});
});
