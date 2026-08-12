/**
 * `longterm_about`: what this extension is and how it behaves, answered from
 * bundled pages instead of from whatever the model can reconstruct.
 *
 * The problem it solves is not ignorance, it is confident invention. A model
 * asked "how does your memory work" produces a description of A memory system -
 * fluent, plausible, and not this one. It then acts on that description. Every
 * session decoded so far contained at least one decision taken from a rule the
 * extension does not have.
 *
 * The head instructions cannot fix that on their own. They are paid for on every
 * request, so they must stay short, and short is what a local model handles
 * worst: it needs the worked example, the named consequence, the reason the
 * obvious alternative is wrong. A page is paid for by the one turn that asks for
 * it, so the pages can be as long as the subject deserves.
 *
 * Two rules carried over from pi-telegram-manager's `telegram_bot_about`, both
 * load-bearing:
 *
 * - **One topic per call.** Handing over everything at once buries the answer.
 *   Choosing costs nothing, because a question names its own subject.
 * - **A budget per turn.** A model that can read pages will read pages instead
 *   of working. Three is enough to answer any question about this extension;
 *   after that the refusal names the way out, because a bare "no" invites the
 *   same call again.
 *
 * The one branch enforced in code rather than in prose is the API key.
 * `current_settings` prints the NAME of the environment variable and whether it
 * is set, and there is no path through this file that can reach the value. A
 * prompt telling a model not to print a secret is a request; a function that
 * never holds one is a guarantee.
 */

import { ABOUT_PAGES } from "../about/pages.ts";
import type { Settings } from "../settings/defaults.ts";

/** Every topic a caller may ask for, in the order the description lists them. */
export const ABOUT_TOPICS = [
	"system",
	"turn",
	"scopes",
	"writing",
	"recall",
	"consolidation",
	"settings",
	"current_settings",
] as const;

export type AboutTopic = (typeof ABOUT_TOPICS)[number];

/** How many pages one turn may read before it has to get on with the work. */
export const ABOUT_CALLS_PER_TURN = 3;

/**
 * Said when the budget is spent.
 *
 * It names what to do INSTEAD. A refusal that only refuses is answered by
 * repeating the call - observed with every other guard in this extension.
 */
export const ABOUT_BUDGET_SPENT =
	`You have read ${ABOUT_CALLS_PER_TURN} pages this turn, which is enough to answer ` +
	"any question about this memory. Carry on with the request now, using what you " +
	"have. Do not call longterm_about again in this turn.";

export interface AboutDeps {
	settings: Settings;
	/**
	 * Whether an environment variable holds anything, WITHOUT reading it.
	 *
	 * Injected so tests need no real environment, and typed as a boolean so no
	 * caller can hand a value back into a page by accident.
	 */
	hasEnv?: (name: string) => boolean;
	/**
	 * Where the settings actually live on THIS machine, and where the databases
	 * are - both resolved by the same code that opened them.
	 *
	 * Prose cannot say this. The location is derived at startup from pi's agent
	 * directory, so a page describing it in words is describing one installation
	 * and guessing at every other. A model asked "where do I change that" then
	 * either invents a path or sends the user hunting.
	 *
	 * So the paths come from `layout`, which is the single place that computed
	 * them. Neither is a secret - the user is the one who would edit them - and
	 * neither is guessed.
	 */
	paths?: { settingsFile: string; memoryDir: string };
}

/**
 * The pages, plus the per-turn budget.
 *
 * A small object rather than free functions because the budget is state and it
 * belongs beside the thing it limits. It is reset by the controller at the top
 * of every turn.
 */
export class AboutDesk {
	private used = 0;

	constructor(private readonly deps: AboutDeps) {}

	/** A new turn: the model may read again. */
	reset(): void {
		this.used = 0;
	}

	/** Claims one read of this turn's budget; false once it is spent. */
	claim(): boolean {
		return ++this.used <= ABOUT_CALLS_PER_TURN;
	}

	read(topic: AboutTopic): string {
		if (topic === "current_settings") return this.currentSettings();
		return ABOUT_PAGES[topic];
	}

	/**
	 * The live configuration, rendered.
	 *
	 * Only the settings that change how the memory behaves. The point is to
	 * answer "why did it do that" - a model that can see `embedder.enabled` is
	 * false can explain why a differently-worded question found nothing, instead
	 * of guessing that the fact was never stored.
	 */
	private currentSettings(): string {
		const { memory, timezone } = this.deps.settings;
		const { embedder, consolidation, refresh, nudge } = memory;
		const { paths } = this.deps;
		const lines = [
			"# What this session is running with",
			"",
			"Read when the session started. Nothing said in this conversation changes any",
			"of it: the user edits the file below and restarts Pi.",
			"",
			"## Where it lives",
			`- settings file: ${paths?.settingsFile ?? "not known in this session"}`,
			`- databases: ${paths?.memoryDir ?? "not known in this session"}`,
			"",
			"Those are the real paths on this machine, resolved by the code that opened",
			"them - not a guess and not a convention. If the settings file is not there,",
			"it has never been written and every value below is the built-in default.",
			"",
			"## Memory",
			`- enabled: ${memory.enabled}`,
			`- writeOutput: ${memory.writeOutput} (what the USER's terminal shows; you always get everything)`,
			`- recallTokenBudget: ${memory.recallTokenBudget}`,
			`- recallK: ${memory.recallK}`,
			`- queryMaxChars: ${memory.queryMaxChars}`,
			`- graphDepth: ${memory.graphDepth ?? "engine default"}`,
			`- manifest: ${memory.manifest}`,
			`- crossProject.enabled: ${memory.crossProject.enabled}`,
			`- instructions.alwaysMax: ${memory.instructions.alwaysMax}`,
			`- instructions.alwaysMaxChars: ${memory.instructions.alwaysMaxChars}`,
			`- notes.overviewMaxChars: ${memory.notes.overviewMaxChars}`,
			`- timezone: ${timezone ?? "the machine's own"}`,
			"",
			"## Semantic search",
			`- embedder.enabled: ${embedder.enabled}${
				embedder.enabled
					? ""
					: " - WITHOUT VECTORS a question worded differently from the stored fact will not find it"
			}`,
			`- embedder.url: ${embedder.url}`,
			`- embedder.model: ${embedder.model}`,
			`- embedder.dim: ${embedder.dim}`,
			`- embedder.spaceId: ${embedder.spaceId ?? "the model name"}`,
			`- embedder.autoReembed: ${embedder.autoReembed}`,
			`- embedder.apiKeyEnv: ${this.keyLine(embedder.apiKeyEnv)}`,
			"",
			"## When the block is rebuilt",
			`- refresh.afterToolCalls: ${refresh.afterToolCalls}`,
			`- refresh.onCompact: ${refresh.onCompact}`,
			`- refresh.askHintAfterIdleInferences: ${refresh.askHintAfterIdleInferences}`,
			"",
			"## Reminders",
			`- nudge.enabled: ${nudge.enabled}`,
			`- nudge.afterMessages: ${nudge.afterMessages}`,
			`- nudge.afterToolCalls: ${nudge.afterToolCalls}`,
			`- nudge.cooldownTurns: ${nudge.cooldownTurns}`,
			"",
			"## The idle pass",
			`- consolidation.enabled: ${consolidation.enabled}`,
			`- consolidation.quietMs: ${consolidation.quietMs} (${Math.round(consolidation.quietMs / 60_000)} minutes of quiet)`,
			`- consolidation.maxSteps: ${consolidation.maxSteps}`,
			`- consolidation.maxNudges: ${consolidation.maxNudges}`,
			`- consolidation.maxTranscriptChars: ${consolidation.maxTranscriptChars}`,
			`- consolidation.promoteToCommon: ${consolidation.promoteToCommon}`,
			`- consolidation.review.enabled: ${consolidation.review.enabled}`,
			`- consolidation.review.sampleSize: ${consolidation.review.sampleSize}`,
			`- consolidation.habits.enabled: ${consolidation.habits.enabled}`,
			`- consolidation.habits.afterSessions: ${consolidation.habits.afterSessions}`,
			`- consolidation.maintain: ${consolidation.maintain}`,
		];
		return lines.join("\n");
	}

	/**
	 * The key setting, as the only thing about a key that may ever be printed.
	 *
	 * The variable's NAME and whether it holds anything. Whether it is set is
	 * the diagnostic half - "the endpoint is configured and the variable is
	 * empty" is a real answer, and it needs no part of the value.
	 */
	private keyLine(name: string | null): string {
		if (name === null) return "not configured (no key is sent)";
		const set = this.deps.hasEnv?.(name) ?? false;
		return `the ${name} environment variable, which is currently ${
			set ? "set" : "EMPTY"
		}. Its value is never read into a prompt, printed, or stored.`;
	}
}

/**
 * Composed after the shared "whose memory is this" opener, like every other
 * description here - and this tool needs it most, because `planner_about` and
 * `telegram_bot_about` are the two tools a model is likeliest to reach for by
 * mistake when it wants to know how its memory works.
 */
export const ABOUT_DESCRIPTION =
	"This tool stores and reads no facts: it explains how that memory itself " +
	"works, what it did, and why. Call this - never " +
	"answer from memory - whenever you are unsure which memory call to make, why a " +
	"write was refused, why a fact you stored is gone or changed, what a scope is, " +
	"what the block above your turn is, or when someone asks how your memory works. " +
	"This is the pi-accumemory tool: never substitute another extension's " +
	"about-style tool (planner_about, telegram_bot_about and the like) - they " +
	"describe different software with different rules. Do NOT call it during " +
	"ordinary work you already know how to do. One topic per call: 'system' (what " +
	"this is, the two memories, what a fact is, revise vs forget vs maintenance), " +
	"'turn' (the order to do things in, which call for which situation, worked " +
	"examples), 'scopes' (project vs user vs both, and why an id needs one), " +
	"'writing' (what is worth storing, one fact per call, what to do when a write " +
	"is refused), 'recall' (how search works, why a recall is not a duplicate " +
	"check, tags and links), 'consolidation' (what happens to the memory while " +
	"nobody is typing, and why facts change on their own), 'settings' (what is " +
	"configurable - and why nothing said in a conversation can change one), " +
	`'current_settings' (the values THIS session is running with). At most ${ABOUT_CALLS_PER_TURN} ` +
	"pages per turn.";

/** Answers one call. Separate from the tool spec so tests need no controller. */
export function readAbout(desk: AboutDesk, topic: unknown): string {
	if (typeof topic !== "string" || !isTopic(topic)) {
		return (
			`Unknown topic ${JSON.stringify(topic)}. Choose exactly one of: ` +
			`${ABOUT_TOPICS.join(", ")}.`
		);
	}
	if (!desk.claim()) return ABOUT_BUDGET_SPENT;
	return desk.read(topic);
}

function isTopic(value: string): value is AboutTopic {
	return (ABOUT_TOPICS as readonly string[]).includes(value);
}
