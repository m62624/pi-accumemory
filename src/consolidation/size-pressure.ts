/**
 * Safe, bounded cleanup when one memory approaches its byte budget.
 *
 * The agent sees only an oldest bounded candidate window and only the forget
 * tools. Runtime code filters protected facts and the controller rejects a
 * protected id even if a model guesses it. A pass may fail to reclaim enough
 * space; that is a reportable state, never a reason to delete arbitrary facts.
 */

import type { InstructionManager } from "../instructions/manager.ts";
import type { MemoryController } from "../session/controller.ts";
import type {
	ConsolidationSettings,
	SizeLimitSettings,
} from "../settings/defaults.ts";
import type {
	SizeLimitedMemory,
	SizeScope,
	SizeSnapshot,
} from "../storage/size-limits.ts";
import { ConsolidationLedger } from "./ledger.ts";
import { DONE_TOOL, type PassAgent } from "./runner.ts";

export type SizePressureReason =
	| "disabled"
	| "resolved"
	| "no-candidates"
	| "no-progress"
	| "max-passes"
	| "interrupted";

export interface SizePressureOutcome {
	ran: boolean;
	reason: SizePressureReason;
	passes: number;
	before: SizeSnapshot;
	after: SizeSnapshot;
}

export interface SizePressureDeps {
	settings: ConsolidationSettings;
	limits: SizeLimitSettings;
	controller: MemoryController;
	memories: {
		user: SizeLimitedMemory;
		project?: SizeLimitedMemory;
	};
	instructions: InstructionManager;
	agent: PassAgent;
	scopeLabel(scope: SizeScope): string;
	clock(): string;
}

export class SizePressureRunner {
	constructor(private readonly deps: SizePressureDeps) {}

	async run(
		scope: SizeScope,
		signal?: AbortSignal,
	): Promise<SizePressureOutcome> {
		const memory = this.memory(scope);
		const before = await memory.snapshot();
		if (before.limitBytes === 0) {
			return {
				ran: false,
				reason: "disabled",
				passes: 0,
				before,
				after: before,
			};
		}
		let previous = before;
		if (belowConsolidation(previous, this.deps.limits)) {
			return {
				ran: false,
				reason: "resolved",
				passes: 0,
				before,
				after: previous,
			};
		}

		for (let pass = 0; pass < this.deps.limits.maxPasses; pass += 1) {
			if (signal?.aborted) {
				return {
					ran: pass > 0,
					reason: "interrupted",
					passes: pass,
					before,
					after: previous,
				};
			}
			await memory.maintain("compact");
			previous = await memory.snapshot();
			if (belowConsolidation(previous, this.deps.limits)) {
				return {
					ran: true,
					reason: "resolved",
					passes: pass,
					before,
					after: previous,
				};
			}

			const candidates = await this.deps.controller.sizeCandidates(
				scope,
				Math.max(1, this.deps.settings.review.sampleSize),
			);
			if (candidates.length === 0) {
				return {
					ran: true,
					reason: "no-candidates",
					passes: pass,
					before,
					after: previous,
				};
			}

			const prompt = sizePressurePrompt({
				clock: this.deps.clock(),
				instructions: await this.deps.instructions.read("review"),
				scope,
				label: this.deps.scopeLabel(scope),
				current: previous,
				targetRatio: this.deps.limits.consolidationRatio,
				candidates,
			});
			const ledger = new ConsolidationLedger(this.deps.settings);
			await this.deps.controller.withAutomaticDeleteProtection(
				() => this.runAgent(prompt, ledger, signal),
				candidates.map((candidate) => candidate.id),
			);
			if (signal?.aborted) {
				return {
					ran: true,
					reason: "interrupted",
					passes: pass + 1,
					before,
					after: previous,
				};
			}

			await memory.maintain("compact");
			const after = await memory.snapshot();
			if (belowConsolidation(after, this.deps.limits)) {
				return {
					ran: true,
					reason: "resolved",
					passes: pass + 1,
					before,
					after,
				};
			}
			if (after.footprint.activeBytes >= previous.footprint.activeBytes) {
				return {
					ran: true,
					reason: "no-progress",
					passes: pass + 1,
					before,
					after,
				};
			}
			previous = after;
		}

		return {
			ran: true,
			reason: "max-passes",
			passes: this.deps.limits.maxPasses,
			before,
			after: previous,
		};
	}

	private memory(scope: SizeScope): SizeLimitedMemory {
		const memory =
			scope === "user" ? this.deps.memories.user : this.deps.memories.project;
		if (memory === undefined) throw new Error(`No ${scope} memory is open`);
		return memory;
	}

	private async runAgent(
		prompt: string,
		ledger: ConsolidationLedger,
		signal?: AbortSignal,
	): Promise<void> {
		await this.deps.agent.run({
			prompt,
			tail: () => ledger.directive().text,
			onToolCall: (name, argsKey) => {
				ledger.noteToolCall(name, argsKey);
				if (name === "longterm_forget" || name === "longterm_forget_many")
					ledger.noteWrite();
				if (name === DONE_TOOL) ledger.noteDone();
			},
			onIdleTurn: () => ledger.noteIdleTurn(),
			finished: () => ledger.finished(),
			...(signal === undefined ? {} : { signal }),
		});
	}
}

function belowConsolidation(
	snapshot: SizeSnapshot,
	limits: SizeLimitSettings,
): boolean {
	return snapshot.ratio < limits.consolidationRatio;
}

interface SizePromptContext {
	clock: string;
	instructions: string;
	scope: SizeScope;
	label: string;
	current: SizeSnapshot;
	targetRatio: number;
	candidates: readonly { id: number; text: string; tags: string[] }[];
}

function sizePressurePrompt(context: SizePromptContext): string {
	const lines = [
		context.clock,
		"",
		"You are pi-accumemory's memory-size specialist.",
		"You have only the memory tools. Do not answer a user.",
		"",
		`The active ${context.label} is using ${context.current.footprint.activeBytes} bytes, ` +
			`and its configured target is below ${Math.round(context.current.limitBytes * context.targetRatio)} bytes.`,
		`Every candidate below belongs to the ${context.scope} memory; pass scope: "${context.scope}" in every write.`,
		"The runtime has already removed physical tombstones where possible.",
		"",
		"Delete only facts that are clearly redundant, obsolete, temporary, or low-value.",
		"Do not delete a fact merely because it is old or unfamiliar.",
		"Do not invent replacements and do not use revise: revision history is retained and does not reduce storage.",
		"If no candidate is clearly safe, call longterm_done without deleting anything.",
		"",
		context.instructions,
		"",
		"Candidate facts:",
		...context.candidates.map(
			(fact) =>
				`- [f${fact.id}] ${fact.text}${fact.tags.length === 0 ? "" : ` #${fact.tags.join(" #")}`}`,
		),
		"",
		"Use one small longterm_forget_many call for clear duplicates when possible.",
		"Finish with longterm_done.",
	];
	return lines.join("\n");
}
