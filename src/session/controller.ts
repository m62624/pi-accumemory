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
	consolidationBlock,
	dropVisible,
	type ManifestScope,
	memoryBlock,
	memoryManifest,
} from "../memory/block.ts";
import { WriteNudge } from "../memory/nudge.ts";
import { progressQuery, recallQuery } from "../memory/query.ts";
import { RefreshPolicy } from "../memory/refresh.ts";
import { suggestionText, suggestTag } from "../memory/tag-suggest.ts";
import type { Turn } from "../memory/transcript-view.ts";
import type { NoteStore } from "../notes/store.ts";
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
	private readonly now: () => Date;

	/** The last computed block, held between refresh events so the tail is stable. */
	private block = "";
	private manifestPending: boolean;
	private manifestShown = false;

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

		const sections: string[] = [];
		for (const [label, memory] of this.readableScopes()) {
			const found = await memory.recall({
				query,
				tokenBudget: recallTokenBudget,
				...defined({
					k: recallK > 0 ? recallK : undefined,
					graphDepth: graphDepth ?? undefined,
				}),
			});
			const visible = dropVisible(found.rendered, turns);
			const block = memoryBlock(visible, label);
			if (block !== "") sections.push(block);
		}
		return sections.join("\n\n");
	}

	private async manifest(): Promise<string> {
		const scopes: ManifestScope[] = [];
		for (const [label, memory] of this.readableScopes()) {
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
		for (const [, memory] of this.readableScopes()) {
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
		for (const [label, memory] of this.readableScopes(scope)) {
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
					: `${label}:\n${found.rendered.trim()}`,
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

	async remember(input: RememberInputForModel): Promise<string> {
		const scope = input.scope ?? "project";
		const memory = this.writableScope(scope);
		if (memory === undefined) return this.noProjectMessage();

		const suggestions = await this.tagSuggestions(memory, input.tags ?? []);
		const stored = await memory.rememberGuarded({
			text: input.text,
			...defined({ entity: input.entity, tags: input.tags }),
		});
		this.nudge.noteWrite();

		if (stored.status === "blocked") {
			const ids = stored.similar.map((hit) => `[f${hit.id}]`).join(", ");
			return (
				`Not stored: the memory already holds something that says nearly the same thing (${ids}). ` +
				"If yours replaces it, use longterm_revise with that id; if both are true, rephrase " +
				"so the difference is explicit."
			);
		}
		return [
			`Stored [f${stored.id}] in ${this.label(scope)}.`,
			...suggestions,
		].join("\n");
	}

	async revise(
		id: number,
		text: string,
		scope: Scope = "project",
		tags?: string[],
	): Promise<string> {
		const memory = this.writableScope(scope);
		if (memory === undefined) return this.noProjectMessage();
		const stored = await memory.revise(id, { text, ...defined({ tags }) });
		this.nudge.noteWrite();
		return `Revised [f${id}] into [f${stored.id}]. The old version is kept as history.`;
	}

	async forget(id: number, scope: Scope = "project"): Promise<string> {
		const memory = this.writableScope(scope);
		if (memory === undefined) return this.noProjectMessage();
		const dropped = await memory.forget(id);
		this.nudge.noteWrite();
		return dropped
			? `Forgot [f${id}].`
			: `There is no live fact [f${id}] in ${this.label(scope)}.`;
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

	private readableScope(scope: Scope): ReadableMemory | undefined {
		return scope === "user" ? this.deps.common : this.deps.project;
	}

	private writableScope(scope: Scope): WritableMemory | undefined {
		if (scope === "both") return undefined;
		return scope === "user" ? this.deps.common : this.deps.project;
	}

	/** Label/memory pairs, project first, skipping what is not open. */
	private readableScopes(scope: Scope = "both"): [string, ReadableMemory][] {
		const pairs: [string, ReadableMemory][] = [];
		if (scope !== "user" && this.deps.project !== undefined) {
			pairs.push([this.label("project"), this.deps.project]);
		}
		if (scope !== "project") pairs.push([this.label("user"), this.deps.common]);
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

const MISMATCHED_PROJECT = (name: string): string =>
	`Project "${name}" was last written with a different embedding model, and its ` +
	"vectors could not be rebuilt just now - most likely because a session is open " +
	"in it. Ask again later, or run /longterm-reembed.";

const ASK_HINT =
	"You have answered a few times now without looking anything up. If any of it rested " +
	"on a guess about this project or this user, longterm_ask can check - it holds what " +
	"was decided in earlier sessions, including the reasons.";
