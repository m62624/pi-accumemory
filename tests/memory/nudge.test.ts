import { describe, expect, it } from "vitest";
import { WriteNudge } from "../../src/memory/nudge.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";

const base = DEFAULT_SETTINGS.memory.nudge;

function nudge(overrides: Partial<typeof base> = {}) {
	return new WriteNudge({ ...base, ...overrides });
}

describe("WriteNudge", () => {
	it("stays quiet at the start of a session", () => {
		expect(nudge().due()).toBe(false);
	});

	it("fires after enough messages with nothing saved", () => {
		const n = nudge({ afterMessages: 3, afterToolCalls: 999 });
		n.noteMessage();
		n.noteMessage();
		expect(n.due()).toBe(false);
		n.noteMessage();
		expect(n.due()).toBe(true);
	});

	it("fires after enough tool calls too", () => {
		// Agents are tool-happy: a long session can cross the tool threshold
		// without ever crossing the message one.
		const n = nudge({ afterMessages: 999, afterToolCalls: 3 });
		for (let i = 0; i < 3; i += 1) n.noteToolCall();
		expect(n.due()).toBe(true);
	});

	it("resets both counters when something is written to memory", () => {
		const n = nudge({ afterMessages: 3, afterToolCalls: 3 });
		n.noteMessage();
		n.noteMessage();
		n.noteToolCall();
		n.noteToolCall();
		n.noteWrite();
		n.noteMessage();
		n.noteToolCall();
		expect(n.due()).toBe(false);
	});

	it("goes quiet for the cooldown once it has fired", () => {
		// Without this the reminder, having become due, repeats on every single
		// following turn until something is written - which is how a hint turns
		// into nagging the model learns to skip.
		const n = nudge({
			afterMessages: 1,
			afterToolCalls: 999,
			cooldownTurns: 3,
		});
		n.noteMessage();
		expect(n.due()).toBe(true);
		n.noteShown();

		for (let turn = 0; turn < 3; turn += 1) {
			n.noteMessage();
			expect(n.due()).toBe(false);
			n.noteTurn();
		}
		n.noteMessage();
		expect(n.due()).toBe(true);
	});

	it("never fires when disabled", () => {
		const n = nudge({ enabled: false, afterMessages: 1 });
		n.noteMessage();
		expect(n.due()).toBe(false);
	});

	it("offers wording that asks rather than orders", () => {
		// It is a hint, not a directive: forcing a write produces filler facts,
		// and filler facts are what break the duplicate detector later.
		expect(WriteNudge.text()).toMatch(/worth remembering/i);
		expect(WriteNudge.text()).toMatch(/longterm_remember/);
	});
});
