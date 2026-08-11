import { describe, expect, it } from "vitest";
import { AskGuard } from "../../src/memory/ask-guard.ts";

describe("AskGuard", () => {
	it("lets a question through the first time", () => {
		const guard = new AskGuard();
		expect(guard.check("why is the cache off")).toBeUndefined();
	});

	it("flags the same question asked again in the same run", () => {
		// A model that did not get the answer it hoped for re-asks the same
		// thing in different words, forever. Telling it the answer did not
		// change is what breaks the loop.
		const guard = new AskGuard();
		guard.record("why is the cache off");
		expect(guard.check("why is the cache off")).toMatch(/already asked/i);
	});

	it("ignores spacing and case when matching a repeat", () => {
		const guard = new AskGuard();
		guard.record("Why is the   cache off?");
		expect(guard.check("why is the cache off?")).toBeDefined();
	});

	it("treats a different question as new", () => {
		const guard = new AskGuard();
		guard.record("why is the cache off");
		expect(guard.check("which test runner is used")).toBeUndefined();
	});

	it("forgets everything when the user speaks again", () => {
		// A new request is a new run: the same question can be legitimate again.
		const guard = new AskGuard();
		guard.record("why is the cache off");
		guard.reset();
		expect(guard.check("why is the cache off")).toBeUndefined();
	});

	it("nudges after several asks in a row with nothing done between them", () => {
		const guard = new AskGuard({ maxConsecutive: 3 });
		guard.record("a");
		guard.record("b");
		expect(guard.stuck()).toBe(false);
		guard.record("c");
		expect(guard.stuck()).toBe(true);
	});

	it("stops nudging once the model acts on what it found", () => {
		const guard = new AskGuard({ maxConsecutive: 2 });
		guard.record("a");
		guard.record("b");
		expect(guard.stuck()).toBe(true);
		guard.noteOtherActivity();
		expect(guard.stuck()).toBe(false);
	});

	it("offers wording that tells the model to decide on what it has", () => {
		expect(AskGuard.stuckText()).toMatch(/decide/i);
	});
});
