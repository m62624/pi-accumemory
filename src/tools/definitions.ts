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

import type { MemoryController, Scope } from "../session/controller.ts";

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
					question: String(args.question ?? ""),
					...(isScope(args.scope) ? { scope: args.scope } : {}),
					...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
					...(typeof args.k === "number" ? { k: args.k } : {}),
					...(typeof args.graph_depth === "number"
						? { graphDepth: args.graph_depth }
						: {}),
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
				controller.askProject(
					String(args.project ?? ""),
					String(args.question ?? ""),
				),
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
					text: String(args.text ?? ""),
					...(isScope(args.scope) ? { scope: args.scope } : {}),
					...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
					...(typeof args.entity === "string" ? { entity: args.entity } : {}),
				}),
		},
		{
			name: "longterm_revise",
			label: "Long-term memory: revise",
			description:
				`${WHOSE} Replace a fact that has CHANGED, using the [fN] id from a memory ` +
				"block or a longterm_ask answer. The old version is closed rather than " +
				"deleted, so questions about what was true earlier still answer. Use " +
				"longterm_forget instead when the fact was simply never true.",
			parameters: {
				type: "object",
				properties: {
					id: { type: "number", description: "The number inside [fN]." },
					text: {
						type: "string",
						description: "The statement that replaces it.",
					},
					scope: SCOPE_PARAM,
					tags: { type: "array", items: { type: "string" } },
				},
				required: ["id", "text"],
			},
			run: async (args) =>
				controller.revise(
					Number(args.id),
					String(args.text ?? ""),
					isScope(args.scope) ? args.scope : "project",
					Array.isArray(args.tags) ? args.tags.map(String) : undefined,
				),
		},
		{
			name: "longterm_forget",
			label: "Long-term memory: forget",
			description:
				`${WHOSE} Drop a fact that was wrong, or a dated one whose date has passed ` +
				"with nothing suggesting it recurs. Keep the durable pattern behind a passed " +
				'event: "plays that game on weekday evenings" outlives "plays at 20:30 on ' +
				'Saturday".',
			parameters: {
				type: "object",
				properties: {
					id: { type: "number", description: "The number inside [fN]." },
					scope: SCOPE_PARAM,
				},
				required: ["id"],
			},
			run: async (args) =>
				controller.forget(
					Number(args.id),
					isScope(args.scope) ? args.scope : "project",
				),
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
					isScope(args.scope) ? args.scope : "project",
					typeof args.prefix === "string" ? args.prefix : undefined,
					typeof args.cursor === "string" ? args.cursor : undefined,
				),
		},
		{
			name: "longterm_link",
			label: "Long-term memory: link",
			description:
				`${WHOSE} Record a typed relationship between two entities - "auth module " +
				depends-on session store". Links let a question about one reach what is known ` +
				"about its neighbours.",
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
					String(args.src ?? ""),
					String(args.rel ?? ""),
					String(args.dst ?? ""),
					isScope(args.scope) ? args.scope : "project",
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
					String(args.src ?? ""),
					String(args.rel ?? ""),
					String(args.dst ?? ""),
					isScope(args.scope) ? args.scope : "project",
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
				const notes = controller.notes(
					isScope(args.scope) ? args.scope : "project",
				);
				if (notes === undefined) return NO_PROJECT_NOTES;
				const created = await notes.create(
					String(args.title ?? ""),
					String(args.content ?? ""),
				);
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
				const notes = controller.notes(
					isScope(args.scope) ? args.scope : "project",
				);
				if (notes === undefined) return NO_PROJECT_NOTES;
				const note = await notes.read(String(args.note_id ?? ""));
				return note === undefined
					? `There is no note ${String(args.note_id)}.`
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
				const notes = controller.notes(
					isScope(args.scope) ? args.scope : "project",
				);
				if (notes === undefined) return NO_PROJECT_NOTES;
				const updated = await notes.update(
					String(args.note_id ?? ""),
					String(args.content ?? ""),
					typeof args.title === "string" ? args.title : undefined,
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
				const notes = controller.notes(
					isScope(args.scope) ? args.scope : "project",
				);
				if (notes === undefined) return NO_PROJECT_NOTES;
				const removed = await notes.remove(String(args.note_id ?? ""));
				return removed
					? `Deleted note ${String(args.note_id)}.`
					: `There is no note ${String(args.note_id)}.`;
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

function isScope(value: unknown): value is Scope {
	return value === "project" || value === "user" || value === "both";
}
