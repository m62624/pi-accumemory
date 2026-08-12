/**
 * `longterm_about` is a document reader, so the tests are about the two things
 * a document reader can get wrong: handing out the wrong document, and handing
 * out something it should never have held.
 *
 * The key checks are not decoration. `current_settings` is the one page built
 * from live values rather than bundled text, and it is the only place in this
 * extension where a secret could reach a prompt. It never receives one - the
 * dependency it is given returns a boolean - and these hold that shape.
 */

import { describe, expect, it } from "vitest";
import { ABOUT_PAGES } from "../../src/about/pages.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import {
	ABOUT_BUDGET_SPENT,
	ABOUT_CALLS_PER_TURN,
	ABOUT_DESCRIPTION,
	ABOUT_TOPICS,
	AboutDesk,
	readAbout,
} from "../../src/tools/about.ts";

function desk(overrides: Partial<typeof DEFAULT_SETTINGS.memory> = {}) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	Object.assign(settings.memory, overrides);
	return new AboutDesk({ settings, hasEnv: (name) => name === "SET_ONE" });
}

/** Every dotted key under an object, leaves only: `embedder.dim`, and so on. */
function leafKeys(value: object, prefix = ""): string[] {
	const keys: string[] = [];
	for (const [key, nested] of Object.entries(value)) {
		const dotted = prefix === "" ? key : `${prefix}.${key}`;
		if (
			typeof nested === "object" &&
			nested !== null &&
			!Array.isArray(nested)
		) {
			keys.push(...leafKeys(nested, dotted));
		} else {
			keys.push(dotted);
		}
	}
	return keys;
}

describe("the pages", () => {
	it("has a document for every topic but the generated one", () => {
		for (const topic of ABOUT_TOPICS) {
			if (topic === "current_settings") continue;
			expect(ABOUT_PAGES[topic]).toBeTypeOf("string");
			expect(ABOUT_PAGES[topic].length).toBeGreaterThan(400);
		}
	});

	it("names every topic in the tool description, so choosing is possible", () => {
		for (const topic of ABOUT_TOPICS) {
			expect(ABOUT_DESCRIPTION).toContain(`'${topic}'`);
		}
	});

	it("stays ASCII, like every other text this extension ships", () => {
		for (const [topic, page] of Object.entries(ABOUT_PAGES)) {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is the range
			const offending = page.match(/[^\x00-\x7F]/g);
			expect(offending, `${topic} has non-ASCII: ${offending?.join("")}`).toBe(
				null,
			);
		}
	});

	it("mentions no tool this extension does not register", () => {
		// Cheap version of the agreement test next door: any `longterm_x` written
		// in a page must be a real name, because a model will call what it reads.
		const known = new Set([
			"longterm_ask",
			"longterm_ask_project",
			"longterm_projects",
			"longterm_remember",
			"longterm_revise",
			"longterm_forget",
			"longterm_tags",
			"longterm_link",
			"longterm_unlink",
			"longterm_note_create",
			"longterm_note_read",
			"longterm_note_update",
			"longterm_note_delete",
			"longterm_about",
			// Only exists inside a consolidation pass, and `consolidation` is the
			// page that describes one.
			"longterm_done",
		]);
		for (const page of Object.values(ABOUT_PAGES)) {
			for (const named of page.match(/longterm_[a-z_]+/g) ?? []) {
				expect(known, `${named} is named in a page`).toContain(named);
			}
		}
	});
});

describe("reading one", () => {
	it("returns the page asked for", () => {
		expect(readAbout(desk(), "scopes")).toBe(ABOUT_PAGES.scopes);
	});

	it("names the choices when the topic is not one of them", () => {
		const answer = readAbout(desk(), "everything");
		expect(answer).toContain("Unknown topic");
		for (const topic of ABOUT_TOPICS) expect(answer).toContain(topic);
	});

	it("does not spend the budget on a topic it refused", () => {
		const one = desk();
		for (let i = 0; i < 10; i++) readAbout(one, "nonsense");
		expect(readAbout(one, "system")).toBe(ABOUT_PAGES.system);
	});

	it("stops after the budget and says what to do instead", () => {
		const one = desk();
		for (let i = 0; i < ABOUT_CALLS_PER_TURN; i++) {
			expect(readAbout(one, "system")).toBe(ABOUT_PAGES.system);
		}
		const refused = readAbout(one, "system");
		expect(refused).toBe(ABOUT_BUDGET_SPENT);
		// A refusal that only refuses gets the same call again.
		expect(refused).toContain("Carry on with the request");
	});

	it("gives the budget back at the top of the next turn", () => {
		const one = desk();
		for (let i = 0; i < ABOUT_CALLS_PER_TURN + 2; i++) readAbout(one, "system");
		one.reset();
		expect(readAbout(one, "system")).toBe(ABOUT_PAGES.system);
	});
});

describe("current_settings", () => {
	it("reports the values this session runs with", () => {
		const page = readAbout(desk({ writeOutput: "full" }), "current_settings");
		expect(page).toContain("writeOutput: full");
		expect(page).toContain("consolidation.review.sampleSize: 12");
	});

	it("names every setting there is, so no key is only discoverable by luck", () => {
		// The failure this prevents is silent: a setting added to the defaults
		// and not to the page exists, works, and is invisible to the one reader
		// who would tell the user about it.
		const page = readAbout(desk(), "current_settings");
		for (const leaf of leafKeys(DEFAULT_SETTINGS.memory)) {
			expect(page, `${leaf} is missing from current_settings`).toContain(leaf);
		}
	});

	it("prints the real paths rather than describing where they usually are", () => {
		const page = readAbout(
			new AboutDesk({
				settings: structuredClone(DEFAULT_SETTINGS),
				paths: {
					settingsFile: "/home/someone/.pi/extensions/accumemory/settings.json",
					memoryDir: "/home/someone/.pi/extensions/accumemory/memory",
				},
			}),
			"current_settings",
		);
		expect(page).toContain(
			"/home/someone/.pi/extensions/accumemory/settings.json",
		);
		expect(page).toContain("/home/someone/.pi/extensions/accumemory/memory");
	});

	it("admits it does not know a path rather than inventing one", () => {
		const page = readAbout(desk(), "current_settings");
		expect(page).toContain("not known in this session");
	});

	it("sends the reader to current_settings for the location", () => {
		// The settings page must not name a path: it ships with the package and
		// the path differs per installation.
		expect(ABOUT_PAGES.settings).toContain("current_settings");
		expect(ABOUT_PAGES.settings).not.toMatch(/\/home\/|C:\\\\/);
	});

	it("says a key variable by NAME and whether it is set, never its value", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.memory.embedder.apiKeyEnv = "SET_ONE";
		const page = readAbout(
			new AboutDesk({
				settings,
				// The dependency cannot return a value even if something wanted one.
				hasEnv: (name) => name === "SET_ONE",
			}),
			"current_settings",
		);
		expect(page).toContain("SET_ONE");
		expect(page).toContain("currently set");
		expect(page).toContain("never read into a prompt");
	});

	it("calls an unset variable EMPTY, which is the diagnostic half", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.memory.embedder.apiKeyEnv = "MISSING_ONE";
		const page = readAbout(
			new AboutDesk({ settings, hasEnv: () => false }),
			"current_settings",
		);
		expect(page).toContain("currently EMPTY");
	});

	it("says no key is sent when none is configured", () => {
		const page = readAbout(desk(), "current_settings");
		expect(page).toContain("no key is sent");
	});

	it("assumes nothing when no environment reader was given", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.memory.embedder.apiKeyEnv = "SOME_KEY";
		const page = readAbout(new AboutDesk({ settings }), "current_settings");
		expect(page).toContain("currently EMPTY");
	});

	it("warns when semantic search is off, because it explains empty answers", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.memory.embedder.enabled = false;
		const page = readAbout(new AboutDesk({ settings }), "current_settings");
		expect(page).toContain("WITHOUT VECTORS");
	});

	it("keeps the warning out of the way when vectors are on", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.memory.embedder.enabled = true;
		const page = readAbout(new AboutDesk({ settings }), "current_settings");
		expect(page).not.toContain("WITHOUT VECTORS");
	});
});
