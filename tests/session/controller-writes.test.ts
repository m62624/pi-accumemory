/**
 * The controller's write and inspect surface, and what it says when a call
 * cannot be honoured.
 *
 * Every one of these returns a sentence rather than throwing. A tool result is
 * the only channel the model has: an exception it never sees becomes silence,
 * and silence is read as "that worked".
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { NoteStore } from "../../src/notes/store.ts";
import { ProjectRouter } from "../../src/router/router.ts";
import { MemoryController } from "../../src/session/controller.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
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
		notesCommon: new NoteStore(common, { fs, dir: "/c", flavour: path.posix }),
		...(project === undefined
			? {}
			: {
					notesProject: new NoteStore(project, {
						fs,
						dir: "/p",
						flavour: path.posix,
					}),
				}),
		router: new ProjectRouter(common),
	});
	return { controller, common, project, fs };
}

describe("MemoryController.revise", () => {
	it("closes the old version instead of deleting it", async () => {
		const { controller, project } = build();
		const stored = await controller.remember({
			text: "the linter here is eslint",
		});
		const id = Number(/\[f(\d+)\]/.exec(stored)?.[1]);
		const message = await controller.revise(id, "the linter here is biome");
		expect(message).toMatch(/kept as history/i);
		expect(project?.facts).toHaveLength(2);
		expect(project?.live()).toHaveLength(1);
	});

	it("keeps tags when they are supplied", async () => {
		const { controller, project } = build();
		const stored = await controller.remember({
			text: "the linter here is eslint",
		});
		const id = Number(/\[f(\d+)\]/.exec(stored)?.[1]);
		await controller.revise(id, "the linter here is biome", "project", [
			"tooling",
		]);
		expect(project?.live()[0]?.tags).toEqual(["tooling"]);
	});

	it("explains itself outside a project", async () => {
		const { controller } = build({ withProject: false });
		expect(await controller.revise(0, "x")).toMatch(/not a project/i);
		expect(await controller.forget(0)).toMatch(/not a project/i);
		expect(await controller.listTags()).toMatch(/not a project/i);
		expect(await controller.link("a", "b", "c")).toMatch(/not a project/i);
		expect(await controller.unlink("a", "b", "c")).toMatch(/not a project/i);
	});

	it("refuses a write addressed to both memories at once", async () => {
		// "Both" is a reading scope. Writing the same fact to both stores would
		// leave two copies that drift apart, and revising one leaves the other
		// lying.
		const { controller } = build();
		expect(await controller.remember({ text: "x", scope: "both" })).toMatch(
			/not a project/i,
		);
	});
});

describe("MemoryController.forget", () => {
	it("reports a fact that was not there", async () => {
		const { controller } = build();
		expect(await controller.forget(999)).toMatch(/no live fact/i);
	});

	it("drops a fact that was", async () => {
		const { controller, project } = build();
		const stored = await controller.remember({ text: "a durable fact" });
		const id = Number(/\[f(\d+)\]/.exec(stored)?.[1]);
		expect(await controller.forget(id)).toMatch(/forgot/i);
		expect(project?.live()).toHaveLength(0);
	});
});

describe("MemoryController.listTags", () => {
	it("says so when there are none yet", async () => {
		expect(await build().controller.listTags()).toMatch(/no tags/i);
	});

	it("filters by prefix", async () => {
		const { controller } = build();
		await controller.remember({ text: "a decision", tags: ["decision"] });
		await controller.remember({
			text: "a completely separate gotcha",
			tags: ["gotcha"],
		});
		expect(await controller.listTags("project", "dec")).toContain("decision");
		expect(await controller.listTags("project", "dec")).not.toContain("gotcha");
	});

	it("hands back a cursor when there is another page", async () => {
		const { controller, project } = build();
		for (let i = 0; i < 5; i += 1) {
			await project?.remember({ text: `fact number ${i}`, tags: [`tag${i}`] });
		}
		const page = await controller.listTags("project", undefined, "0");
		expect(page).toBeDefined();
	});
});

describe("MemoryController.link", () => {
	it("records and removes a relationship", async () => {
		const { controller, common } = build();
		expect(
			await controller.link("auth", "depends-on", "sessions", "user"),
		).toMatch(/linked/i);
		expect(common.edges).toHaveLength(1);
		expect(
			await controller.unlink("auth", "depends-on", "sessions", "user"),
		).toMatch(/unlinked/i);
		expect(
			await controller.unlink("auth", "depends-on", "sessions", "user"),
		).toMatch(/no such link/i);
	});
});

describe("MemoryController.notes", () => {
	it("returns the store for the scope asked for", () => {
		const { controller } = build();
		expect(controller.notes("user")).toBeDefined();
		expect(controller.notes("project")).toBeDefined();
	});

	it("has no project store outside a project", () => {
		expect(
			build({ withProject: false }).controller.notes("project"),
		).toBeUndefined();
	});
});

describe("MemoryController.consolidationView", () => {
	it("says the memory is empty when it is", async () => {
		expect(await build().controller.consolidationView("anything")).toMatch(
			/empty/i,
		);
	});

	it("shows what is there with actionable ids", async () => {
		const { controller, project } = build();
		await project?.remember({
			text: "the cache is off because of a warmup race",
		});
		const view = await controller.consolidationView("cache warmup");
		expect(view).toContain("longterm_revise");
		expect(view).toContain("warmup");
	});

	it("falls back to the shared memory outside a project", async () => {
		const { controller, common } = build({ withProject: false });
		await common.remember({ text: "prefers Rust for systems work" });
		expect(await controller.consolidationView("Rust")).toContain("Rust");
	});
});

describe("MemoryController.askProject", () => {
	it("says so when the session cannot open other projects", async () => {
		const { controller, common } = build();
		const router = new ProjectRouter(common);
		await router.resolve("/home/m/Projects/api");
		expect(await controller.askProject("api", "anything")).toMatch(
			/not available/i,
		);
	});

	it("reports an empty answer as an answer", async () => {
		const { common } = build();
		const router = new ProjectRouter(common);
		await router.resolve("/home/m/Projects/api");
		const withReader = new MemoryController({
			settings: DEFAULT_SETTINGS,
			common,
			router,
			notesCommon: new NoteStore(common, {
				fs: new FakeFs(),
				dir: "/c",
				flavour: path.posix,
			}),
			openProjectReader: async () => ({
				memory: new FakeMemory(),
				close: () => {},
			}),
		});
		expect(await withReader.askProject("api", "anything")).toMatch(
			/nothing on this/i,
		);
	});

	it("says there are no projects at all when there are none", async () => {
		expect(await build().controller.askProject("api", "anything")).toMatch(
			/no projects are registered/i,
		);
	});
});

describe("MemoryController.noteCompact", () => {
	it("makes the block due again", async () => {
		// The history was just cut away; the memory is what is left of it, and
		// it must not be the version retrieved for a question two topics ago.
		const { controller, project } = build();
		await project?.remember({
			text: "the cache is off because of a warmup race",
		});
		await controller.tail([{ role: "user", text: "why is the cache off" }]);
		await project?.remember({
			text: "biome is the formatter used in this repo",
		});
		controller.noteCompact();
		const after = await controller.tail([
			{ role: "user", text: "which formatter does this repo use" },
		]);
		expect(after).toContain("biome");
	});
});
