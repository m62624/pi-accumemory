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
import type { Turn } from "../memory/transcript-view.ts";
import {
	modelReport,
	type Neighbour,
	type WriteReport,
} from "../memory/write-report.ts";
import type { NoteStore } from "../notes/store.ts";
import { PROJECT_TAG, projectEntity, USER_ENTITY } from "../router/entities.ts";
import type { ProjectRouter } from "../router/router.ts";
import type { Settings } from "../settings/defaults.ts";
import { isVectorSpaceMismatch } from "../storage/errors.ts";
import type { ReadableMemory, WritableMemory } from "../storage/port.ts";
import { defined } from "../tools/args.ts";
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
}

export interface AskInput {
	question: string;
	scope?: Scope;
	tags?: string[];
	k?: number;
	graphDepth?: number;
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

	/** The last computed block, held between refresh events so the tail is stable. */
	private block = "";
	private manifestPending: boolean;
	private manifestShown = false;
	/** Detail of the last successful write, for the terminal renderer. */
	private lastWrite: WriteReport | undefined;
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
		this.manifestPending = deps.settings.memory.manifest;
	}

	// -- lifecycle notes ----------------------------------------------------

	noteUserMessage(): void {
		this.refresh.noteUserMessage();
		this.nudge.noteMessage();
		// A new request is a new run: the same question may be fair again.
		this.askGuard.reset();
		this.repeatGuard.reset();
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
			scopes.push({ label, facts: stats.facts, tags: tags.items });
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
		const rules: string[] = [];
		for (const [, , memory] of this.readableScopes()) {
			for (const fact of await memory.scan({
				tags: [INSTRUCTION_TAG, ALWAYS_TAG],
			})) {
				rules.push(fact.text);
			}
		}
		return alwaysBlock(rules, this.deps.settings.memory.instructions);
	}

	// -- pull ----------------------------------------------------------------

	async ask(input: AskInput): Promise<string> {
		const scope = input.scope ?? "project";
		const repeat = this.askGuard.check(input.question);
		this.askGuard.record(input.question);

		const sections: string[] = [];
		for (const [factScope, label, memory] of this.readableScopes(scope)) {
			const found = await memory.recall({
				query: input.question,
				tokenBudget: this.deps.settings.memory.recallTokenBudget,
				...defined({
					tags: input.tags,
					k: input.k,
					graphDepth: input.graphDepth,
				}),
			});
			// Two databases are answered as two labelled sections, never fused
			// into one ranking. plugmem's own measurements put routing ahead of
			// merging by a wide margin, and a merged list hides which memory an
			// answer came from - which is exactly what the reader needs to know.
			sections.push(
				found.rendered.trim() === ""
					? `${label}: nothing on this.`
					: `${label} - these ids are scope: "${factScope}":\n${found.rendered.trim()}`,
			);
		}
		if (sections.length === 0) return this.noProjectMessage();

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
		if (answer !== undefined) return this.render(project.name, answer);

		// The vectors in that project are from a different embedder, and a
		// read-only handle cannot rebuild them. Repair it with a brief writer,
		// then ask again - once.
		const repair = this.deps.repairProject;
		if (repair === undefined) return MISMATCHED_PROJECT(project.name);
		const failure = await repair(project.projectId);
		if (failure !== undefined) return `Project "${project.name}": ${failure}`;

		const retried = await this.readProject(open, project.projectId, question);
		return retried === undefined
			? MISMATCHED_PROJECT(project.name)
			: this.render(project.name, retried);
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

	async remember(input: RememberInputForModel): Promise<string> {
		const scope = input.scope ?? "project";
		if (scope === "both") return BOTH_IS_A_READING_SCOPE;
		const memory = this.writableScope(scope);
		if (memory === undefined) return this.noProjectMessage();

		const suggestions = await this.tagSuggestions(memory, input.tags ?? []);
		const entity = input.entity ?? this.defaultEntity(scope);
		const stored = await memory.rememberGuarded({
			text: input.text,
			entity,
			...defined({ tags: input.tags }),
		});
		this.noteWrote();

		if (stored.status === "blocked") {
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
		// in `index.ts` from `memory.writeOutput`. See `memory/write-report.ts`.
		this.lastWrite = {
			id: stored.id ?? -1,
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
		return modelReport(this.lastWrite);
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
	 * The last write, in full, for whoever renders the terminal.
	 *
	 * Kept here rather than returned alongside the string because the tool
	 * contract is "a tool answers with text" - and the text is the model's, not
	 * the screen's.
	 */
	takeLastWrite(): WriteReport | undefined {
		const report = this.lastWrite;
		this.lastWrite = undefined;
		return report;
	}

	async revise(
		id: number,
		text: string,
		scope: Scope | undefined,
		tags?: string[],
	): Promise<string> {
		if (scope === undefined || scope === "both")
			return whichMemory("revise", id);
		const memory = this.writableScope(scope);
		if (memory === undefined) return this.noProjectMessage();
		if ((await memory.get(id)) === null)
			return this.missing(id, scope, "revise");
		const stored = await memory.revise(id, { text, ...defined({ tags }) });
		this.noteWrote();
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
		if (scope === undefined || scope === "both")
			return whichMemory("forget", ids[0] ?? 0);
		const memory = this.writableScope(scope);
		if (memory === undefined) return this.noProjectMessage();

		const dropped: number[] = [];
		const absent: number[] = [];
		for (const id of ids) {
			if (await memory.forget(id)) dropped.push(id);
			else absent.push(id);
		}
		if (dropped.length > 0) {
			this.noteWrote();
			for (const id of dropped) {
				this.forgotten.add(`${scope}:${id}`);
				this.repeatGuard.noteSuccess(`forget:${scope}:${id}`);
			}
		}

		const said: string[] = [];
		if (dropped.length > 0) {
			said.push(
				`Forgot ${dropped.map((id) => `[f${id}]`).join(", ")} from ${this.label(scope)}.`,
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
			return (
				`${head} It was never there, or it was forgotten in an earlier session. ` +
				"Do not repeat this call: the answer will not change. If you are working " +
				"from a list of ids, go on to the next one."
			);
		}
		return (
			`${head} The other memory (${this.label(other)}) does have [f${id}]: ` +
			`"${found.text}". If that is the one you meant, call longterm_${verb} again ` +
			`with scope: "${other}".`
		);
	}

	async listTags(
		scope: Scope = "project",
		prefix?: string,
		cursor?: string,
	): Promise<string> {
		const memory = this.readableScope(scope);
		if (memory === undefined) return this.noProjectMessage();
		const page = await memory.listTags(defined({ prefix, cursor }));
		if (page.items.length === 0) return "No tags yet.";
		const listed = page.items
			.map((tag) => `${tag.name}(${tag.count})`)
			.join(" ");
		return page.nextCursor === undefined
			? listed
			: `${listed}\n\nMore tags follow; pass cursor="${page.nextCursor}" to continue.`;
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
		return removed
			? `Unlinked ${src} -${rel}-> ${dst}.`
			: "There was no such link.";
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

	// -- scope plumbing -------------------------------------------------------

	private label(scope: Scope): string {
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

	private readableScope(scope: Scope): ReadableMemory | undefined {
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

	private noProjectMessage(): string {
		return (
			"This directory is not a project, so there is no project memory here - only the " +
			'shared memory about the user. Use scope: "user" for facts about them.'
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

const MISMATCHED_PROJECT = (name: string): string =>
	`Project "${name}" was last written with a different embedding model, and its ` +
	"vectors could not be rebuilt just now - most likely because a session is open " +
	"in it. Ask again later, or run /longterm-reembed.";

const ASK_HINT =
	"You have answered a few times now without looking anything up. If any of it rested " +
	"on a guess about this project or this user, longterm_ask can check - it holds what " +
	"was decided in earlier sessions, including the reasons.";
