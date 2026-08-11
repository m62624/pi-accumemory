/**
 * The loop this exists to break, at the grain it actually happened.
 *
 * A live session sent the identical `longterm_forget` six times. Not from
 * stupidity: everything the model could see was unchanged between attempts, so
 * from the inside the third looked exactly like the first. Only the runtime can
 * tell them apart, which is why an instruction and a tool message both failed
 * to stop it and this does.
 */

import { describe, expect, it } from "vitest";
import { RepeatGuard } from "../../src/memory/repeat-guard.ts";

describe("RepeatGuard", () => {
	it("lets the first failure speak for itself", () => {
		// The caller's own message names what to change; replacing it would
		// throw away the only useful thing said.
		expect(new RepeatGuard().noteFailure("forget:user:3")).toBeUndefined();
	});

	it("changes the wording on the second identical failure", () => {
		const guard = new RepeatGuard();
		guard.noteFailure("forget:user:3");
		const second = guard.noteFailure("forget:user:3");
		expect(second).toMatch(/second time/i);
		expect(second).toMatch(/move on/i);
	});

	it("stops describing the failure and names the only move left", () => {
		const guard = new RepeatGuard();
		for (let attempt = 0; attempt < 2; attempt += 1)
			guard.noteFailure("forget:user:3");
		const third = guard.noteFailure("forget:user:3");
		expect(third).toMatch(/^stop\./i);
		expect(third).toMatch(/say plainly to the user/i);
	});

	it("counts per call, so a different id is progress", () => {
		// Forgetting [f4] after failing on [f3] is the job going forward.
		const guard = new RepeatGuard();
		guard.noteFailure("forget:user:3");
		expect(guard.noteFailure("forget:user:4")).toBeUndefined();
	});

	it("forgets a call's history once it succeeds", () => {
		const guard = new RepeatGuard();
		guard.noteFailure("forget:user:3");
		guard.noteSuccess("forget:user:3");
		expect(guard.noteFailure("forget:user:3")).toBeUndefined();
	});

	it("starts clean on new user input", () => {
		// A new request is a new situation; the same call may now be right.
		const guard = new RepeatGuard();
		guard.noteFailure("forget:user:3");
		guard.reset();
		expect(guard.noteFailure("forget:user:3")).toBeUndefined();
	});
});
