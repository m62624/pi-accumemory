import path from "node:path";
import { describe, expect, it } from "vitest";
import { NoteStore } from "../../src/notes/store.ts";
import { ProjectRouter } from "../../src/router/router.ts";
import { MemoryController } from "../../src/session/controller.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import {
	LONGTERM_TOOL_NAMES,
	longtermTools,
} from "../../src/tools/definitions.ts";
import { FakeFs } from "../helpers/fake-fs.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

function build(options: { withProject?: boolean } = {}) {
	const common = new FakeMemory();
	const project = options.withProject === false ? undefined : new FakeMemory();
	const fs = new FakeFs();
	const controller = new MemoryController({
		settings: DEFAULT_SETTINGS,
		common,
		...(project === undefined ? {} : { project }),
		projectName: "app",
		notesCommon: new NoteStore(common, {
			fs,
			dir: "/notes/common",
			flavour: path.posix,
		}),
		...(project === undefined
			? {}
			: {
					notesProject: new NoteStore(project, {
						fs,
						dir: "/notes/p1",
						flavour: path.posix,
					}),
				}),
		router: new ProjectRouter(common),
	});
	const tools = longtermTools(controller);
	const call = (name: string, args: Record<string, unknown> = {}) => {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool === undefined) throw new Error(`no tool ${name}`);
		return tool.run(args);
	};
	return { controller, common, project, fs, tools, call };
}

describe("tool names", () => {
	it("prefixes every tool with longterm_", () => {
		// pi-telegram-manager registers manager_remember over the same engine,
		// about a chat partner. Two plausible `remember` tools with nothing but
		// the name to tell them apart is how a fact ends up in the wrong store.
		for (const tool of build().tools) {
			expect(tool.name.startsWith("longterm_")).toBe(true);
		}
	});

	it("collides with neither pi-telegram-manager nor pi-planner", () => {
		for (const name of LONGTERM_TOOL_NAMES) {
			expect(name.startsWith("manager_")).toBe(false);
			expect(name.startsWith("planner_")).toBe(false);
		}
	});

	it("registers in a fixed order, because the order is prompt bytes", () => {
		// Tool schemas render into the head of the prompt. The same tools in a
		// different order are a cache miss on the whole thing.
		expect(build().tools.map((tool) => tool.name)).toEqual([
			...LONGTERM_TOOL_NAMES,
		]);
	});

	it("says whose memory it is in the first sentence of every description", () => {
		for (const tool of build().tools) {
			expect(tool.description).toMatch(
				/^Long-term memory of THIS PROJECT and of the user/,
			);
		}
	});

	it("tells the model outright that remember is not about a chat partner", () => {
		// The one verb that collides head-on with the Telegram tool.
		const remember = build().tools.find(
			(tool) => tool.name === "longterm_remember",
		);
		expect(remember?.description).toMatch(/not about a conversation partner/i);
	});

	it("forbids credentials where the model will actually read it", () => {
		// The instruction files say this too, but a tool description is read
		// at the moment of choosing to call the tool.
		const remember = build().tools.find(
			(tool) => tool.name === "longterm_remember",
		);
		expect(remember?.description).toMatch(/never store credentials/i);
		expect(remember?.description).toMatch(/\.env/);
	});

	it("declares every required parameter it reads", () => {
		for (const tool of build().tools) {
			for (const required of tool.parameters.required ?? []) {
				expect(Object.keys(tool.parameters.properties)).toContain(required);
			}
		}
	});
});

describe("tool behaviour", () => {
	it("stores and finds a fact end to end", async () => {
		const { call } = build();
		await call("longterm_remember", {
			text: "the cache is off because it raced with the warmup task",
			tags: ["gotcha"],
		});
		expect(
			await call("longterm_ask", { question: "why is the cache off" }),
		).toContain("warmup");
	});

	it("defaults to the project when no scope is given", async () => {
		const { call, project, common } = build();
		await call("longterm_remember", { text: "tests run under vitest here" });
		expect(project?.live()).toHaveLength(1);
		expect(common.live()).toHaveLength(0);
	});

	it("routes an explicit user scope to the shared memory", async () => {
		const { call, common } = build();
		await call("longterm_remember", {
			text: "prefers Rust for systems work",
			scope: "user",
		});
		expect(common.live()).toHaveLength(1);
	});

	it("ignores a scope value that is not one of the three", async () => {
		// A model inventing "global" must not silently land in the shared
		// memory; it falls back to the safe default.
		const { call, project, common } = build();
		await call("longterm_remember", { text: "a fact", scope: "global" });
		expect(project?.live()).toHaveLength(1);
		expect(common.live()).toHaveLength(0);
	});

	it("creates a note without the model ever naming a file", async () => {
		const { call, fs } = build();
		const result = await call("longterm_note_create", {
			title: "Overview",
			content: "It builds a thing.",
		});
		expect(result).toMatch(/created note/i);
		expect(fs.files.size).toBe(1);
		expect(result).not.toContain("/notes/");
	});

	it("reads a note back through its id", async () => {
		const { call } = build();
		const created = await call("longterm_note_create", {
			title: "Overview",
			content: "the body",
		});
		const noteId = /note (\S+) /.exec(created)?.[1] ?? "";
		expect(await call("longterm_note_read", { note_id: noteId })).toContain(
			"the body",
		);
	});

	it("explains itself rather than failing outside a project", async () => {
		// Every note tool, not just the one that creates: a directory that is
		// not a project has no project notes to read, change or delete either,
		// and each of those has its own way of reaching for a store that does
		// not exist.
		const { call } = build({ withProject: false });
		for (const [name, args] of [
			["longterm_note_create", { title: "x", content: "y" }],
			["longterm_note_read", { note_id: "n1" }],
			["longterm_note_update", { note_id: "n1", content: "y" }],
			["longterm_note_delete", { note_id: "n1" }],
		] as const) {
			expect(await call(name, args), name).toMatch(/no memory of its own/i);
		}
		expect(await call("longterm_remember", { text: "x" })).toMatch(
			/no memory of its own/i,
		);
	});

	it("updates a note through its id", async () => {
		const { call } = build();
		const created = await call("longterm_note_create", {
			title: "Overview",
			content: "the body",
		});
		const noteId = /note (\S+) /.exec(created)?.[1] ?? "";
		expect(
			await call("longterm_note_update", {
				note_id: noteId,
				content: "a newer body",
				title: "Overview v2",
			}),
		).toMatch(/updated note/i);
		expect(await call("longterm_note_read", { note_id: noteId })).toContain(
			"a newer body",
		);
	});

	it("reports an unknown note instead of throwing", async () => {
		const { call } = build();
		expect(await call("longterm_note_read", { note_id: "ghost" })).toMatch(
			/no note/i,
		);
		expect(await call("longterm_note_delete", { note_id: "ghost" })).toMatch(
			/no note/i,
		);
	});

	it("revises and forgets by the id it reported", async () => {
		const { call } = build();
		const stored = await call("longterm_remember", {
			text: "the linter here is eslint",
		});
		const id = Number(/\[f(\d+)\]/.exec(stored)?.[1]);
		expect(
			await call("longterm_revise", {
				id,
				text: "the linter here is biome",
				scope: "project",
			}),
		).toMatch(/revised/i);
		expect(
			await call("longterm_forget", { id: id + 1, scope: "project" }),
		).toMatch(/forgot/i);
	});

	it("lists tags with their counts", async () => {
		const { call } = build();
		await call("longterm_remember", {
			text: "a decision was made",
			tags: ["decision"],
		});
		expect(await call("longterm_tags")).toContain("decision(1)");
	});

	it("links and unlinks entities", async () => {
		const { call } = build();
		expect(
			await call("longterm_link", {
				src: "auth",
				rel: "depends-on",
				dst: "sessions",
			}),
		).toMatch(/linked/i);
		expect(
			await call("longterm_unlink", {
				src: "auth",
				rel: "depends-on",
				dst: "sessions",
			}),
		).toMatch(/unlinked/i);
		expect(
			await call("longterm_unlink", {
				src: "auth",
				rel: "depends-on",
				dst: "sessions",
			}),
		).toMatch(/no such link/i);
	});

	it("lists no projects before any are registered", async () => {
		expect(await build().call("longterm_projects")).toMatch(/no projects/i);
	});
});
