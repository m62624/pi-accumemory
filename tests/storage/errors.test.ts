/**
 * Classifying engine errors.
 *
 * Everything above this module branches on these predicates, and each branch is
 * a decision about the user's memory: retry, degrade, rebuild, or give up. A
 * predicate that says "yes" too eagerly rebuilds a healthy database; one that
 * says "no" too eagerly leaves a dead one in place. So the interesting cases are
 * the things that are not engine errors at all.
 */

import { describe, expect, it } from "vitest";
import {
	errorCode,
	isLocked,
	isVectorSpaceMismatch,
	needsCheckpoint,
	PLUGMEM_ENGINE,
	PLUGMEM_LOCKED,
	PLUGMEM_NEEDS_CHECKPOINT,
} from "../../src/storage/errors.ts";

/** What the napi addon throws: an Error carrying a `code`. */
function engineError(code: string, message = "something went wrong"): Error {
	return Object.assign(new Error(message), { code });
}

describe("errorCode", () => {
	it("reads the code off an engine error", () => {
		expect(errorCode(engineError(PLUGMEM_LOCKED))).toBe(PLUGMEM_LOCKED);
	});

	it("has no answer for things that are not objects", () => {
		for (const value of [undefined, null, "PLUGMEM_LOCKED", 7]) {
			expect(errorCode(value)).toBeUndefined();
		}
	});

	it("ignores a code that is not a string", () => {
		expect(errorCode({ code: 42 })).toBeUndefined();
	});
});

describe("the predicates", () => {
	it("recognise their own code and nothing else", () => {
		expect(needsCheckpoint(engineError(PLUGMEM_NEEDS_CHECKPOINT))).toBe(true);
		expect(needsCheckpoint(engineError(PLUGMEM_LOCKED))).toBe(false);
		expect(isLocked(engineError(PLUGMEM_LOCKED))).toBe(true);
		expect(isLocked(new Error("locked"))).toBe(false);
	});

	it("identify a vector space mismatch by its message, not its code alone", () => {
		// PLUGMEM_ENGINE covers everything the engine did not give a code of its
		// own, so the code by itself would classify unrelated failures as a
		// changed embedding model - and trigger a full rebuild over one of them.
		expect(
			isVectorSpaceMismatch(
				engineError(
					PLUGMEM_ENGINE,
					"vector space mismatch: stored 'a', requested 'b'",
				),
			),
		).toBe(true);
		expect(
			isVectorSpaceMismatch(engineError(PLUGMEM_ENGINE, "disk is full")),
		).toBe(false);
		expect(
			isVectorSpaceMismatch(
				engineError(PLUGMEM_LOCKED, "vector space mismatch"),
			),
		).toBe(false);
	});

	it("survives a thrown value that is not an Error", () => {
		expect(
			isVectorSpaceMismatch({
				code: PLUGMEM_ENGINE,
				toString: () => "vector space mismatch",
			}),
		).toBe(true);
	});
});
