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
import type { ConsolidationSettings } from "../settings/defaults.ts";
import type { CursorStore } from "./cursor-store.ts";
import { ConsolidationLedger } from "./ledger.ts";
import { passMemoryView, passPrompt, passTail } from "./pass.ts";
import { nextCursor, type ReviewWindow, reviewPrompt } from "./review.ts";
import type { TranscriptCursor } from "./transcript.ts";

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
	/** How far the review phase has walked, filed under the same key. */
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
}

export interface PassOutcome {
	ran: boolean;
	/** Why it did not run, when it did not. */
	reason?: string;
	steps?: number;
}

export class ConsolidationRunner {
	constructor(private readonly deps: RunnerDeps) {}

	/**
	 * One pass: read what happened, then re-read what is already stored.
	 *
	 * Two phases and two agent runs, not one run with two sections, for two
	 * reasons. They compete for the same step budget otherwise, and the first
	 * phase would routinely eat it. And the second phase must be able to run
	 * when the first has nothing to do: an idle machine with no new transcript
	 * is exactly when there is time to age the memory, and refusing then means
	 * the review happens least on the days it costs least.
	 */
	async runOnce(signal?: AbortSignal): Promise<PassOutcome> {
		if (!this.deps.settings.enabled) return { ran: false, reason: "disabled" };

		const transcript = await this.readPhase(signal);
		const reviewed = await this.reviewPhase(signal);

		// Reclaim what either phase forgot. Last, because it is the only step
		// that is about bytes rather than about content, and because both
		// phases produce the tombstones it collects.
		if ((transcript || reviewed) && this.deps.settings.maintain) {
			await this.deps.controller.maintain();
		}

		if (transcript || reviewed) return { ran: true, steps: 0 };
		return { ran: false, reason: "nothing new" };
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
		for (const scope of this.deps.controller.reviewableScopes()) {
			const facts = await this.deps.controller.oldestFacts(
				scope,
				from,
				settings.sampleSize,
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
		name === "longterm_revise" ||
		name === "longterm_forget"
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
