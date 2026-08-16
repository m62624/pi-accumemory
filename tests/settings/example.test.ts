import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import { parseSettings } from "../../src/settings/schema.ts";

/**
 * SETTINGS.md publishes the complete default document. Documentation that
 * drifts from the code is worse than none, because it is believed - so the
 * published block is parsed here and compared against the real defaults.
 */
async function publishedExample(): Promise<string> {
	const doc = await readFile(
		new URL("../../SETTINGS.md", import.meta.url),
		"utf8",
	);
	const block = /<!-- settings-example -->\s*```json\n([\s\S]*?)```/.exec(doc);
	if (block?.[1] === undefined)
		throw new Error("SETTINGS.md has no settings-example block");
	return block[1];
}

describe("the settings example in SETTINGS.md", () => {
	it("is valid JSON", async () => {
		const example = await publishedExample();
		expect(() => JSON.parse(example)).not.toThrow();
	});

	it("is accepted with no warnings, so no key in it is misspelled", async () => {
		const { warnings } = parseSettings(
			JSON.parse(await publishedExample()) as unknown,
		);
		expect(warnings).toEqual([]);
	});

	it("matches the real defaults exactly", async () => {
		const { settings } = parseSettings(
			JSON.parse(await publishedExample()) as unknown,
		);
		expect(settings).toEqual(DEFAULT_SETTINGS);
	});

	it("names every command the extension registers", async () => {
		const doc = await readFile(
			new URL("../../SETTINGS.md", import.meta.url),
			"utf8",
		);
		for (const command of [
			"/longterm-status",
			"/longterm-inspect",
			"/longterm-new",
			"/longterm-rebind",
			"/longterm-consolidate",
			"/longterm-reembed",
		]) {
			expect(doc).toContain(command);
		}
	});

	it("links to plugmem's full key list instead of only naming it", async () => {
		// The generated config.toml sets five or six keys. Without a link, a
		// reader has no way to discover that every other key the engine takes
		// works there too - and the engine's documentation lives in its own
		// repository, not in this one.
		const doc = await readFile(
			new URL("../../SETTINGS.md", import.meta.url),
			"utf8",
		);
		expect(doc).toContain(
			"https://github.com/m62624/plugmem/blob/main/config.example.toml",
		);
		expect(doc).toMatch(/every key plugmem\s+takes works/i);
	});

	it("warns that a project instruction file replaces the global one", async () => {
		// The failure is silent: someone adds a project file and their global
		// text stops applying with no message anywhere.
		const doc = await readFile(
			new URL("../../SETTINGS.md", import.meta.url),
			"utf8",
		);
		expect(doc).toMatch(/replaces the global one.*not merged/is);
	});

	it("explains that a model change is repaired automatically", async () => {
		// The behaviour a user would otherwise discover as a failed lookup in
		// the middle of their work.
		const doc = await readFile(
			new URL("../../SETTINGS.md", import.meta.url),
			"utf8",
		);
		expect(doc).toMatch(/autoReembed.*on by default/is);
		expect(doc).toContain("vector space mismatch");
		expect(doc).toContain("/longterm-reembed");
	});

	it("says a rebuild is resumable, because a partial one is normal", async () => {
		const doc = await readFile(
			new URL("../../SETTINGS.md", import.meta.url),
			"utf8",
		);
		expect(doc).toMatch(/resumable|running it again/i);
	});
});
