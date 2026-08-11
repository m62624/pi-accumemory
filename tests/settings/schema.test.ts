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

	it("keeps the embedder off by default but carries a multilingual model name", () => {
		// The default is off because a machine without Ollama must still work;
		// the recommendation lives in SETTINGS.md. The model name is prefilled
		// so switching it on is one boolean, not a research task — and it is a
		// multilingual one, because this memory holds Russian and English.
		expect(DEFAULT_SETTINGS.memory.embedder.enabled).toBe(false);
		expect(DEFAULT_SETTINGS.memory.embedder.model).toBe("bge-m3");
		expect(DEFAULT_SETTINGS.memory.embedder.dim).toBeGreaterThan(0);
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
