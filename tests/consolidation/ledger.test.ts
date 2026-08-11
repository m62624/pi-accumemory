import { describe, expect, it } from "vitest";
import { ConsolidationLedger } from "../../src/consolidation/ledger.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";

const base = DEFAULT_SETTINGS.memory.consolidation;

function ledger(overrides: Partial<typeof base> = {}) {
	return new ConsolidationLedger({ ...base, ...overrides });
}

describe("ConsolidationLedger", () => {
	it("opens with a directive that names the exit first", () => {
		// A model reading a list of things it may do, and only then how to
		// stop, explores until something stops it. Naming the exit first is
		// what makes finishing an option it considers.
		const directive = ledger().directive();
		expect(directive.kind).toBe("continue");
		const exitAt = directive.text.indexOf("longterm_done");
		expect(exitAt).toBeGreaterThanOrEqual(0);
		expect(exitAt).toBeLessThan(directive.text.length / 2);
	});

	it("tells the pass to wrap up once the step budget is spent", () => {
		// The budget bounds a CONFUSED pass, not a busy one: whatever is left
		// is picked up by the next pass from the same cursor.
		const led = ledger({ maxSteps: 3 });
		for (let i = 0; i < 3; i += 1) led.noteToolCall("longterm_ask", `q${i}`);
		const directive = led.directive();
		expect(directive.kind).toBe("finish");
		expect(directive.text).toMatch(/next pass/i);
	});

	it("nudges a turn that did nothing, listing what has been done", () => {
		// Prose on a memory pass is unrecoverable: it is not an answer written
		// badly, it is a lost thread.
		const led = ledger();
		led.noteToolCall("longterm_remember", "a fact");
		led.noteWrite();
		led.noteIdleTurn();
		const directive = led.directive();
		expect(directive.kind).toBe("nudge");
		expect(directive.text).toContain("longterm_remember");
	});

	it("abandons the pass after too many empty turns", () => {
		const led = ledger({ maxNudges: 2 });
		led.noteIdleTurn();
		expect(led.directive().kind).toBe("nudge");
		led.noteIdleTurn();
		expect(led.directive().kind).toBe("abandon");
		expect(led.finished()).toBe(true);
	});

	it("stops a pass that keeps looking and never writes", () => {
		const led = ledger();
		led.noteToolCall("longterm_ask", "one");
		led.noteToolCall("longterm_ask", "two");
		led.noteToolCall("longterm_ask", "three");
		const directive = led.directive();
		expect(directive.kind).toBe("continue");
		expect(directive.text).toMatch(/decide/i);
	});

	it("clears the looking-without-writing counter when something is written", () => {
		const led = ledger();
		led.noteToolCall("longterm_ask", "one");
		led.noteToolCall("longterm_ask", "two");
		led.noteToolCall("longterm_remember", "a fact");
		led.noteWrite();
		led.noteToolCall("longterm_ask", "three");
		expect(led.directive().text).not.toMatch(/decide/i);
	});

	it("calls out an exact repeat of the previous call", () => {
		// Its context is rebuilt identically each step, so a repeated call
		// looks entirely reasonable from inside. Only the runtime can see it.
		const led = ledger();
		led.noteToolCall("longterm_ask", "why is the cache off");
		led.noteToolCall("longterm_ask", "why is the cache off");
		expect(led.directive().text).toMatch(/same call/i);
	});

	it("does not call out a repeat that is not consecutive", () => {
		const led = ledger();
		led.noteToolCall("longterm_ask", "a");
		led.noteToolCall("longterm_ask", "b");
		led.noteToolCall("longterm_ask", "a");
		expect(led.directive().text).not.toMatch(/same call/i);
	});

	it("is finished once the pass says so", () => {
		const led = ledger();
		expect(led.finished()).toBe(false);
		led.noteDone();
		expect(led.finished()).toBe(true);
	});

	it("ranks the budget above every other reason", () => {
		// Two conditions can hold at once; only one directive is sent, and
		// running out of budget is the one that ends the pass.
		const led = ledger({ maxSteps: 2 });
		led.noteToolCall("longterm_ask", "a");
		led.noteToolCall("longterm_ask", "a");
		led.noteIdleTurn();
		expect(led.directive().kind).toBe("finish");
	});

	it("reports what the pass actually changed", () => {
		const led = ledger();
		led.noteToolCall("longterm_remember", "one");
		led.noteWrite();
		led.noteToolCall("longterm_forget", "2");
		led.noteWrite();
		expect(led.summary()).toMatch(/2 memory writes/);
	});
});
