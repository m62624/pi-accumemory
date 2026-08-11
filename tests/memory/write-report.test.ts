/**
 * What a write tells the model, and what it tells the person.
 *
 * The two are deliberately different sizes, and the rule is one-directional:
 * the model's account may never be trimmed to make the terminal tidier. These
 * tests hold that line, because the pressure to cross it is constant - the full
 * account is the noisiest thing this extension prints.
 */

import { describe, expect, it } from "vitest";
import {
	modelReport,
	shortReport,
	type WriteReport,
} from "../../src/memory/write-report.ts";

const report: WriteReport = {
	id: 7,
	scope: "user",
	scopeLabel: "your memory about the user",
	entity: "user",
	tags: ["preference", "tooling"],
	vocabulary: ["preference(4)", "tooling(2)"],
	notes: ['Tag "tooling" is close to the existing tag "tools"'],
};

describe("modelReport", () => {
	it("names the scope beside the id, because the id alone addresses nothing", () => {
		const text = modelReport(report);
		expect(text).toContain("[f7]");
		expect(text).toContain("scope  : user");
		expect(text).toMatch(/pass this with \[f7\]/);
	});

	it("names the entity, which is what the duplicate guard compares against", () => {
		expect(modelReport(report)).toContain("entity : user");
	});

	it("shows the tags this memory already uses", () => {
		// The answer to "which tag does this memory use for this kind of thing",
		// at the moment the model is choosing one - and the only moment it has
		// to get it right, since filtering matches tags exactly.
		expect(modelReport(report)).toContain("in use : preference(4) tooling(2)");
	});

	it("claims nothing about similarity", () => {
		// A recall always returns its best match however weak, so anything
		// presented here as "close" would be read as a near-duplicate at a
		// fused score of 0.02. pi-telegram-manager lost a fact to exactly that.
		const text = modelReport(report);
		expect(text).not.toMatch(/near|similar|duplicate/i);
	});

	it("carries the tag-drift warnings through", () => {
		expect(modelReport(report)).toContain('close to the existing tag "tools"');
	});

	it("says so plainly when there are no tags and no vocabulary yet", () => {
		const bare = modelReport({
			...report,
			tags: [],
			vocabulary: [],
			notes: [],
		});
		expect(bare).toContain("tags   : (none)");
		expect(bare).not.toContain("in use");
	});
});

describe("shortReport", () => {
	it("is one line", () => {
		expect(shortReport(report).split("\n")).toHaveLength(1);
	});

	it("still says which memory it went to", () => {
		// The one thing a person watching actually needs: that it was stored,
		// and that it did not land in the shared memory by accident.
		expect(shortReport(report)).toContain("your memory about the user");
	});

	it("is strictly shorter than what the model is told", () => {
		expect(shortReport(report).length).toBeLessThan(modelReport(report).length);
	});
});
