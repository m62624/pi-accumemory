import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import { parseSettings } from "../../src/settings/schema.ts";

describe("parseSettings", () => {
	it("returns the defaults for an empty object", () => {
		const { settings, warnings } = parseSettings({});
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warnings).toEqual([]);
	});

	it("returns the defaults when the file is absent", () => {
		expect(parseSettings(undefined).settings).toEqual(DEFAULT_SETTINGS);
		expect(parseSettings(null).settings).toEqual(DEFAULT_SETTINGS);
	});

	it("overlays a single nested key without dropping its siblings", () => {
		const { settings } = parseSettings({
			memory: { nudge: { afterMessages: 5 } },
		});
		expect(settings.memory.nudge.afterMessages).toBe(5);
		expect(settings.memory.nudge.afterToolCalls).toBe(
			DEFAULT_SETTINGS.memory.nudge.afterToolCalls,
		);
		expect(settings.memory.enabled).toBe(DEFAULT_SETTINGS.memory.enabled);
	});

	it("never mutates the defaults", () => {
		parseSettings({ memory: { nudge: { afterMessages: 5 } } });
		expect(DEFAULT_SETTINGS.memory.nudge.afterMessages).not.toBe(5);
	});

	it("warns about an unknown key instead of failing", () => {
		// A typo that changes nothing and says nothing is the worst outcome; a
		// typo that stops the extension is worse than one that is reported.
		const { warnings } = parseSettings({
			memory: { nudje: { afterMessages: 5 } },
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("memory.nudje");
	});

	it("warns about an unknown top-level key", () => {
		const { warnings } = parseSettings({ memoyr: {} });
		expect(warnings[0]).toContain("memoyr");
	});

	it("fails loudly on a wrong type, naming the full path", () => {
		expect(() => parseSettings({ memory: { enabled: "yes" } })).toThrow(
			/memory\.enabled.*boolean/i,
		);
		expect(() =>
			parseSettings({ memory: { nudge: { afterMessages: "25" } } }),
		).toThrow(/memory\.nudge\.afterMessages.*number/i);
		expect(() => parseSettings({ timezone: 3 })).toThrow(/timezone.*string/i);
	});

	it("rejects a negative or fractional count", () => {
		expect(() =>
			parseSettings({ memory: { nudge: { afterMessages: -1 } } }),
		).toThrow(/afterMessages/);
		expect(() =>
			parseSettings({ memory: { nudge: { afterMessages: 1.5 } } }),
		).toThrow(/afterMessages/);
	});

	it("accepts null where the schema allows it", () => {
		const { settings } = parseSettings({ memory: { graphDepth: null } });
		expect(settings.memory.graphDepth).toBeNull();
		const withDepth = parseSettings({ memory: { graphDepth: 2 } });
		expect(withDepth.settings.memory.graphDepth).toBe(2);
	});

	it("rejects a scalar where a section is expected", () => {
		expect(() => parseSettings({ memory: 5 })).toThrow(/memory.*object/i);
	});

	it("rejects a non-object document", () => {
		expect(() => parseSettings([])).toThrow(/object/i);
		expect(() => parseSettings("nope")).toThrow(/object/i);
	});

	it("reports the retired embedder section as an unknown key", () => {
		// It configured the embedder before plugmem's own config.toml did. There
		// was never a release with it, so there is nothing to migrate - but a
		// key nothing claims is still worth naming rather than swallowing.
		const { warnings } = parseSettings({
			memory: { embedder: { enabled: true } },
		});
		expect(warnings.join(" ")).toContain("memory.embedder");
	});

	it("takes a marker list and a walk limit for project detection", () => {
		const { settings } = parseSettings({
			memory: { project: { markers: [".git", "Cargo.toml"], maxParents: 4 } },
		});
		expect(settings.memory.project.markers).toEqual([".git", "Cargo.toml"]);
		expect(settings.memory.project.maxParents).toBe(4);
	});

	it("names the offending entry when one marker in a list is wrong", () => {
		// One bad entry among good ones is the usual mistake, and finding it by
		// eye in a list of twelve is the slow part.
		expect(() =>
			parseSettings({ memory: { project: { markers: [".git", 7] } } }),
		).toThrow(/markers\[1\]/);
		expect(() =>
			parseSettings({ memory: { project: { markers: ".git" } } }),
		).toThrow(/must be an array/i);
	});

	it("takes an empty marker list, which switches detection off", () => {
		expect(
			parseSettings({ memory: { project: { markers: [] } } }).settings.memory
				.project.markers,
		).toEqual([]);
	});

	it("takes the engine config path, and takes null for the default place", () => {
		expect(
			parseSettings({ memory: { plugmemConfig: "~/plug.toml" } }).settings
				.memory.plugmemConfig,
		).toBe("~/plug.toml");
		expect(DEFAULT_SETTINGS.memory.plugmemConfig).toBeNull();
	});

	it("keeps valid custom secret patterns and warns on invalid ones", () => {
		const { settings, warnings } = parseSettings({
			memory: {
				security: {
					customPatterns: [
						{
							name: "company-token",
							pattern: "\\bACME_[A-Z0-9]{24,}\\b",
							description: "company credential",
						},
						{
							name: "broken",
							pattern: "[",
							description: "ignored broken rule",
						},
					],
				},
			},
		});
		expect(settings.memory.security.customPatterns).toHaveLength(1);
		expect(warnings.join(" ")).toMatch(
			/memory\.security\.customPatterns\[1\]\.pattern.*invalid regular expression/i,
		);
	});

	it("does not provide an allow or override escape hatch", () => {
		const { settings, warnings } = parseSettings({
			memory: {
				security: {
					customPatterns: [
						{
							name: "company-token",
							pattern: "ACME_[A-Z]+",
							description: "company credential",
							action: "allow",
						},
					],
				},
			},
		});
		expect(settings.memory.security.customPatterns).toHaveLength(1);
		expect(warnings.join(" ")).toMatch(/always block/i);
	});

	it("warns and ignores oversized custom pattern collections", () => {
		const { settings, warnings } = parseSettings({
			memory: {
				security: {
					customPatterns: Array.from({ length: 65 }, (_, index) => ({
						name: `rule-${index}`,
						pattern: "x".repeat(index === 0 ? 501 : 1),
						description: "synthetic rule",
					})),
				},
			},
		});
		expect(settings.memory.security.customPatterns).toHaveLength(63);
		expect(warnings.join(" ")).toMatch(/more than 64 entries/i);
		expect(warnings.join(" ")).toMatch(/longer than 500 characters/i);
	});

	it("rejects an empty custom pattern field", () => {
		expect(() =>
			parseSettings({
				memory: {
					security: {
						customPatterns: [
							{ name: "empty", pattern: "", description: "empty" },
						],
					},
				},
			}),
		).toThrow(/customPatterns\[0\]\.pattern.*non-empty/i);
	});

	it("rejects an empty custom pattern description", () => {
		expect(() =>
			parseSettings({
				memory: {
					security: {
						customPatterns: [
							{ name: "unnamed", pattern: "ACME", description: "" },
						],
					},
				},
			}),
		).toThrow(/customPatterns\[0\]\.description.*non-empty/i);
	});

	it("accepts a full document identical to the defaults", () => {
		// Guards the round trip SETTINGS.md documents: the published example has
		// to be a document this parser accepts.
		const { settings, warnings } = parseSettings(
			JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as unknown,
		);
		expect(warnings).toEqual([]);
		expect(settings).toEqual(DEFAULT_SETTINGS);
	});
});
