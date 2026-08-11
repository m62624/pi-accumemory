import { describe, expect, it } from "vitest";
import { RefreshPolicy } from "../../src/memory/refresh.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";

const settings = DEFAULT_SETTINGS.memory.refresh;

function policy(overrides: Partial<typeof settings> = {}) {
	return new RefreshPolicy({ ...settings, ...overrides });
}

describe("RefreshPolicy", () => {
	it("is due at session start, so the first prompt carries a block", () => {
		expect(policy().takeDue()).toBe("session_start");
	});

	it("clears once taken", () => {
		const p = policy();
		p.takeDue();
		expect(p.takeDue()).toBeUndefined();
	});

	it("is due again on a new user message", () => {
		// The strongest signal there is that the topic changed or was set.
		const p = policy();
		p.takeDue();
		p.noteUserMessage();
		expect(p.takeDue()).toBe("user_message");
	});

	it("is not due between events", () => {
		// This is what protects the prompt cache: the tail stays byte-identical
		// across every LLM call in between, so the prefix is never invalidated.
		const p = policy();
		p.takeDue();
		p.noteUserMessage();
		p.takeDue();
		expect(p.takeDue()).toBeUndefined();
		expect(p.takeDue()).toBeUndefined();
	});

	it("is due after the configured number of tool calls, not before", () => {
		const p = policy({ afterToolCalls: 10 });
		p.takeDue();
		for (let i = 0; i < 9; i += 1) {
			p.noteToolCall();
			expect(p.takeDue()).toBeUndefined();
		}
		p.noteToolCall();
		expect(p.takeDue()).toBe("tool_budget");
	});

	it("starts the tool count over after a refresh", () => {
		const p = policy({ afterToolCalls: 2 });
		p.takeDue();
		p.noteToolCall();
		p.noteToolCall();
		expect(p.takeDue()).toBe("tool_budget");
		p.noteToolCall();
		expect(p.takeDue()).toBeUndefined();
		p.noteToolCall();
		expect(p.takeDue()).toBe("tool_budget");
	});

	it("never fires on the tool budget when it is switched off", () => {
		const p = policy({ afterToolCalls: 0 });
		p.takeDue();
		for (let i = 0; i < 50; i += 1) p.noteToolCall();
		expect(p.takeDue()).toBeUndefined();
	});

	it("is due after a compaction, when enabled", () => {
		// The worst possible moment to hold a stale block: the history was just
		// cut away, and the memory is the only thing left of it.
		const p = policy({ onCompact: true });
		p.takeDue();
		p.noteCompact();
		expect(p.takeDue()).toBe("compact");
	});

	it("ignores a compaction when disabled", () => {
		const p = policy({ onCompact: false });
		p.takeDue();
		p.noteCompact();
		expect(p.takeDue()).toBeUndefined();
	});

	it("lets a user message outrank a pending tool-budget refresh", () => {
		// Both are due; the topic change is the more informative reason, and
		// only one block is computed.
		const p = policy({ afterToolCalls: 1 });
		p.takeDue();
		p.noteToolCall();
		p.noteUserMessage();
		expect(p.takeDue()).toBe("user_message");
	});
});

describe("RefreshPolicy ask hint", () => {
	it("does not hint while the model is using tools", () => {
		const p = policy({ askHintAfterIdleInferences: 2 });
		p.noteTurnEnd(true);
		p.noteTurnEnd(true);
		expect(p.askHintDue()).toBe(false);
	});

	it("hints after enough runs that answered without touching anything", () => {
		// A model answering from guesswork twice in a row is the exact moment it
		// should have asked the memory instead.
		const p = policy({ askHintAfterIdleInferences: 2 });
		p.noteTurnEnd(false);
		expect(p.askHintDue()).toBe(false);
		p.noteTurnEnd(false);
		expect(p.askHintDue()).toBe(true);
	});

	it("stops hinting once the model does something", () => {
		const p = policy({ askHintAfterIdleInferences: 2 });
		p.noteTurnEnd(false);
		p.noteTurnEnd(false);
		p.noteTurnEnd(true);
		expect(p.askHintDue()).toBe(false);
	});

	it("counts a tool call during the run as doing something", () => {
		const p = policy({ askHintAfterIdleInferences: 1 });
		p.noteToolCall();
		p.noteTurnEnd(false);
		expect(p.askHintDue()).toBe(false);
	});

	it("never hints when switched off", () => {
		const p = policy({ askHintAfterIdleInferences: 0 });
		for (let i = 0; i < 5; i += 1) p.noteTurnEnd(false);
		expect(p.askHintDue()).toBe(false);
	});
});
