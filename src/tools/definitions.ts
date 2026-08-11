/**
 * The tools, and above all their names.
 *
 * **Everything here is prefixed `longterm_`, and that is not cosmetic.**
 * pi-telegram-manager registers `manager_remember` / `manager_recall` /
 * `manager_revise` / `manager_forget` / `manager_link` - the same verbs, over
 * the same engine, about a person in a Telegram chat. pi-planner takes
 * `planner_*`. Both can be installed beside this one. A generic `memory_*`
 * prefix would put two plausible `remember` tools in front of a model with
 * nothing but the name to tell them apart, and the wrong choice files a fact
 * where nobody will look for it.
 *
 * So: `longterm_` says the timescale, every description opens by saying whose
 * memory this is, and the two that share a verb with the Telegram tools say
 * outright that they are not about a conversation partner.
 *
 * The ORDER is fixed too. Tool schemas are rendered into the head of the
 * prompt, and the same tools in a different order are different bytes - a cache
 * miss on the entire prompt.
 */

import type { MemoryController } from "../session/controller.ts";
import {
	defined,
	num,
	numArray,
	optNum,
	optScope,
	optStr,
	scopeOf,
	str,
	strArray,
} from "./args.ts";

/** Every tool name, in the order they are registered. */
export const LONGTERM_TOOL_NAMES = [
	"longterm_ask",
	"longterm_ask_project",
	"longterm_projects",
	"longterm_remember",
	"longterm_revise",
	"longterm_forget",
	"longterm_tags",
	"longterm_link",
	"longterm_unlink",
	"longterm_note_create",
	"longterm_note_read",
	"longterm_note_update",
	"longterm_note_delete",
] as const;

export type LongtermToolName = (typeof LONGTERM_TOOL_NAMES)[number];

/** Opens every description, so the subject is never in doubt. */
const WHOSE =
	"Long-term memory of THIS PROJECT and of the user, persisted across sessions " +
	"and across projects.";

const SCOPE_PARAM = {
	type: "string",
	enum: ["project", "user", "both"],
	description:
		'"project" (default) for facts about this codebase, "user" for facts about the ' +
		"person that hold in every project. When unsure choose project: a wrong fact " +
		"there stays local, while a wrong fact in the user memory is read at the start " +
		"of every session of every project.",
} as const;

/**
 * The same choice, for the two tools that take a fact id.
 *
 * Separate because it is required rather than defaulted, and because the
 * reason is different: not "where should this go" but "which of the two
 * databases did you read that number in". They number facts independently, so
 * a defaulted scope silently addresses the wrong one - observed live, as ten
 * consecutive `fact 3 not found` replies while the fact sat in the other
 * memory. `both` is not offered: an id belongs to exactly one of them.
 */
const ID_SCOPE_PARAM = {
	type: "string",
	enum: ["project", "user"],
	description:
		'Which memory you read the [fN] in: "project" for the block headed with ' +
		'this project\'s name, "user" for the shared one about the person. The ' +
		"numbering is per memory, so the same [f3] exists in both and means two " +
		"different facts.",
} as const;

/** A minimal tool shape, so this module needs nothing from the SDK. */
export interface ToolSpec {
	name: LongtermToolName;
	label: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties?: boolean;
	};
	run(args: Record<string, unknown>): Promise<string>;
}

export function longtermTools(controller: MemoryController): ToolSpec[] {
	const specs: ToolSpec[] = [
		{
			name: "longterm_ask",
			label: "Long-term memory: ask",
			description:
				`${WHOSE} Ask it a question in your own words - "why is the cache disabled ` +
				'here", not "cache disabled". Use it BEFORE asking the user something (they ' +
				"may have answered in an earlier session), before changing code whose reason " +
				"you do not know, and before making a choice that may already be a convention " +
				"here. An empty answer is a real answer: it means nothing is stored on the " +
				"subject, so proceed - do not rephrase and retry. Each [fN] is a fact id you " +
				"can pass to longterm_revise or longterm_forget.",
			parameters: {
				type: "object",
				properties: {
					question: {
						type: "string",
						description: "A natural-language question, not search terms.",
					},
					scope: SCOPE_PARAM,
					tags: {
						type: "array",
						items: { type: "string" },
						description: "Restrict to facts carrying all of these tags.",
					},
					k: { type: "number", description: "Maximum facts to return." },
					graph_depth: {
						type: "number",
						description:
							"How far to follow entity links; 0 stays on the anchors.",
					},
				},
				required: ["question"],
			},
			run: async (args) =>
				controller.ask({
					question: str(args.question),
					...defined({
						scope: optScope(args.scope),
						tags: strArray(args.tags),
						k: optNum(args.k),
						graphDepth: optNum(args.graph_depth),
					}),
				}),
		},
		{
			name: "longterm_ask_project",
			label: "Long-term memory: ask another project",
			description:
				`${WHOSE} Ask the memory of a DIFFERENT project - "how did I do auth in ` +
				'api?". Useful when a task feels like something already solved elsewhere. ' +
				"Name the project exactly as longterm_projects lists it; an invented name " +
				"gets an error rather than a silently empty answer. This reads the other " +
				"project's memory without disturbing a session working in it.",
			parameters: {
				type: "object",
				properties: {
					project: {
						type: "string",
						description: "A name from longterm_projects.",
					},
					question: {
						type: "string",
						description: "A natural-language question.",
					},
				},
				required: ["project", "question"],
			},
			run: async (args) =>
				controller.askProject(str(args.project), str(args.question)),
		},
		{
			name: "longterm_projects",
			label: "Long-term memory: known projects",
			description:
				`${WHOSE} Lists the projects that have a memory, with where each one lives. ` +
				"Use it before longterm_ask_project rather than guessing a name.",
			parameters: { type: "object", properties: {} },
			run: async () => controller.projects(),
		},
		{
			name: "longterm_remember",
			label: "Long-term memory: remember",
			description:
				`${WHOSE} NOT about a conversation partner or a chat - this is what you keep ` +
				"about the codebase you are working in and about the person you work for. " +
				"Store something durable: a decision and its reason, a convention, a trap, a " +
				"standing preference, or a rule for your future self (tag it `instruction`, " +
				"and add `always` only if it must hold in every session regardless of topic). " +
				"ONE fact is ONE statement - split a compound sentence into separate calls. " +
				"Do not store what the transcript already shows: a file you read, a command " +
				"that ran, a summary of what you just did. NEVER store credentials, tokens, " +
				"keys or .env contents; store where they live instead. This refuses on its " +
				"own to write something the memory already holds, so there is no need to " +
				"search first.",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", description: "One durable statement." },
					scope: SCOPE_PARAM,
					tags: {
						type: "array",
						items: { type: "string" },
						description:
							"Free-form; check longterm_tags for one that already means it, " +
							"because tag filtering matches exactly.",
					},
					entity: {
						type: "string",
						description:
							"The subject this is about, when it has a natural one. Leave blank " +
							"for a general fact about the project.",
					},
				},
				required: ["text"],
			},
			run: async (args) =>
				controller.remember({
					text: str(args.text),
					...defined({
						scope: optScope(args.scope),
						tags: strArray(args.tags),
						entity: optStr(args.entity),
					}),
				}),
		},
		{
			name: "longterm_revise",
			label: "Long-term memory: revise",
			description:
				`${WHOSE} Replace a fact that has CHANGED, using the [fN] id from a memory ` +
				"block or a longterm_ask answer. The old version is closed rather than " +
				"deleted, so questions about what was true earlier still answer. Use " +
				"longterm_forget instead when the fact was simply never true. REQUIRES " +
				"scope: the two memories number their facts separately, so [f3] means " +
				"nothing without saying which of them you read it in.",
			parameters: {
				type: "object",
				properties: {
					id: { type: "number", description: "The number inside [fN]." },
					text: {
						type: "string",
						description: "The statement that replaces it.",
					},
					scope: ID_SCOPE_PARAM,
					tags: { type: "array", items: { type: "string" } },
				},
				required: ["id", "text", "scope"],
			},
			run: async (args) =>
				controller.revise(
					num(args.id),
					str(args.text),
					optScope(args.scope),
					strArray(args.tags),
				),
		},
		{
			name: "longterm_forget",
			label: "Long-term memory: forget",
			description:
				`${WHOSE} Drop a fact that was wrong, or a dated one whose date has passed ` +
				"with nothing suggesting it recurs. Keep the durable pattern behind a passed " +
				'event: "plays that game on weekday evenings" outlives "plays at 20:30 on ' +
				'Saturday". Takes one id or several: pass `ids` when you are clearing a ' +
				"list, which is one call instead of one per fact. REQUIRES scope - the two " +
				"memories number their facts separately, so [f3] means nothing without " +
				"saying which of them you read it in.",
			parameters: {
				type: "object",
				properties: {
					id: { type: "number", description: "The number inside [fN]." },
					ids: {
						type: "array",
						items: { type: "number" },
						description:
							"Several such numbers, dropped in one call. Use this for a list.",
					},
					scope: ID_SCOPE_PARAM,
				},
				required: ["scope"],
			},
			run: async (args) =>
				controller.forget(numArray(args.ids, args.id), optScope(args.scope)),
		},
		{
			name: "longterm_tags",
			label: "Long-term memory: tags",
			description:
				`${WHOSE} Lists the tags in use, with counts. There is no fixed vocabulary, ` +
				"so check here before inventing a tag: filtering matches exactly, and `bug` " +
				"versus `bugfix` splits the same facts into two piles that never answer each " +
				"other's questions.",
			parameters: {
				type: "object",
				properties: {
					scope: SCOPE_PARAM,
					prefix: {
						type: "string",
						description: "Exact, case-sensitive prefix.",
					},
					cursor: { type: "string", description: "From a previous page." },
				},
			},
			run: async (args) =>
				controller.listTags(
					scopeOf(args.scope),
					optStr(args.prefix),
					optStr(args.cursor),
				),
		},
		{
			name: "longterm_link",
			label: "Long-term memory: link",
			description:
				`${WHOSE} Record a typed relationship between two entities - ` +
				'"auth module" depends-on "session store". Links let a question about one ' +
				"reach what is known about its neighbours.",
			parameters: {
				type: "object",
				properties: {
					src: { type: "string" },
					rel: {
						type: "string",
						description: "The relationship, as a short verb phrase.",
					},
					dst: { type: "string" },
					scope: SCOPE_PARAM,
				},
				required: ["src", "rel", "dst"],
			},
			run: async (args) =>
				controller.link(
					str(args.src),
					str(args.rel),
					str(args.dst),
					scopeOf(args.scope),
				),
		},
		{
			name: "longterm_unlink",
			label: "Long-term memory: unlink",
			description:
				`${WHOSE} Close a relationship that no longer holds. The edge's history stays ` +
				"answerable; it simply stops being current.",
			parameters: {
				type: "object",
				properties: {
					src: { type: "string" },
					rel: { type: "string" },
					dst: { type: "string" },
					scope: SCOPE_PARAM,
				},
				required: ["src", "rel", "dst"],
			},
			run: async (args) =>
				controller.unlink(
					str(args.src),
					str(args.rel),
					str(args.dst),
					scopeOf(args.scope),
				),
		},
		{
			name: "longterm_note_create",
			label: "Long-term memory: write a note",
			description:
				`${WHOSE} For something that genuinely does not fit in one sentence - an ` +
				"architecture overview, a runbook, the shape of a subsystem. You pass a title " +
				"and a body and get an id back; you never name a file and there is no path to " +
				"give. Prefer a fact when a fact would do.",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string" },
					content: { type: "string", description: "Markdown body." },
					scope: SCOPE_PARAM,
				},
				required: ["title", "content"],
			},
			run: async (args) => {
				const notes = controller.notes(scopeOf(args.scope));
				if (notes === undefined) return NO_PROJECT_NOTES;
				const created = await notes.create(str(args.title), str(args.content));
				return `Created note ${created.noteId} ("${created.title}").`;
			},
		},
		{
			name: "longterm_note_read",
			label: "Long-term memory: read a note",
			description: `${WHOSE} Reads a note by the id longterm_ask or longterm_note_create gave you.`,
			parameters: {
				type: "object",
				properties: {
					note_id: { type: "string" },
					scope: SCOPE_PARAM,
				},
				required: ["note_id"],
			},
			run: async (args) => {
				const notes = controller.notes(scopeOf(args.scope));
				if (notes === undefined) return NO_PROJECT_NOTES;
				const note = await notes.read(str(args.note_id));
				return note === undefined
					? `There is no note ${str(args.note_id)}.`
					: `# ${note.title}\n\n${note.content}`;
			},
		},
		{
			name: "longterm_note_update",
			label: "Long-term memory: update a note",
			description:
				`${WHOSE} Replaces a note's body. An overview describing a structure that ` +
				"changed months ago is worse than none, because it gets believed.",
			parameters: {
				type: "object",
				properties: {
					note_id: { type: "string" },
					content: { type: "string" },
					title: { type: "string" },
					scope: SCOPE_PARAM,
				},
				required: ["note_id", "content"],
			},
			run: async (args) => {
				const notes = controller.notes(scopeOf(args.scope));
				if (notes === undefined) return NO_PROJECT_NOTES;
				const updated = await notes.update(
					str(args.note_id),
					str(args.content),
					optStr(args.title),
				);
				return `Updated note ${updated.noteId}.`;
			},
		},
		{
			name: "longterm_note_delete",
			label: "Long-term memory: delete a note",
			description: `${WHOSE} Removes a note and its pointer together.`,
			parameters: {
				type: "object",
				properties: {
					note_id: { type: "string" },
					scope: SCOPE_PARAM,
				},
				required: ["note_id"],
			},
			run: async (args) => {
				const notes = controller.notes(scopeOf(args.scope));
				if (notes === undefined) return NO_PROJECT_NOTES;
				const removed = await notes.remove(str(args.note_id));
				return removed
					? `Deleted note ${str(args.note_id)}.`
					: `There is no note ${str(args.note_id)}.`;
			},
		},
	];

	// The registration order is the prompt order, and the prompt order is
	// cache-relevant. Asserting it here means a reordering during an edit is a
	// failing test rather than a silent cost.
	return LONGTERM_TOOL_NAMES.map((name) => {
		const spec = specs.find((candidate) => candidate.name === name);
		if (spec === undefined) throw new Error(`tools: ${name} has no definition`);
		return spec;
	});
}

const NO_PROJECT_NOTES =
	"This directory is not a project, so it has no project notes. Use " +
	'scope: "user" for a note about the person rather than the codebase.';
