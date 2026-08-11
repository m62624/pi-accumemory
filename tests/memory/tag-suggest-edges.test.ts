import { describe, expect, it } from "vitest";
import { suggestTag } from "../../src/memory/tag-suggest.ts";

describe("suggestTag tuning", () => {
	it("honours a stricter threshold", () => {
		// The default is tuned for an ordinary vocabulary; a project with many
		// near-synonymous tags can raise it rather than be nagged.
		expect(suggestTag("bugfix", ["bug"], { threshold: 0.95 })).toBeUndefined();
		expect(suggestTag("bugfix", ["bug"], { threshold: 0.5 })?.existing).toBe(
			"bug",
		);
	});

	it("honours a different minimum length", () => {
		expect(suggestTag("ci", ["cd"])).toBeUndefined();
		expect(
			suggestTag("ci", ["cd"], { minLength: 2, threshold: 0.4 })?.existing,
		).toBe("cd");
	});

	it("trims surrounding whitespace before comparing", () => {
		expect(suggestTag("  decision  ", ["decision"])).toBeUndefined();
	});

	it("flags a tag differing only in case", () => {
		// plugmem filters tags by exact match, so these really are two tags
		// holding two disjoint piles of facts.
		expect(suggestTag("Decision", ["decision"])?.existing).toBe("decision");
	});

	it("compares against an empty existing tag without failing", () => {
		expect(suggestTag("decision", [""])).toBeUndefined();
	});

	it("handles a candidate that is a strict prefix of an existing tag", () => {
		expect(
			suggestTag("conv", ["convention"], { threshold: 0.4 })?.existing,
		).toBe("convention");
	});

	it("returns the closest of several near matches", () => {
		const hit = suggestTag("decisions", ["decision", "decided", "decisive"]);
		expect(hit?.existing).toBe("decision");
	});
});
