/**
 * What the tools do with arguments that are not what the schema asked for.
 *
 * A schema is a request, not a guarantee - a model can and does send a missing
 * field, a number where a string was declared, or an enum value it invented.
 * Every one of those has to land somewhere safe, and "safe" here means the
 * project memory rather than the shared one, because a wrong fact in the shared
 * memory is read at the start of every session of every project.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { NoteStore } from "../../src/notes/store.ts";
import { ProjectRouter } from "../../src/router/router.ts";
import { MemoryController } from "../../src/session/controller.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import { longtermTools } from "../../src/tools/definitions.ts";
import { FakeFs } from "../helpers/fake-fs.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

function build() {
	const common = new FakeMemory();
	const project = new FakeMemory();
	const fs = new FakeFs();
	const controller = new MemoryController({
		settings: DEFAULT_SETTINGS,
		common,
		project,
		projectName: "app",
		notesCommon: new NoteStore(common, { fs, dir: "/c", flavour: path.posix }),
		notesProject: new NoteStore(project, {
			fs,
			dir: "/p",
			flavour: path.posix,
		}),
		router: new ProjectRouter(common),
	});
	const tools = longtermTools(controller);
	const call = (name: string, args: Record<string, unknown> = {}) => {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool === undefined) throw new Error(`no tool ${name}`);
		return tool.run(args);
	};
	return { call, common, project, fs };
}

describe("tool arguments", () => {
	it("survives a missing required field", async () => {
		// Better an empty fact than a thrown exception the model cannot read.
		const { call } = build();
		await expect(call("longterm_remember", {})).resolves.toBeDefined();
		await expect(call("longterm_ask", {})).resolves.toBeDefined();
		await expect(call("longterm_ask_project", {})).resolves.toBeDefined();
	});

	it("coerces a non-string where a string was declared", async () => {
		const { call } = build();
		await expect(call("longterm_ask", { question: 42 })).resolves.toBeDefined();
		await expect(
			call("longterm_link", { src: 1, rel: 2, dst: 3 }),
		).resolves.toMatch(/linked/i);
	});

	it("ignores tags that are not an array", async () => {
		const { call, project } = build();
		await call("longterm_remember", { text: "a fact", tags: "decision" });
		expect(project.live()[0]?.tags).toEqual([]);
	});

	it("stringifies the members of a tag array", async () => {
		const { call, project } = build();
		await call("longterm_remember", { text: "a fact", tags: [1, "two"] });
		expect(project.live()[0]?.tags).toEqual(["1", "two"]);
	});

	it("ignores a non-numeric k or graph depth", async () => {
		const { call } = build();
		await expect(
			call("longterm_ask", { question: "x", k: "five", graph_depth: null }),
		).resolves.toBeDefined();
	});

	it("passes an entity through only when it is a string", async () => {
		const { call, project } = build();
		await call("longterm_remember", { text: "a fact", entity: "auth" });
		expect(project.live()[0]?.entity).toBe("auth");
		await call("longterm_remember", {
			text: "a different statement",
			entity: 7,
		});
		// Not `7`, and not nothing either: a fact with no entity is a fact the
		// duplicate guard cannot compare against anything.
		expect(project.live()[1]?.entity).toBe("project");
	});

	it("ignores a prefix or cursor that is not a string", async () => {
		const { call } = build();
		await call("longterm_remember", { text: "a fact", tags: ["decision"] });
		expect(await call("longterm_tags", { prefix: 1, cursor: {} })).toContain(
			"decision",
		);
	});

	it("keeps an explicit user scope on every tool that takes one", async () => {
		const { call, common } = build();
		await call("longterm_remember", { text: "prefers Rust", scope: "user" });
		await call("longterm_link", {
			src: "a",
			rel: "b",
			dst: "c",
			scope: "user",
		});
		expect(common.live()).toHaveLength(1);
		expect(common.edges).toHaveLength(1);
	});

	it("routes a note to the scope it was given", async () => {
		const { call, fs } = build();
		await call("longterm_note_create", {
			title: "T",
			content: "C",
			scope: "user",
		});
		expect([...fs.files.keys()][0]?.startsWith("/c/")).toBe(true);
	});

	it("updates a note's title only when one is given", async () => {
		const { call } = build();
		const created = await call("longterm_note_create", {
			title: "First",
			content: "a",
		});
		const noteId = /note (\S+) /.exec(created)?.[1] ?? "";
		await call("longterm_note_update", { note_id: noteId, content: "b" });
		expect(await call("longterm_note_read", { note_id: noteId })).toContain(
			"# First",
		);
		await call("longterm_note_update", {
			note_id: noteId,
			content: "c",
			title: "Second",
		});
		expect(await call("longterm_note_read", { note_id: noteId })).toContain(
			"# Second",
		);
	});

	it("reports rather than throws on a forget of nothing", async () => {
		const { call } = build();
		expect(
			await call("longterm_forget", { id: 999, scope: "project" }),
		).toMatch(/no live fact/i);
	});

	it("asks which memory when an id arrives without one", async () => {
		// The failure this prevents cost a live session ten consecutive calls:
		// the model read [f3] in the shared memory, forget defaulted to the
		// project, and "fact 3 not found" gave it nothing to correct.
		const { call } = build();
		for (const name of ["longterm_forget", "longterm_revise"]) {
			const answer = await call(name, { id: 3, text: "x" });
			expect(answer, name).toMatch(/which memory/i);
			expect(answer, name).toContain('scope: "user"');
		}
	});

	it("revises with tags when they are given", async () => {
		const { call, project } = build();
		const stored = await call("longterm_remember", {
			text: "the linter is eslint",
		});
		const id = Number(/\[f(\d+)\]/.exec(stored)?.[1]);
		await call("longterm_revise", {
			id,
			text: "the linter is biome",
			scope: "project",
			tags: ["tooling"],
		});
		expect(project.live()[0]?.tags).toEqual(["tooling"]);
	});
});

describe("the ids a forget can arrive with", () => {
	it("accepts a list, a single id, or both", async () => {
		const { call, project } = build();
		for (const text of ["fact one", "fact two", "fact three"]) {
			await call("longterm_remember", { text });
		}
		// `ids` and `id` together: a model that has seen the single-id form
		// before will send both, and dropping either would lose a fact.
		const answer = await call("longterm_forget", {
			ids: [0, 1],
			id: 2,
			scope: "project",
		});
		expect(answer).toContain("[f0]");
		expect(answer).toContain("[f2]");
		expect(project.live()).toHaveLength(0);
	});

	it("drops members that are not numbers rather than coercing them", async () => {
		// `Number("f3")` is NaN, and a NaN id addresses nothing.
		const { call } = build();
		await call("longterm_remember", { text: "a durable fact" });
		const answer = await call("longterm_forget", {
			ids: ["f0", null, 0],
			scope: "project",
		});
		expect(answer).toBe(
			"Forgot 1 fact from this project (app):\n  [f0] a durable fact",
		);
	});

	it("says what it needs when the list is empty", async () => {
		const { call } = build();
		expect(
			await call("longterm_forget", { ids: [], scope: "project" }),
		).toMatch(/no ids given/i);
	});

	it("still asks which memory when a list arrives without one", async () => {
		const { call } = build();
		expect(await call("longterm_forget", { ids: [3, 4] })).toMatch(
			/which memory/i,
		);
	});
});
