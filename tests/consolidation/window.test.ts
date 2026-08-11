/**
 * The size of a review window, which is the whole answer to "how does this
 * behave on a memory that is not small".
 *
 * A fixed window does not survive a memory that has been running for a year:
 * twelve facts a pass walks ten thousand of them in eight hundred and thirty
 * passes, which at a handful of idle passes a day is most of a year to come
 * round once - and the facts most likely to have gone stale are exactly the
 * ones such a memory would review least.
 */

import { describe, expect, it } from "vitest";
import { reviewWindowSize } from "../../src/consolidation/window.ts";

/** Passes needed to walk a memory of `live` facts at the resulting window. */
const cycle = (sampleSize: number, live: number) =>
	Math.ceil(live / reviewWindowSize(sampleSize, live));

describe("reviewWindowSize", () => {
	it("keeps a full cycle near a hundred passes as the memory grows", () => {
		for (const live of [500, 1_000, 5_000, 10_000]) {
			expect(cycle(12, live), `${live} facts`).toBeLessThanOrEqual(110);
		}
	});

	it("never goes below the configured size", () => {
		// A small memory reviewed in windows of one would take as many passes as
		// it has facts, for no reason at all.
		expect(reviewWindowSize(12, 0)).toBe(12);
		expect(reviewWindowSize(12, 50)).toBe(12);
		expect(reviewWindowSize(12, 1_200)).toBe(12);
	});

	it("stops growing, because the window ends up in a prompt", () => {
		// At a hundred thousand facts nothing bounded reviews everything
		// quickly, and a prompt holding a thousand facts would be worse than a
		// slow cycle.
		expect(reviewWindowSize(12, 100_000)).toBe(96);
		expect(reviewWindowSize(12, 10_000_000)).toBe(96);
	});

	it("scales with the setting, not around it", () => {
		// Raising sampleSize raises both the floor and the ceiling, so the knob
		// means one thing at every size.
		expect(reviewWindowSize(4, 10)).toBe(4);
		expect(reviewWindowSize(4, 100_000)).toBe(32);
	});

	it("is zero when the phase is configured off", () => {
		expect(reviewWindowSize(0, 10_000)).toBe(0);
	});

	it("treats a nonsensical count as an empty memory", () => {
		expect(reviewWindowSize(12, -5)).toBe(12);
	});
});
