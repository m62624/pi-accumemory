import { describe, expect, it } from "vitest";
import { suggestionText, suggestTag } from "../../src/memory/tag-suggest.ts";

const vocabulary = [
	"bug",
	"decision",
	"convention",
	"gotcha",
	"instruction",
	"note",
];

describe("suggestTag", () => {
	it("says nothing about a tag that already exists", () => {
		expect(suggestTag("decision", vocabulary)).toBeUndefined();
	});

	it("says nothing about a tag unlike anything in the vocabulary", () => {
		// Left alone, an open vocabulary is the point. Suggesting a neighbour
		// for every new word would collapse it back into a fixed list.
		expect(suggestTag("performance", vocabulary)).toBeUndefined();
	});

	it("catches a near-miss spelling", () => {
		// The failure this prevents: `bug` and `bugfix` split the same facts
		// across two tags, and a tag filter needs an exact match, so half the
		// answers stop coming back.
		expect(suggestTag("bugfix", vocabulary)?.existing).toBe("bug");
		expect(suggestTag("desicion", vocabulary)?.existing).toBe("decision");
		expect(suggestTag("conventions", vocabulary)?.existing).toBe("convention");
	});

	it("is case-insensitive, because a tag filter is not", () => {
		expect(suggestTag("Decision", vocabulary)?.existing).toBe("decision");
	});

	it("picks the closest candidate when several are near", () => {
		expect(suggestTag("notes", ["note", "nope"])?.existing).toBe("note");
	});

	it("scores between zero and one", () => {
		const hit = suggestTag("bugfix", vocabulary);
		expect(hit?.score).toBeGreaterThan(0);
		expect(hit?.score).toBeLessThanOrEqual(1);
	});

	it("says nothing when the vocabulary is empty", () => {
		expect(suggestTag("anything", [])).toBeUndefined();
	});

	it("ignores a tag too short to compare meaningfully", () => {
		// At two characters every edit is half the word, so everything looks
		// close to everything.
		expect(suggestTag("b", vocabulary)).toBeUndefined();
	});
});

describe("suggestionText", () => {
	it("asks a question and does not decide", () => {
		// Words that look alike sometimes mean different things. The model has
		// the context to tell; a similarity score does not.
		const text = suggestionText({
			candidate: "bugfix",
			existing: "bug",
			score: 0.86,
		});
		expect(text).toContain("bugfix");
		expect(text).toContain("bug");
		expect(text).toMatch(/same meaning/i);
		expect(text).toMatch(/\?/);
	});

	it("says the tag was stored as written", () => {
		// A suggestion that silently rewrote the tag would be a fixed
		// vocabulary wearing a disguise.
		expect(
			suggestionText({ candidate: "bugfix", existing: "bug", score: 0.86 }),
		).toMatch(/stored as written/i);
	});
});
