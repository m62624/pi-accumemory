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

	it("keeps the legacy embedder off by default, with a multilingual model", () => {
		// These keys no longer configure anything - plugmem's config.toml does -
		// but they are still what an upgrade writes into that file the first
		// time, so the defaults still have to be the ones worth writing.
		expect(DEFAULT_SETTINGS.memory.embedder.enabled).toBe(false);
		expect(DEFAULT_SETTINGS.memory.embedder.model).toBe("bge-m3");
		expect(DEFAULT_SETTINGS.memory.embedder.dim).toBeGreaterThan(0);
	});

	it("carries autoReembed out of the embedder section it used to live in", () => {
		// A rename across two levels: dropping it would silently return the
		// setting to its default, and the user would find out by watching a
		// rebuild they had switched off.
		const { settings, warnings } = parseSettings({
			memory: { embedder: { autoReembed: false } },
		});
		expect(settings.memory.autoReembed).toBe(false);
		expect(warnings.join(" ")).toContain("memory.autoReembed");
	});

	it("still checks the type of a value arriving under an old name", () => {
		expect(() =>
			parseSettings({ memory: { embedder: { autoReembed: "no" } } }),
		).toThrow(/boolean/i);
	});

	it("takes the engine config path, and takes null for the default place", () => {
		expect(
			parseSettings({ memory: { plugmemConfig: "~/plug.toml" } }).settings
				.memory.plugmemConfig,
		).toBe("~/plug.toml");
		expect(DEFAULT_SETTINGS.memory.plugmemConfig).toBeNull();
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
