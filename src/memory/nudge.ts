/**
 * The reminder that nothing has been written to memory in a while.
 *
 * This is the *only* automatic pressure to write, and it is a hint rather than
 * a rule on purpose. There is no "save a summary of every turn" mechanism here
 * and there will not be one: it would fill the store with filler nobody asked
 * for, and filler is precisely what breaks the duplicate detector — it compares
 * a new fact against an entity's 32 most recent, so 32 lines of nothing hide
 * the real ones.
 *
 * Two counters rather than one because the two ways a session gets long are
 * different: a conversation grows in messages, an agentic run grows in tool
 * calls, and a run can cross one threshold without approaching the other.
 */

import type { NudgeSettings } from "../settings/defaults.ts";

export class WriteNudge {
	private messages = 0;
	private toolCalls = 0;
	private cooldown = 0;

	constructor(private readonly settings: NudgeSettings) {}

	noteMessage(): void {
		this.messages += 1;
	}

	noteToolCall(): void {
		this.toolCalls += 1;
	}

	/** Something was stored: the reason for the reminder is gone. */
	noteWrite(): void {
		this.messages = 0;
		this.toolCalls = 0;
	}

	/** The reminder was placed in the tail; go quiet for the cooldown. */
	noteShown(): void {
		this.cooldown = this.settings.cooldownTurns;
	}

	/** One turn elapsed, burning down the cooldown. */
	noteTurn(): void {
		if (this.cooldown > 0) this.cooldown -= 1;
	}

	due(): boolean {
		if (!this.settings.enabled) return false;
		if (this.cooldown > 0) return false;
		return (
			this.messages >= this.settings.afterMessages ||
			this.toolCalls >= this.settings.afterToolCalls
		);
	}

	/**
	 * The wording.
	 *
	 * It asks a question and names the tool. Asking leaves the model free to
	 * decide there is nothing worth keeping, which is usually the truth; naming
	 * the tool means it does not have to go looking for how.
	 */
	static text(): string {
		return (
			"You have not stored anything in long-term memory for a while. If something " +
			"in this session is worth remembering next time - a decision and its reason, " +
			"a convention, a trap in this codebase, a standing preference - save it with " +
			"longterm_remember now. If nothing here is durable, ignore this."
		);
	}
}
