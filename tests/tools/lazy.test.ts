/**
 * The façade the extension actually registers its tools against.
 *
 * This file exists because of a bug that reached a user's terminal. The façade
 * was written inline in `src/index.ts` and cast into place with
 * `as unknown as`, so when `longterm_about` was added and its controller member
 * was not, nothing complained: the member was `undefined`, every call to the
 * new tool threw, and the terminal rendered the crash as
 * `Stored [fundefined] in undefined.` - a failure that reads as a success.
 *
 * Every other test built its tools on a real controller, which is exactly the
 * path the extension never takes. So the test that matters is the boring one
 * below: call all fourteen tools through the façade and require that each of
 * them answers. It is written against `LONGTERM_TOOL_NAMES` rather than a list
 * of its own, so a fifteenth tool cannot be added without either wiring it up
 * or failing here.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { NoteStore } from "../../src/notes/store.ts";
import { ProjectRouter } from "../../src/router/router.ts";
import { MemoryController } from "../../src/session/controller.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import {
	LONGTERM_TOOL_NAMES,
	type LongtermToolName,
	longtermTools,
} from "../../src/tools/definitions.ts";
import { lazyController, MEMORY_UNAVAILABLE } from "../../src/tools/lazy.ts";
import { FakeFs } from "../helpers/fake-fs.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

/** Arguments good enough for each tool to reach the controller. */
const ARGS: Record<LongtermToolName, Record<string, unknown>> = {
	longterm_ask: { question: "why is the cache off" },
	longterm_ask_project: { project: "other", question: "how was auth done" },
	longterm_projects: {},
	longterm_remember: { text: "the formatter is biome" },
	longterm_revise: {
		id: 0,
		text: "the formatter is prettier",
		scope: "project",
	},
	longterm_forget: { ids: [0], scope: "project" },
	longterm_tags: {},
	longterm_link: { src: "api", rel: "depends-on", dst: "db" },
	longterm_unlink: { src: "api", rel: "depends-on", dst: "db" },
	longterm_note_create: { title: "layout", content: "a long body" },
	longterm_note_read: { note_id: "n1" },
	longterm_note_update: { note_id: "n1", content: "a longer body" },
	longterm_note_delete: { note_id: "n1" },
	longterm_about: { topic: "system" },
};

function realController() {
	const common = new FakeMemory();
	const project = new FakeMemory();
	const fs = new FakeFs();
	return new MemoryController({
		settings: DEFAULT_SETTINGS,
		common,
		project,
		projectName: "app",
		notesCommon: new NoteStore(common, {
			fs,
			dir: "/notes/common",
			flavour: path.posix,
		}),
		notesProject: new NoteStore(project, {
			fs,
			dir: "/notes/p1",
			flavour: path.posix,
		}),
		router: new ProjectRouter(common),
	});
}

describe("every tool through the façade", () => {
	it("has an argument set here, so none is skipped by omission", () => {
		expect(Object.keys(ARGS).sort()).toEqual([...LONGTERM_TOOL_NAMES].sort());
	});

	it("answers once the memory is open", async () => {
		const controller = realController();
		const tools = longtermTools(lazyController(() => ({ controller })));
		expect(tools).toHaveLength(LONGTERM_TOOL_NAMES.length);
		for (const tool of tools) {
			const answer = await tool.run(ARGS[tool.name]);
			expect(typeof answer, `${tool.name} answered with a non-string`).toBe(
				"string",
			);
			expect(
				answer.length,
				`${tool.name} answered with nothing`,
			).toBeGreaterThan(0);
			// The façade is transparent: a live memory means a real answer.
			expect(answer, `${tool.name} fell through the façade`).not.toBe(
				MEMORY_UNAVAILABLE,
			);
		}
	});

	it("says so, once, when the memory has not opened yet", async () => {
		const tools = longtermTools(lazyController(() => undefined));
		for (const tool of tools) {
			// `longterm_note_*` route through a store the façade cannot produce,
			// so they answer with their own sentence about notes rather than this
			// one; what matters is that none of them throws.
			const answer = await tool.run(ARGS[tool.name]);
			expect(typeof answer, `${tool.name} threw before startup`).toBe("string");
		}
	});

	it("reads an about page through it, which is what broke", async () => {
		const controller = realController();
		const tools = longtermTools(lazyController(() => ({ controller })));
		const about = tools.find((tool) => tool.name === "longterm_about");
		const page = await about?.run({ topic: "scopes" });
		expect(page).toContain("scope");
		expect(page).not.toContain("Stored [f");
	});
});
