/**
 * Running an idle consolidation pass.
 *
 * The pass reads the transcript pi already wrote to disk - no messages are
 * duplicated into the database for this - and curates the memory from it. A
 * cursor per project records how far it got, so a long session is digested by
 * several small passes rather than one unliftable one.
 *
 * Two rules about interruption, both learned rather than invented:
 *
 * - **Every memory call lands on disk when the tool returns.** Nothing is
 *   buffered until the pass "finishes", because a pass can be pre-empted at any
 *   step and whatever it had decided by then must survive. Buffering is how the
 *   earlier design in pi-telegram-manager lost a whole pass's worth of facts
 *   every time somebody wrote mid-pass.
 * - **The cursor only advances on a completed pass.** An aborted one leaves it
 *   where it was, so the next pass re-reads the same tail; the guarded write
 *   absorbs the repetition. Advancing early would silently skip material.
 *
 * The agent itself is injected. That keeps this file testable without a model,
 * and keeps the choice of how to run one - a background session, the current
 * one, a stub - out of the logic.
 */

import type { InstructionManager } from "../instructions/manager.ts";
import type { Turn } from "../memory/transcript-view.ts";
import type { MemoryController } from "../session/controller.ts";
import type { StumbleLog } from "../session/stumbles.ts";
import type { ConsolidationSettings } from "../settings/defaults.ts";
import type { CursorStore } from "./cursor-store.ts";
import { habitsPrompt } from "./habits.ts";
import { ConsolidationLedger } from "./ledger.ts";
import { passMemoryView, passPrompt, passTail } from "./pass.ts";
import { nextCursor, type ReviewWindow, reviewPrompt } from "./review.ts";
import type { TranscriptCursor } from "./transcript.ts";
import { reviewWindowSize } from "./window.ts";

/** The name that ends a pass. Registered only while one is running. */
export const DONE_TOOL = "longterm_done";

export interface PassAgentRequest {
	prompt: string;
	/** Called before each step; the returned text is appended to the prompt tail. */
	tail(): string;
	/** Called for every tool the pass invokes, so the ledger can see it. */
	onToolCall(name: string, argsKey: string): void;
	/** Called when a step produced no tool call at all. */
	onIdleTurn(): void;
	/** True once the ledger has decided the pass is over. */
	finished(): boolean;
	signal?: AbortSignal;
}

export interface PassAgent {
	run(request: PassAgentRequest): Promise<void>;
}

export interface RunnerDeps {
	settings: ConsolidationSettings;
	controller: MemoryController;
	cursors: CursorStore;
	instructions: InstructionManager;
	agent: PassAgent;
	/**
	 * What the cursor is filed under.
	 *
	 * A project id inside a project, the working directory outside one. It
	 * only has to be stable and unique per transcript, and the transcript pi
	 * writes is keyed by working directory - not by project.
	 */
	cursorKey: string;
	/** How the pass refers to what it is reviewing, in its own prompt. */
	label: string;
	/** How far the review job has walked, filed under the same key. */
	reviewCursor: {
		get(key: string): Promise<number>;
		set(key: string, at: number): Promise<void>;
	};
	/** What a person calls one memory; used to head a review window. */
	scopeLabel(scope: "project" | "user"): string;
	clock: () => string;
	/** Reads the unprocessed tail; injected so the walk stays testable. */
	readTail(cursor: TranscriptCursor | undefined): Promise<{
		turns: Turn[];
		cursor?: TranscriptCursor;
	}>;
	/**
	 * Mistakes counted across sessions. Absent means the habits phase is off.
	 */
	stumbles?: StumbleLog;
	/**
	 * The cap on standing rules, quoted to the model in the habits phase.
	 *
	 * Quoted rather than merely enforced: a model told to be brief and then
	 * refused for length has wasted a step, and it cannot see the limit from
	 * anywhere else.
	 */
	alwaysLimits: { alwaysMax: number; alwaysMaxChars: number };
}

export interface PassOutcome {
	ran: boolean;
	/** Why it did not run, when it did not. */
	reason?: string;
	steps?: number;
}

export class ConsolidationRunner {
	constructor(private readonly deps: RunnerDeps) {}

	/** One pass over the unprocessed transcript and repeated model mistakes. */
	async runOnce(signal?: AbortSignal): Promise<PassOutcome> {
		if (!this.deps.settings.enabled) return { ran: false, reason: "disabled" };

		const transcript = await this.readPhase(signal);
		const habit = await this.habitsPhase(signal);

		if (transcript && this.deps.settings.maintain) {
			await this.deps.controller.maintain();
		}

		if (transcript || habit) return { ran: true, steps: 0 };
		return { ran: false, reason: "nothing new" };
	}

	/** One independent maintenance pass over old stored facts. */
	async runReviewOnce(signal?: AbortSignal): Promise<PassOutcome> {
		if (!this.deps.settings.enabled) return { ran: false, reason: "disabled" };
		if (!this.deps.settings.review.enabled) {
			return { ran: false, reason: "review disabled" };
		}

		const reviewed = await this.reviewPhase(signal);
		if (reviewed && this.deps.settings.maintain) {
			await this.deps.controller.maintain();
		}
		return reviewed
			? { ran: true, steps: 0 }
			: { ran: false, reason: "nothing to review" };
	}

	/** Phase one: the unprocessed tail of the transcript. Ran, or did not. */
	private async readPhase(signal?: AbortSignal): Promise<boolean> {
		const cursor = await this.deps.cursors.get(this.deps.cursorKey);
		const tail = await this.deps.readTail(cursor);
		if (tail.turns.length === 0) return false;

		const ledger = new ConsolidationLedger(this.deps.settings);
		const memory = passMemoryView(
			await this.deps.controller.consolidationView(queryFrom(tail.turns)),
		);
		await this.run(
			passPrompt({
				instructions: await this.deps.instructions.read("consolidation"),
				clock: this.deps.clock(),
				memory,
				transcript: tail.turns,
				label: this.deps.label,
			}),
			ledger,
			signal,
		);

		// Only a pass that was not cut short moves the cursor. Re-reading is
		// absorbed by the guarded write; skipping is not recoverable.
		if (signal?.aborted !== true && tail.cursor !== undefined) {
			await this.deps.cursors.set(this.deps.cursorKey, tail.cursor);
		}
		return true;
	}

	/**
	 * Phase two: the oldest facts still stored.
	 *
	 * The window walks forward and wraps at the end, so every fact is revisited
	 * eventually and none twice in a row. The cursor is the highest id shown;
	 * an empty window means the walk reached the end and starts over.
	 */
	private async reviewPhase(signal?: AbortSignal): Promise<boolean> {
		const settings = this.deps.settings.review;
		if (!settings.enabled || settings.sampleSize <= 0) return false;

		const from = await this.deps.reviewCursor.get(this.deps.cursorKey);
		const windows: ReviewWindow[] = [];
		let held = 0;
		for (const scope of this.deps.controller.reviewableScopes()) {
			// Sized against what this memory holds, so a full cycle stays at
			// roughly a hundred passes whatever that is - see `window.ts`.
			const live = await this.deps.controller.liveFactCount(scope);
			held += live;
			const facts = await this.deps.controller.oldestFacts(
				scope,
				from,
				reviewWindowSize(settings.sampleSize, live),
			);
			if (facts.length > 0) {
				windows.push({ scope, label: this.deps.scopeLabel(scope), facts });
			}
		}
		if (windows.length === 0) {
			// The end of the walk. Start again from the beginning next time -
			// what survived one review is worth asking about again later.
			if (from > 0) await this.deps.reviewCursor.set(this.deps.cursorKey, 0);
			return false;
		}

		const ledger = new ConsolidationLedger(this.deps.settings);
		await this.run(
			reviewPrompt({
				instructions: await this.deps.instructions.read("review"),
				clock: this.deps.clock(),
				windows,
				held,
			}),
			ledger,
			signal,
		);
		if (signal?.aborted !== true) {
			await this.deps.reviewCursor.set(
				this.deps.cursorKey,
				nextCursor(windows),
			);
		}
		return true;
	}

	/**
	 * Phase three: one mistake this model has made in several sessions.
	 *
	 * Last of the three, and the only one that can go a long time without
	 * running at all - which is the correct shape. The first two jobs have
	 * material almost every pass; this one has material only when something is
	 * actually going wrong, and a phase that fires on nothing would be a phase
	 * that invents a habit to have something to say.
	 *
	 * The kind is marked covered whether or not a rule was written. If the model
	 * judged it not worth one, asking again next pass would be asking a decided
	 * question - and the counter keeps running either way, so a habit that
	 * outlives the decision still reaches `/longterm-status`.
	 */
	private async habitsPhase(signal?: AbortSignal): Promise<boolean> {
		const settings = this.deps.settings.habits;
		const log = this.deps.stumbles;
		if (log === undefined || !settings.enabled || settings.afterSessions <= 0) {
			return false;
		}
		const habit = await log.worstUncovered(settings.afterSessions);
		if (habit === undefined) return false;

		const standing = (await this.deps.controller.alwaysRules()).map(
			(rule) => rule.text,
		);
		const ledger = new ConsolidationLedger(this.deps.settings);
		await this.run(
			habitsPrompt({
				clock: this.deps.clock(),
				habit,
				standing,
				limits: this.deps.alwaysLimits,
			}),
			ledger,
			signal,
		);
		// Not on an interrupted pass: the model may not have got as far as
		// deciding, and marking it covered would close the question silently.
		if (signal?.aborted !== true) await log.markCovered(habit.kind);
		return true;
	}

	/** One agent run under one ledger. Both phases are the same shape. */
	private async run(
		prompt: string,
		ledger: ConsolidationLedger,
		signal?: AbortSignal,
	): Promise<void> {
		await this.deps.agent.run({
			prompt,
			tail: () => passTail(ledger),
			onToolCall: (name, argsKey) => {
				ledger.noteToolCall(name, argsKey);
				if (name === DONE_TOOL) ledger.noteDone();
				else if (isWrite(name)) ledger.noteWrite();
			},
			onIdleTurn: () => ledger.noteIdleTurn(),
			finished: () => ledger.finished(),
			...(signal === undefined ? {} : { signal }),
		});
	}
}

function isWrite(name: string): boolean {
	return (
		name === "longterm_remember" ||
		name === "longterm_remember_many" ||
		name === "longterm_revise" ||
		name === "longterm_forget" ||
		name === "longterm_forget_many"
	);
}

/**
 * What the memory is asked about before the pass starts.
 *
 * The newest part of the tail, because that is what the pass will be reasoning
 * about, and because a query built from the whole tail retrieves everything and
 * therefore distinguishes nothing.
 */
function queryFrom(turns: readonly Turn[]): string {
	return turns
		.slice(-4)
		.map((turn) => turn.text)
		.join("\n")
		.slice(0, 600);
}

/**
 * A stable signature for "the same call again".
 *
 * Key order in a parsed JSON object follows the model's output, so two
 * identical calls can serialise differently. Sorting makes the repeat
 * detectable, which is the entire point of recording it.
 */
export function stableKey(args: Record<string, unknown>): string {
	return JSON.stringify(
		Object.keys(args)
			.sort()
			.map((key) => [key, args[key]]),
	);
}
