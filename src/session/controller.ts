/**
 * The session's memory controller: one object that knows which databases are
 * open, what the model may do to them, and what goes into the prompt tail.
 *
 * It exists so that the tools are thin. A tool should be a name, a schema and a
 * sentence of description - deciding *which* database a write lands in is not a
 * decision the model gets to make by filling in a parameter, and there is no
 * `database` argument anywhere in this extension for it to fill in.
 */

import { AskGuard } from "../memory/ask-guard.ts";
import {
	type BlockSection,
	consolidationBlock,
	dropVisible,
	type ManifestScope,
	memoryBlock,
	memoryManifest,
} from "../memory/block.ts";
import { WriteNudge } from "../memory/nudge.ts";
import { progressQuery, recallQuery } from "../memory/query.ts";
import { RefreshPolicy } from "../memory/refresh.ts";
import { RepeatGuard } from "../memory/repeat-guard.ts";
import { suggestionText, suggestTag } from "../memory/tag-suggest.ts";
import { type FactLine, snip, type ToolReport } from "../memory/tool-report.ts";
import type { Turn } from "../memory/transcript-view.ts";
import {
	modelReport,
	type Neighbour,
	type WriteReport,
} from "../memory/write-report.ts";
import type { NoteStore } from "../notes/store.ts";
import { PROJECT_TAG, projectEntity, USER_ENTITY } from "../router/entities.ts";
import type { ProjectRouter } from "../router/router.ts";
import {
	defaultSecretGuard,
	type SecretGuard,
	type SecretWritePart,
} from "../security/secret-guard.ts";
import type { Settings } from "../settings/defaults.ts";
import { isEmbedderFailure, isVectorSpaceMismatch } from "../storage/errors.ts";
import {
	type EdgeRef,
	type EmbedderState,
	type FactCard,
	liveFacts,
	type ReadableMemory,
	type WritableMemory,
} from "../storage/port.ts";
import { AboutDesk, readAbout as readAboutPage } from "../tools/about.ts";
import { defined } from "../tools/args.ts";
import type { StumbleKind, StumbleLog } from "./stumbles.ts";
import { alwaysBlock, buildTail, clockLine } from "./tail.ts";

/** Which memory a call is about. */
export type Scope = "project" | "user" | "both";

export const INSTRUCTION_TAG = "instruction";
export const ALWAYS_TAG = "always";

export interface CrossProjectReader {
	memory: ReadableMemory;
	close(): void;
}

export interface ControllerDeps {
	settings: Settings;
	common: WritableMemory;
	/** Absent when the working directory is not a project. */
	project?: WritableMemory;
	projectId?: string;
	projectName?: string;
	notesCommon: NoteStore;
	notesProject?: NoteStore;
	router: ProjectRouter;
	/** Opens another project's memory read-only, for a cross-project question. */
	openProjectReader?: (projectId: string) => Promise<CrossProjectReader>;
	/**
	 * Rebuilds another project's vectors after an embedder change.
	 *
	 * Needed because a read-only handle cannot repair itself - write verbs are
	 * refused on one - and only the project's own session repairs it at
	 * startup. A project nobody has opened since the model changed would
	 * otherwise answer every cross-project question with an error.
	 */
	repairProject?: (projectId: string) => Promise<string | undefined>;
	now?: () => Date;
	/**
	 * Real paths on this machine, for `longterm_about`'s settings pages.
	 *
	 * Passed rather than described, because only `layout` knows them - see
	 * `AboutDeps`.
	 */
	paths?: { settingsFile: string; memoryDir: string };
	/**
	 * The engine as it is right now, for `longterm_about`'s settings page.
	 *
	 * The embedder is the one setting that changes under the session's feet: a
	 * provider that stops answering suspends it, and a model that cannot see
	 * that explains a thin answer by inventing something else.
	 */
	engine?: { configFile: string; embedderState(): EmbedderState };
	/**
	 * Where repeated mistakes are counted across sessions.
	 *
	 * Optional: a session without one behaves exactly as before, and every
	 * refusal reads the same. Nothing here changes what the model is told - the
	 * log only decides what a later consolidation pass is shown.
	 */
	stumbles?: StumbleLog;
	/** The hard, local gate in front of every model-created fact write. */
	secretGuard?: SecretGuard;
}

export interface AskInput {
	question: string;
	scope?: Scope;
	tags?: string[];
	k?: number;
	graphDepth?: number;
}

/** A fact row for the human inspection desk, with its database identity kept. */
export interface InspectFact {
	scope: Exclude<Scope, "both">;
	label: string;
	card: FactCard;
}

/** A graph edge labelled with the memory it belongs to. */
export interface InspectEdge extends EdgeRef {
	scope: Exclude<Scope, "both">;
	label: string;
}

export interface RememberInputForModel {
	text: string;
	scope?: Scope;
	tags?: string[];
	entity?: string;
}

export class MemoryController {
	private readonly refresh: RefreshPolicy;
	private readonly nudge: WriteNudge;
	private readonly askGuard = new AskGuard();
	private readonly repeatGuard = new RepeatGuard();
	private readonly now: () => Date;
	private readonly secretGuard: SecretGuard;
	/** The `longterm_about` pages, and this turn's budget for reading them. */
	readonly about: AboutDesk;

	/** The last computed block, held between refresh events so the tail is stable. */
	private block = "";
	private manifestPending: boolean;
	private manifestShown = false;
	/** What the last tool call did, for the terminal renderer. */
	private lastReport: ToolReport | undefined;
	/**
	 * `scope:id` of every fact this session has dropped.
	 *
	 * Kept so a second attempt on the same id can be answered with "you did
	 * that, and it worked" rather than an ambiguity the model resolves as "my
	 * tools do not work".
	 */
	private readonly forgotten = new Set<string>();

	constructor(private readonly deps: ControllerDeps) {
		this.refresh = new RefreshPolicy(deps.settings.memory.refresh);
		this.nudge = new WriteNudge(deps.settings.memory.nudge);
		this.now = deps.now ?? (() => new Date());
		this.secretGuard = deps.secretGuard ?? defaultSecretGuard;
		this.manifestPending = deps.settings.memory.manifest;
		this.about = new AboutDesk({
			settings: deps.settings,
			...defined({ paths: deps.paths, engine: deps.engine }),
		});
	}

	// -- lifecycle notes ----------------------------------------------------

	noteUserMessage(): void {
		this.refresh.noteUserMessage();
		this.nudge.noteMessage();
		// A new request is a new run: the same question may be fair again.
		this.askGuard.reset();
		this.repeatGuard.reset();
		// A new request may be about something the model has not read about yet.
		this.about.reset();
	}

	/**
	 * One `longterm_about` page, budget included.
	 *
	 * A method rather than the desk itself, because everything the tools reach
	 * for has to be reachable through the lazy façade too, and a façade can
	 * stand in for a method in a way it cannot for a live object.
	 */
	readAbout(topic: unknown): string {
		const page = readAboutPage(this.about, topic);
		this.record({
			kind: "about",
			topic: typeof topic === "string" ? topic : String(topic),
			chars: page.length,
		});
		return page;
	}

	/**
	 * Records a named mistake, when this installation is counting them.
	 *
	 * Never awaited for its result and never able to fail a call: every caller
	 * is inside a refusal that was already written, and a refusal that becomes
	 * an exception because a JSON file was busy would be a far worse bug than
	 * the habit it was trying to notice.
	 */
	private async stumbled(kind: StumbleKind): Promise<void> {
		try {
			await this.deps.stumbles?.note(kind);
		} catch {
			// See above.
		}
	}

	noteToolCall(name: string): void {
		this.refresh.noteToolCall();
		this.nudge.noteToolCall();
		// Anything that is not a memory lookup counts as making progress.
		if (name !== "longterm_ask" && name !== "longterm_ask_project") {
			this.askGuard.noteOtherActivity();
		}
	}

	noteTurnEnd(usedTools: boolean): void {
		this.refresh.noteTurnEnd(usedTools);
		this.nudge.noteTurn();
	}

	/**
	 * The background pass is the other way to act on the same transcript. Do
	 * not let a nudge budget from before that pass leak into the next live run.
	 */
	noteBackgroundPassStart(): void {
		this.nudge.reset();
	}

	noteCompact(): void {
		this.refresh.noteCompact();
	}

	// -- the prompt tail ----------------------------------------------------

	/**
	 * Everything this extension adds to the next LLM call.
	 *
	 * Recomputed only when the policy says so; otherwise the previously built
	 * block is reused verbatim, which is what keeps the tail byte-identical
	 * between events and the prefix cache intact.
	 */
	async tail(turns: readonly Turn[]): Promise<string> {
		if (!this.deps.settings.memory.enabled) return "";

		const reason = this.refresh.takeDue();
		if (reason !== undefined)
			this.block = await this.buildBlock(turns, reason === "tool_budget");

		const manifest =
			this.manifestPending && !this.manifestShown ? await this.manifest() : "";
		if (manifest !== "") this.manifestShown = true;
		this.manifestPending = false;

		const writeNudge = this.nudge.due() ? WriteNudge.text() : "";
		if (writeNudge !== "") this.nudge.noteShown();

		return buildTail({
			clock: clockLine(this.now(), this.deps.settings.timezone),
			block: [manifest, this.block].filter((part) => part !== "").join("\n\n"),
			alwaysInstructions: await this.alwaysInstructions(),
			writeNudge,
			askHint: this.refresh.askHintDue() ? ASK_HINT : "",
		});
	}

	private async buildBlock(
		turns: readonly Turn[],
		fromProgress: boolean,
	): Promise<string> {
		const { queryMaxChars, recallTokenBudget, recallK, graphDepth } =
			this.deps.settings.memory;
		const query = fromProgress
			? progressQuery(turns, queryMaxChars)
			: recallQuery(turns, queryMaxChars);
		if (query.trim() === "") return "";

		const sections: BlockSection[] = [];
		for (const [scope, label, memory] of this.readableScopes()) {
			const found = await memory.recall({
				query,
				tokenBudget: recallTokenBudget,
				...defined({
					k: recallK > 0 ? recallK : undefined,
					graphDepth: graphDepth ?? undefined,
				}),
			});
			sections.push({
				scope,
				label,
				rendered: dropVisible(found.rendered, turns),
			});
		}
		// One block for both memories - see `memoryBlock` for why wrapping each
		// one separately was worse than it looked.
		return memoryBlock(sections);
	}

	private async manifest(): Promise<string> {
		const scopes: ManifestScope[] = [];
		for (const [, label, memory] of this.readableScopes()) {
			const stats = await memory.stats();
			const tags = await memory.listTags({ limit: 8 });
			// Live, not stored: `facts` counts closed revisions and anything
			// forgotten since the last maintain, so a memory that was just
			// tidied would claim to hold more than before it was.
			scopes.push({ label, facts: liveFacts(stats), tags: tags.items });
		}
		return memoryManifest(scopes);
	}

	/**
	 * The standing rules, injected unconditionally.
	 *
	 * These bypass retrieval entirely, which is why they are capped hard in
	 * {@link alwaysBlock}: an uncapped always-list is the unbounded markdown
	 * file this design set out to avoid, arriving one fact at a time.
	 */
	private async alwaysInstructions(): Promise<string> {
		const rules = (await this.alwaysRules()).map((rule) => rule.text);
		return alwaysBlock(rules, this.deps.settings.memory.instructions);
	}

	/** Every standing rule, with its id and memory, in block order. */
	async alwaysRules(): Promise<
		{ id: number; text: string; scope: Exclude<Scope, "both"> }[]
	> {
		const rules: { id: number; text: string; scope: Exclude<Scope, "both"> }[] =
			[];
		for (const [scope, , memory] of this.readableScopes()) {
			for (const fact of await memory.scan({
				tags: [INSTRUCTION_TAG, ALWAYS_TAG],
			})) {
				rules.push({ id: fact.id, text: fact.text, scope });
			}
		}
		return rules;
	}

	/**
	 * Refuses a standing rule that the always-block could not show anyway.
	 *
	 * A fact tagged `instruction` + `always` is not an ordinary fact: it is
	 * pasted into the head of EVERY request of every later session, forever. It
	 * is the one thing in this extension the model can write that costs the
	 * model context, which makes it the one thing the model must not be trusted
	 * to bound. The instruction file says keep them few and short; a file cannot
	 * enforce anything.
	 *
	 * The test is exact rather than arbitrary: render the block WITH the new
	 * rule and see whether it survives {@link alwaysBlock}'s own limits. A rule
	 * the block would drop is a write that changes nothing, so it is refused
	 * before it is stored - and the refusal names the rules already there, so
	 * the answer ("revise one of them") is reachable.
	 *
	 * Returns the refusal text, or `undefined` when the rule fits.
	 */
	private async wouldOverflowAlways(
		text: string,
		/** The rule being replaced, which must not be counted against itself. */
		replacing?: { id: number; scope: Exclude<Scope, "both"> },
	): Promise<string | undefined> {
		const held = (await this.alwaysRules()).filter(
			(rule) =>
				replacing === undefined ||
				rule.id !== replacing.id ||
				rule.scope !== replacing.scope,
		);
		const limits = this.deps.settings.memory.instructions;
		const candidate = [...held.map((rule) => rule.text), text];
		if (alwaysBlock(candidate, limits).includes(`- ${text.trim()}`)) {
			return undefined;
		}
		const listed = held.map(
			(rule) => `  [f${rule.id}] (scope: "${rule.scope}") ${rule.text}`,
		);
		return [
			"Not stored. Standing rules are pasted into the head of every request of " +
				`every future session, so this installation shows at most ${limits.alwaysMax} of ` +
				`them and at most ${limits.alwaysMaxChars} characters. Yours does not fit, which ` +
				"means storing it would cost a write and change nothing.",
			held.length === 0 ? "" : "The rules already standing:",
			...listed,
			"Either make yours shorter, or decide it matters more than one of those and " +
				"replace that one with longterm_revise. Do not store this as an ordinary " +
				"fact instead - a rule nobody reads is worse than no rule.",
		]
			.filter((line) => line !== "")
			.join("\n");
	}

	// -- pull ----------------------------------------------------------------

	async ask(input: AskInput): Promise<string> {
		const scope = input.scope ?? "project";
		const repeat = this.askGuard.check(input.question);
		this.askGuard.record(input.question);
		if (repeat !== undefined) await this.stumbled("asked_the_same_question");

		const sections: string[] = [];
		let found = 0;
		for (const [factScope, label, memory] of this.readableScopes(scope)) {
			let recalled: Awaited<ReturnType<typeof memory.recall>>;
			try {
				recalled = await memory.recall({
					query: input.question,
					tokenBudget: this.deps.settings.memory.recallTokenBudget,
					...defined({
						tags: input.tags,
						k: input.k,
						graphDepth: input.graphDepth,
					}),
				});
			} catch (error) {
				// The provider is down and this memory was told to fail rather
				// than answer without vectors. Raw, that reaches the model as a
				// tool error and it concludes the memory is broken; said in
				// words, it is a temporary outage with a named fix.
				if (!isEmbedderFailure(error)) throw error;
				return EMBEDDER_UNREACHABLE;
			}
			// Two databases are answered as two labelled sections, never fused
			// into one ranking. plugmem's own measurements put routing ahead of
			// merging by a wide margin, and a merged list hides which memory an
			// answer came from - which is exactly what the reader needs to know.
			found += recalled.facts.length;
			sections.push(
				recalled.rendered.trim() === ""
					? `${label}: nothing on this.`
					: `${label} - these ids are scope: "${factScope}":\n${recalled.rendered.trim()}`,
			);
		}
		if (sections.length === 0) return this.noProjectMessage();
		this.record({
			kind: "ask",
			label: this.label(scope),
			question: input.question,
			found,
		});

		const parts = [sections.join("\n\n")];
		if (repeat !== undefined) parts.push(repeat);
		if (this.askGuard.stuck()) parts.push(AskGuard.stuckText());
		return parts.join("\n\n");
	}

	/** Another project's memory, read-only, named explicitly by the model. */
	async askProject(projectName: string, question: string): Promise<string> {
		if (!this.deps.settings.memory.crossProject.enabled) {
			return "Cross-project memory is switched off in this installation's settings.";
		}
		const project = await this.deps.router.findByName(projectName);
		if (project === undefined) {
			const known = (await this.deps.router.list()).map((entry) => entry.name);
			// An honest miss, never a silently empty answer - the two read
			// identically to a model and mean opposite things.
			return known.length === 0
				? `No project named "${projectName}" is known, and no projects are registered yet.`
				: `No project named "${projectName}" is known. Registered projects: ${known.join(", ")}.`;
		}
		const open = this.deps.openProjectReader;
		if (open === undefined)
			return "Cross-project memory is not available in this session.";

		const answer = await this.readProject(open, project.projectId, question);
		if (answer !== undefined) {
			this.recordCrossProject(project.name, question, answer);
			return this.render(project.name, answer);
		}

		// The vectors in that project are from a different embedder, and a
		// read-only handle cannot rebuild them. Repair it with a brief writer,
		// then ask again - once.
		const repair = this.deps.repairProject;
		if (repair === undefined) return MISMATCHED_PROJECT(project.name);
		const failure = await repair(project.projectId);
		if (failure !== undefined) return `Project "${project.name}": ${failure}`;

		const retried = await this.readProject(open, project.projectId, question);
		if (retried === undefined) return MISMATCHED_PROJECT(project.name);
		this.recordCrossProject(project.name, question, retried);
		return this.render(project.name, retried);
	}

	/**
	 * Another project's answer, counted by lines rather than by facts.
	 *
	 * A cross-project read goes through a reader that hands back the rendered
	 * block and no fact list, so the count is of what is there to see. Close
	 * enough for a terminal line, and not a number anything depends on.
	 */
	private recordCrossProject(
		name: string,
		question: string,
		rendered: string,
	): void {
		this.record({
			kind: "ask",
			label: `the memory of "${name}"`,
			question,
			found:
				rendered === ""
					? 0
					: rendered.split("\n").filter((line) => line.trim().startsWith("- "))
							.length,
		});
	}

	/** The rendered recall, or `undefined` when the vector space disagrees. */
	private async readProject(
		open: (projectId: string) => Promise<CrossProjectReader>,
		projectId: string,
		question: string,
	): Promise<string | undefined> {
		const reader = await open(projectId);
		try {
			const found = await reader.memory.recall({
				query: question,
				tokenBudget: this.deps.settings.memory.recallTokenBudget,
			});
			return found.rendered.trim();
		} catch (error) {
			if (isVectorSpaceMismatch(error)) return undefined;
			throw error;
		} finally {
			reader.close();
		}
	}

	private render(name: string, rendered: string): string {
		return rendered === ""
			? `Project "${name}" has nothing on this.`
			: `Project "${name}":\n${rendered}`;
	}

	async projects(): Promise<string> {
		const known = await this.deps.router.list();
		this.record({ kind: "projects", count: known.length });
		if (known.length === 0) return "No projects are registered yet.";
		return known
			.map((project) => `- ${project.name} (${project.path})`)
			.join("\n");
	}

	// -- writes ---------------------------------------------------------------

	/**
	 * One place for "the memory just changed".
	 *
	 * Two things follow from a write and they are easy to do separately and
	 * then forget one: the write reminder resets, and the block above the next
	 * reply stops being true. The second is the one that was missing.
	 */
	private noteWrote(): void {
		this.nudge.noteWrite();
		this.refresh.noteMemoryChanged();
	}

	private async secretRefusal(
		parts: readonly SecretWritePart[],
	): Promise<string | undefined> {
		const result = await this.secretGuard.check(parts);
		return result.blocked ? result.message : undefined;
	}

	async remember(input: RememberInputForModel): Promise<string> {
		const scope = input.scope ?? "project";
		if (scope === "both") {
			await this.stumbled("wrote_to_a_reading_scope");
			return BOTH_IS_A_READING_SCOPE;
		}
		const memory = this.writableScope(scope);
		if (memory === undefined) return this.noProjectMessage();

		if (isStandingRule(input.tags)) {
			const overflow = await this.wouldOverflowAlways(input.text);
			if (overflow !== undefined) return overflow;
		}

		const suggestions = await this.tagSuggestions(memory, input.tags ?? []);
		const entity = input.entity ?? this.defaultEntity(scope);
		const secretRefusal = await this.secretRefusal([
			{ label: "fact", text: input.text },
			{ label: "entity", text: entity },
			{ label: "tags", text: (input.tags ?? []).join(" ") },
		]);
		if (secretRefusal !== undefined) return secretRefusal;
		let stored: Awaited<ReturnType<typeof memory.rememberGuarded>>;
		try {
			stored = await memory.rememberGuarded({
				text: input.text,
				entity,
				...defined({ tags: input.tags }),
			});
		} catch (error) {
			// Nothing was stored. Saying which is the whole point: a model told
			// only "error" either drops the fact or writes it again five times.
			if (!isEmbedderFailure(error)) throw error;
			return `Not stored. ${EMBEDDER_UNREACHABLE}`;
		}
		this.noteWrote();

		if (stored.status === "blocked") {
			await this.stumbled("duplicate_refused");
			// The refusal names WHAT it collided with, not just the ids. A bare
			// list of numbers leaves the model with two guesses - rephrase, or
			// revise - and no way to tell which, so it usually just sends the
			// same call again.
			const held = await this.describeNeighbours(memory, stored.similar);
			const lines = held.map(
				(hit) =>
					`  [f${hit.id}] ${hit.text}${hit.tags.length === 0 ? "" : ` #${hit.tags.join(" #")}`}`,
			);
			return [
				`Not stored: ${this.label(scope)} already holds this, in these words:`,
				...lines,
				`If yours REPLACES one of them, call longterm_revise with its id and scope: "${scope}". ` +
					"If both are true, rephrase yours so the difference is explicit. If yours " +
					"adds nothing, it is already remembered - move on. Do not send this call " +
					"again unchanged.",
			].join("\n");
		}
		// The model gets the whole account; what the terminal prints is decided
		// in `index.ts` from `memory.output`. See `memory/write-report.ts`.
		const write: WriteReport = {
			id: stored.id ?? -1,
			text: input.text,
			scope,
			scopeLabel: this.label(scope),
			entity,
			tags: input.tags ?? [],
			vocabulary: await this.vocabulary(memory),
			// `checked: false` means the engine had no candidate set and wrote
			// without any duplicate check. Every write from here names an
			// entity, so this can only happen if that stops being true - and
			// the last time it was not true, one sentence was stored six times
			// before anybody noticed. Reported rather than swallowed for
			// exactly that reason: silence is what made it expensive.
			notes: stored.checked
				? suggestions
				: [
						...suggestions,
						"NOTE: this was stored without a duplicate check, so the memory may now " +
							"hold it twice. Ask the memory for it before storing anything like it " +
							"again, and tell the user this extension has a defect worth reporting.",
					],
		};
		this.record({ kind: "write", write });
		return modelReport(write);
	}

	/**
	 * How this entity's facts are already tagged.
	 *
	 * The question this answers is "which tag does this memory use for this
	 * kind of thing", asked at the moment the model is choosing one - because
	 * a tag filter matches exactly, so a second spelling splits the pile in
	 * half and neither half ever answers the other's question.
	 *
	 * What it deliberately is NOT is a list of near-duplicates. A recall always
	 * returns its best match, however weak: it has no threshold below which it
	 * says "nothing is close". The similarity DETECTOR does - it compares term
	 * sets and cosines against fixed thresholds and answers with nothing when
	 * nothing is near. pi-telegram-manager paid for that distinction with a
	 * lost fact: a recall's nearest neighbour at a fused score of 0.02 was read
	 * as a duplicate of a completely unrelated statement. So the only thing
	 * ever reported here as "already held" is what the engine itself refused a
	 * write over, and that lives on the blocked path.
	 */
	private async vocabulary(memory: ReadableMemory): Promise<string[]> {
		const page = await memory.listTags({ limit: 8 });
		return page.items
			.filter((tag) => tag.count > 0)
			.map((tag) => `${tag.name}(${tag.count})`);
	}

	/**
	 * Turns the engine's id/score pairs into something readable.
	 *
	 * The engine reports which facts it considered close, but only by number.
	 * A number tells the model nothing it can act on; the sentence and its tags
	 * tell it what it nearly repeated and which tag this memory already uses
	 * for that kind of thing. Two or three lookups, on a write.
	 */
	private async describeNeighbours(
		memory: ReadableMemory,
		similar: readonly { id: number; score: number }[],
	): Promise<Neighbour[]> {
		const described: Neighbour[] = [];
		for (const hit of similar.slice(0, 3)) {
			const card = await memory.get(hit.id);
			if (card === null) continue;
			described.push({
				id: hit.id,
				score: hit.score,
				text: card.text,
				tags: card.tags,
			});
		}
		return described;
	}

	/**
	 * Physically reclaims what has been forgotten, in every open memory.
	 *
	 * `forget` sets a tombstone and returns; the bytes go at the next
	 * maintenance, and nothing calls that on its own - plugmem's
	 * `maintain_every_forgets` is off by default and the engine never schedules
	 * one. So without this, a memory only ever grows: measured, a thousand facts
	 * with five hundred forgotten stayed at 1278 KB until a compaction took it
	 * to 674 KB.
	 *
	 * Called at the end of the idle pass, which is the right moment for the same
	 * reason the pass runs then: the work is O(database), and the pass is what
	 * produced the tombstones in the first place. Failures are swallowed - a
	 * memory that did not shrink is a memory that works.
	 */
	async maintain(): Promise<void> {
		for (const memory of [this.deps.project, this.deps.common]) {
			if (memory === undefined) continue;
			try {
				await memory.maintain();
				await memory.checkpoint();
			} catch {
				// Reclaiming space is never worth failing a pass over.
			}
		}
	}

	/**
	 * Notes what a call did, for whoever renders the terminal.
	 *
	 * Kept here rather than returned alongside the string because the tool
	 * contract is "a tool answers with text" - and the text is the model's, not
	 * the screen's. Public because the note tools reach their store directly
	 * rather than through a method here, and a report they cannot file is a
	 * terminal line that falls back to the model's wording.
	 */
	record(report: ToolReport): void {
		this.lastReport = report;
	}

	/** The last report, once. */
	takeLastReport(): ToolReport | undefined {
		const report = this.lastReport;
		this.lastReport = undefined;
		return report;
	}

	async revise(
		id: number,
		text: string,
		scope: Scope | undefined,
		tags?: string[],
	): Promise<string> {
		if (scope === undefined || scope === "both") {
			await this.stumbled("id_without_scope");
			return whichMemory("revise", id);
		}
		const memory = this.writableScope(scope);
		if (memory === undefined) return this.noProjectMessage();
		const secretRefusal = await this.secretRefusal([
			{ label: "fact", text },
			{ label: "tags", text: (tags ?? []).join(" ") },
		]);
		if (secretRefusal !== undefined) return secretRefusal;
		const current = await memory.get(id);
		if (current === null) return this.missing(id, scope, "revise");
		// A standing rule can be made longer by a revision as easily as by a
		// write, and the block it has to fit in is the same one.
		if (isStandingRule(tags ?? current.tags)) {
			const overflow = await this.wouldOverflowAlways(text, { id, scope });
			if (overflow !== undefined) return overflow;
		}
		const stored = await memory.revise(id, { text, ...defined({ tags }) });
		this.noteWrote();
		this.record({
			kind: "revise",
			scopeLabel: this.label(scope),
			oldId: id,
			newId: stored.id ?? id,
			before: current.text,
			after: text,
		});
		return `Revised [f${id}] into [f${stored.id}] in ${this.label(scope)}. The old version is kept as history.`;
	}

	/**
	 * Forgets one fact or several.
	 *
	 * Several, because the job that produces a list of ids - clearing
	 * duplicates - is the job this is for, and one-at-a-time made it
	 * unreachable in practice. Watched live: asked to drop four duplicates,
	 * the model announced "all of them in parallel" and then emitted a single
	 * call, six times over, because a single call was all the tool offered.
	 */
	async forget(
		ids: readonly number[],
		scope: Scope | undefined,
	): Promise<string> {
		if (ids.length === 0) return "No ids given: pass the number inside [fN].";
		if (scope === undefined || scope === "both") {
			await this.stumbled("id_without_scope");
			return whichMemory("forget", ids[0] ?? 0);
		}
		const memory = this.writableScope(scope);
		if (memory === undefined) return this.noProjectMessage();

		// Read BEFORE closing anything, because afterwards there is nothing to
		// read: a forgotten fact leaves recall at once. This is the only moment
		// at which anyone - the person watching or the model that asked - can
		// still be told what it was that went away.
		const texts: string[] = [];
		for (const id of ids) texts.push((await memory.get(id))?.text ?? "");

		// One write for the whole list. `forgetMany` answers in the order it
		// was asked, which is what lets the texts above line back up with it.
		const closed = await memory.forgetMany(ids);
		const dropped: FactLine[] = [];
		const absent: number[] = [];
		ids.forEach((id, at) => {
			if (closed[at] === true) dropped.push({ id, text: texts[at] ?? "" });
			else absent.push(id);
		});
		if (dropped.length > 0) {
			this.noteWrote();
			for (const { id } of dropped) {
				this.forgotten.add(`${scope}:${id}`);
				this.repeatGuard.noteSuccess(`forget:${scope}:${id}`);
			}
		}
		this.record({
			kind: "forget",
			scopeLabel: this.label(scope),
			forgot: dropped,
			absent,
		});

		const said: string[] = [];
		if (dropped.length > 0) {
			// The model is told WHAT it dropped, not only which numbers. It had
			// the text in the memory block when it chose the ids, but that block
			// is rebuilt every turn and never persists, so by its next reply the
			// only lasting record of this deletion is the sentence below. A
			// deletion it cannot describe is one it cannot notice was wrong.
			said.push(
				`Forgot ${dropped.length} fact${dropped.length === 1 ? "" : "s"} from ${this.label(scope)}:`,
				...dropped.map(({ id, text }) => `  [f${id}] ${snip(text)}`),
			);
		}
		for (const id of absent) {
			// The runtime is the only thing that can see a repeat: from inside
			// the model, the third identical attempt looks exactly like the
			// first, because everything it can read is unchanged.
			const repeated = this.repeatGuard.noteFailure(`forget:${scope}:${id}`);
			said.push(repeated ?? (await this.missing(id, scope, "forget")));
		}
		return said.join("\n");
	}

	/**
	 * "Not found" - plus where it actually is.
	 *
	 * The bare version of this message cost a live session ten consecutive
	 * failed calls: the model read `[f3]` in the shared memory, called forget
	 * without a scope, was told "fact 3 not found", and had no way to learn that
	 * the fact it wanted was one word away. A dead end that names the next step
	 * is not a dead end, so this looks in the other memory before answering.
	 */
	private async missing(
		id: number,
		scope: Exclude<Scope, "both">,
		verb: "revise" | "forget",
	): Promise<string> {
		const other: Exclude<Scope, "both"> = scope === "user" ? "project" : "user";
		const elsewhere = this.readableScope(other);
		const found = elsewhere === undefined ? null : await elsewhere.get(id);
		const head = `There is no live fact [f${id}] in ${this.label(scope)}.`;
		if (this.forgotten.has(`${scope}:${id}`)) {
			// The precise thing that went wrong last time, said precisely. "It
			// may have been forgotten already" is true and useless: the model
			// read it, looked at a block that still listed the fact, and
			// concluded its own tool did nothing.
			return (
				`${head} YOU forgot it earlier in this session and it worked - this is the ` +
				"same fact, already gone. Nothing here needs doing; move on to the next " +
				"thing the user asked for."
			);
		}
		if (found === null) {
			await this.stumbled("id_not_there");
			return (
				`${head} It was never there, or it was forgotten in an earlier session. ` +
				"Do not repeat this call: the answer will not change. If you are working " +
				"from a list of ids, go on to the next one."
			);
		}
		await this.stumbled("id_in_the_other_memory");
		return (
			`${head} The other memory (${this.label(other)}) does have [f${id}]: ` +
			`"${found.text}". If that is the one you meant, call longterm_${verb} again ` +
			`with scope: "${other}".`
		);
	}

	/**
	 * The tags in use, in one memory or in both.
	 *
	 * `"both"` reads both, and that has to be said because it did not always:
	 * this used to resolve the scope the way a WRITE does, where "both" is not a
	 * destination and everything that is not "user" is the project. A read has
	 * no such excuse, and the bug was invisible in the worst way - a memory full
	 * of tags answered "No tags yet." because the other one was empty, and the
	 * model went on to invent tags beside the ones already in use.
	 *
	 * A cursor names a page of ONE catalogue, so it is only accepted with one
	 * scope. Applying it to two would page them in lockstep and skip whatever
	 * the shorter one had left.
	 */
	async listTags(
		scope: Scope = "project",
		prefix?: string,
		cursor?: string,
	): Promise<string> {
		const scopes = this.readableScopes(scope);
		if (scopes.length === 0) return this.noProjectMessage();
		if (cursor !== undefined && scopes.length > 1) {
			return (
				'A cursor belongs to one memory\'s tag list, so it needs one scope: call again with scope: "project" ' +
				'or scope: "user" and the same cursor.'
			);
		}

		const sections: string[] = [];
		let count = 0;
		let more = false;
		for (const [, label, memory] of scopes) {
			const page = await memory.listTags(defined({ prefix, cursor }));
			count += page.items.length;
			more ||= page.nextCursor !== undefined;
			const listed =
				page.items.length === 0
					? "no tags yet"
					: page.items.map((tag) => `${tag.name}(${tag.count})`).join(" ");
			const tail =
				page.nextCursor === undefined
					? ""
					: `\nMore follow; pass cursor="${page.nextCursor}" with this scope to continue.`;
			// One memory answers bare, the way it always has. Two are labelled,
			// because the same tag in both is two piles of facts, not one.
			sections.push(
				scopes.length === 1 ? `${listed}${tail}` : `${label}: ${listed}${tail}`,
			);
		}
		this.record({
			kind: "tags",
			scopeLabel: this.label(scope),
			count,
			more,
		});
		if (count === 0) return "No tags yet.";
		return sections.join("\n");
	}

	async link(
		src: string,
		rel: string,
		dst: string,
		scope: Scope = "project",
	): Promise<string> {
		const memory = this.writableScope(scope);
		if (memory === undefined) return this.noProjectMessage();
		await memory.link({ src, rel, dst });
		this.record({
			kind: "link",
			undone: false,
			scopeLabel: this.label(scope),
			src,
			rel,
			dst,
		});
		return `Linked ${src} -${rel}-> ${dst}.`;
	}

	async unlink(
		src: string,
		rel: string,
		dst: string,
		scope: Scope = "project",
	): Promise<string> {
		const memory = this.writableScope(scope);
		if (memory === undefined) return this.noProjectMessage();
		const removed = await memory.unlink({ src, rel, dst });
		if (!removed) return "There was no such link.";
		this.record({
			kind: "link",
			undone: true,
			scopeLabel: this.label(scope),
			src,
			rel,
			dst,
		});
		return `Unlinked ${src} -${rel}-> ${dst}.`;
	}

	// -- notes ----------------------------------------------------------------

	notes(scope: Scope = "project"): NoteStore | undefined {
		return scope === "user" ? this.deps.notesCommon : this.deps.notesProject;
	}

	/** The block a consolidation pass works from. */
	async consolidationView(query: string): Promise<string> {
		const memory = this.readableScope("project") ?? this.deps.common;
		const found = await memory.recall({
			query,
			tokenBudget: this.deps.settings.memory.recallTokenBudget,
		});
		return consolidationBlock(found.rendered);
	}

	/**
	 * A window of the oldest facts still stored, for the review pass.
	 *
	 * Oldest by id, because ids are assigned in order and never reused - so id
	 * order IS the order things were learned, with no timestamp to compare and
	 * no sort to run. `from` is the first id to consider, INCLUSIVE: the walk
	 * stores the id after the last one it showed, so a window that ended at
	 * [f4] leaves 5 behind. Inclusive rather than exclusive because there is no
	 * id below zero to mean "nothing shown yet" - with `> from`, [f0] would
	 * never be reviewed at all.
	 *
	 * Why a window at all: the pass reads the TRANSCRIPT, so it only ever sees
	 * what was just discussed. A fact from six months ago that nobody has
	 * mentioned since is never reconsidered - not because it is still true, but
	 * because nothing ever puts it in front of anyone.
	 */
	async oldestFacts(
		scope: Exclude<Scope, "both">,
		from: number,
		limit: number,
	): Promise<{ id: number; text: string; tags: string[] }[]> {
		const memory = this.readableScope(scope);
		if (memory === undefined || limit <= 0) return [];
		// A window, asked for as a window. Reading everything and slicing twelve
		// off the front costs 23 ms and ten thousand throwaway objects at ten
		// thousand facts, against 0.3 ms for the page that holds them.
		return (await memory.scan({ from, limit })).map((fact) => ({
			id: fact.id,
			text: fact.text,
			tags: fact.tags,
		}));
	}

	/**
	 * Facts for the terminal inspector.
	 *
	 * Empty search is deliberately an enumeration. A non-empty search uses the
	 * same hybrid recall as the agent, while tags remain a filter over that
	 * source. The UI asks for a small page, so typing never walks the database.
	 */
	async inspectFacts(
		query: string,
		tags: readonly string[],
		scope: Scope = "both",
		limit = 40,
	): Promise<InspectFact[]> {
		const wanted = [...tags].filter((tag) => tag !== "");
		const rows: InspectFact[] = [];
		for (const [factScope, label, memory] of this.readableScopes(scope)) {
			const ids =
				query.trim() === ""
					? (await memory.scan({ tags: wanted, limit })).map((fact) => fact.id)
					: (
							await memory.recall({
								query,
								tags: wanted,
								k: limit,
								tokenBudget: this.deps.settings.memory.recallTokenBudget,
							})
						).facts.map((fact) => fact.id);
			for (const id of ids) {
				const card = await memory.get(id);
				if (card !== null) rows.push({ scope: factScope, label, card });
			}
		}
		return rows;
	}

	/** Load the current graph once when the inspector opens, not on every keystroke. */
	async inspectEdges(scope: Scope = "both"): Promise<InspectEdge[]> {
		const edges: InspectEdge[] = [];
		for (const [factScope, label, memory] of this.readableScopes(scope)) {
			for (const edge of (await memory.listEdges?.()) ?? [])
				edges.push({ ...edge, scope: factScope, label });
		}
		return edges;
	}

	/** The memories a review can walk, project first. */
	reviewableScopes(): Exclude<Scope, "both">[] {
		return this.readableScopes().map(([scope]) => scope);
	}

	/** How many facts one memory holds that a recall could return. */
	async liveFactCount(scope: Exclude<Scope, "both">): Promise<number> {
		const memory = this.readableScope(scope);
		if (memory === undefined) return 0;
		return liveFacts(await memory.stats());
	}

	// -- scope plumbing -------------------------------------------------------

	private label(scope: Scope): string {
		// Only a read can be about both; every write rejects it before here.
		if (scope === "both") return "both memories";
		if (scope === "user") return "your memory about the user";
		return this.deps.projectName === undefined
			? "this project"
			: `this project (${this.deps.projectName})`;
	}

	/**
	 * The entity a fact belongs to when the model did not name one.
	 *
	 * Not cosmetic, and not optional. The duplicate guard compares a new fact
	 * against the recent facts *of the entity it names*; a fact that names none
	 * is compared against nothing, so `rememberGuarded` degenerates into
	 * `remember` and stores the same sentence as many times as it is sent.
	 * Measured against the engine: six identical guarded writes with no entity
	 * produced six facts, the same six with `entity: "user"` produced one and
	 * five refusals.
	 *
	 * So every fact lands under an entity, and the default is the one from the
	 * taxonomy - built by the same functions the router uses, not by a literal
	 * spelled again here. Everything in a database shares one graph, and two
	 * subsystems spelling the same entity two ways silently split its facts in
	 * half; that is the whole reason those names live in one module.
	 */
	private defaultEntity(scope: Scope): string {
		if (scope === "user") return USER_ENTITY;
		return this.deps.projectId === undefined
			? PROJECT_TAG
			: projectEntity(this.deps.projectId);
	}

	/**
	 * One memory, named exactly.
	 *
	 * `"both"` is deliberately not accepted: it is not a memory, and the last
	 * time this took it, it silently answered with the project's - see
	 * {@link listTags}. Anything that means "both" goes through
	 * {@link readableScopes}, which returns them all and makes the caller say
	 * which is which.
	 */
	private readableScope(
		scope: Exclude<Scope, "both">,
	): ReadableMemory | undefined {
		return scope === "user" ? this.deps.common : this.deps.project;
	}

	private writableScope(scope: Scope): WritableMemory | undefined {
		if (scope === "both") return undefined;
		return scope === "user" ? this.deps.common : this.deps.project;
	}

	/**
	 * Scope/label/memory triples, project first, skipping what is not open.
	 *
	 * The scope travels with the label because everything rendered from one of
	 * these carries fact ids, and an id without its memory named is an id that
	 * addresses the wrong fact.
	 */
	private readableScopes(
		scope: Scope = "both",
	): [Exclude<Scope, "both">, string, ReadableMemory][] {
		const pairs: [Exclude<Scope, "both">, string, ReadableMemory][] = [];
		if (scope !== "user" && this.deps.project !== undefined) {
			pairs.push(["project", this.label("project"), this.deps.project]);
		}
		if (scope !== "project")
			pairs.push(["user", this.label("user"), this.deps.common]);
		return pairs;
	}

	/**
	 * What to say when this folder has no memory of its own.
	 *
	 * Naming the consequence rather than the condition. "Not a project" is a
	 * statement about markers, which tells the model nothing it can act on -
	 * whereas "anything you store here follows the user into every other
	 * project" is the actual cost, and the command that fixes it is one line
	 * away.
	 */
	private noProjectMessage(): string {
		return (
			"This folder has no memory of its own, so there is nothing to read or write " +
			'as scope: "project". A fact stored as scope: "user" goes to the shared memory ' +
			"and is shown in EVERY other project, so put only what is true about the person " +
			"there. If this folder should have a memory of its own, the user can run " +
			"/longterm-new - you cannot."
		);
	}

	/**
	 * Warns about a tag that looks like an existing one, without changing it.
	 *
	 * The tag is stored exactly as written. Two words that look alike sometimes
	 * mean different things, and only the model has the context to tell.
	 */
	private async tagSuggestions(
		memory: ReadableMemory,
		tags: readonly string[],
	): Promise<string[]> {
		if (tags.length === 0) return [];
		const vocabulary = (await memory.listTags({ limit: 256 })).items.map(
			(tag) => tag.name,
		);
		const notes: string[] = [];
		for (const tag of tags) {
			const suggestion = suggestTag(tag, vocabulary);
			if (suggestion !== undefined) notes.push(suggestionText(suggestion));
		}
		return notes;
	}
}

/**
 * The answer to an id with no memory named.
 *
 * Deliberately not a default. Guessing "project" is what produced the failure
 * this whole path exists for, and guessing wrong on `forget` deletes the wrong
 * fact rather than merely failing.
 */
const whichMemory = (verb: string, id: number): string =>
	`Which memory is [f${id}] in? The two number their facts separately, so [f${id}] ` +
	"exists in both and means two different things. Look at the heading above the " +
	`line you read it under, then call longterm_${verb} again with scope: "project" ` +
	'(this codebase) or scope: "user" (the shared memory about the person).';

/**
 * The answer to a write addressed at both memories.
 *
 * It used to be "this directory is not a project", which is a lie whenever the
 * directory IS one - and unactionable either way, since it names neither the
 * real reason nor the next move. `both` is a reading scope; a fact lives in one
 * memory, because two copies drift apart and revising one leaves the other
 * lying.
 */
const BOTH_IS_A_READING_SCOPE =
	'scope: "both" reads from both memories; it cannot write to them. A fact ' +
	"lives in exactly one: two copies drift apart, and revising one leaves the " +
	'other lying. Choose scope: "project" (about this codebase) or scope: "user" ' +
	"(about the person, true in every project) and call again.";

/**
 * Whether a write is a standing rule rather than a fact.
 *
 * Both tags, not either. `instruction` alone is a fact about how to work that
 * the model finds by asking; only `always` puts it in the head of every request,
 * and only that costs context nobody chose to spend.
 */
function isStandingRule(tags: readonly string[] | undefined): boolean {
	return tags?.includes(INSTRUCTION_TAG) === true && tags.includes(ALWAYS_TAG);
}

/**
 * Said when the embedding service is down and this memory refuses rather than
 * carries on without it.
 *
 * It names the outage, the fact that nothing is damaged and the one-line
 * setting that would have avoided it. The last part is for the USER, who is the
 * only one who can change it, and the model is told to pass it on rather than
 * act on it - there is nothing here it can fix by retrying.
 */
const EMBEDDER_UNREACHABLE =
	"The embedding service is not answering, so this memory refused the call rather than " +
	"work without meaning-based search. Nothing is damaged and nothing was lost. Do not " +
	"retry it this turn - carry on with what you know, and tell the user their embedding " +
	'service looks down, and that setting on_error = "degrade" in plugmem\'s config.toml ' +
	"would let the memory keep working through an outage like this.";

const MISMATCHED_PROJECT = (name: string): string =>
	`Project "${name}" was last written with a different embedding model, and its ` +
	"vectors could not be rebuilt just now - most likely because a session is open " +
	"in it. Ask again later, or run /longterm-reembed.";

const ASK_HINT =
	"You have answered a few times now without looking anything up. If any of it rested " +
	"on a guess about this project or this user, longterm_ask can check - it holds what " +
	"was decided in earlier sessions, including the reasons.";
