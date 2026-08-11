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
		const message = await controller.revise(
			id,
			"the linter here is biome",
			"project",
		);
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
		expect(await controller.revise(0, "x", "project")).toMatch(
			/not a project/i,
		);
		expect(await controller.forget([0], "project")).toMatch(/not a project/i);
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
		expect(await controller.forget([999], "project")).toMatch(/no live fact/i);
	});

	it("drops a fact that was", async () => {
		const { controller, project } = build();
		const stored = await controller.remember({ text: "a durable fact" });
		const id = Number(/\[f(\d+)\]/.exec(stored)?.[1]);
		expect(await controller.forget([id], "project")).toMatch(/forgot/i);
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

describe("what a write tells the model", () => {
	it("names the scope, so the fact can be addressed later", async () => {
		// The number alone addresses nothing: the two memories number their
		// facts separately. Telling the model the scope at the moment it
		// learns the id is the cheapest place to say it.
		const { controller } = build();
		const answer = await controller.remember({
			text: "tests run under vitest here",
		});
		expect(answer).toMatch(/\[f\d+\]/);
		expect(answer).toContain("scope  : project");
		expect(answer).toContain("entity : project");
	});

	it("names what it collided with when a write is refused", async () => {
		// A bare list of ids leaves the model with two guesses - rephrase, or
		// revise - and no way to tell which. So it sends the same call again.
		const { controller } = build();
		await controller.remember({
			text: "the cache is off because of a warmup race",
			tags: ["gotcha"],
		});
		const refused = await controller.remember({
			text: "the cache is off because of a warmup race",
		});
		expect(refused).toMatch(/not stored/i);
		expect(refused).toContain("[f0] the cache is off because of a warmup race");
		expect(refused).toContain("#gotcha");
		expect(refused).toContain('scope: "project"');
		expect(refused).toMatch(/do not send this call again unchanged/i);
	});

	it("hands the same detail to the terminal, once", async () => {
		const { controller } = build();
		await controller.remember({ text: "a durable fact", tags: ["decision"] });
		const first = controller.takeLastWrite();
		expect(first?.scope).toBe("project");
		expect(first?.tags).toEqual(["decision"]);
		// Taken, not peeked: a second tool call must not re-render the first
		// call's write.
		expect(controller.takeLastWrite()).toBeUndefined();
	});

	it("leaves nothing behind when the write was refused", async () => {
		const { controller } = build();
		await controller.remember({ text: "the linter here is biome" });
		controller.takeLastWrite();
		const refused = await controller.remember({
			text: "the linter here is biome",
		});
		expect(refused).toMatch(/not stored/i);
		expect(controller.takeLastWrite()).toBeUndefined();
	});
});

describe("when the engine reports it could not check", () => {
	it("says so, instead of letting it pass as a clean write", async () => {
		// `checked: false` means the engine had no candidate set and wrote with
		// no duplicate check at all. Every write this controller makes names an
		// entity, so it cannot happen today - and the last time it could, one
		// sentence was stored six times before anybody noticed. The point of
		// surfacing it is that silence is what made that expensive.
		const { controller, project } = build();
		if (project === undefined) throw new Error("this build has a project");
		project.guardsNothing = true;

		const answer = await controller.remember({ text: "a durable fact" });
		expect(answer).toMatch(/without a duplicate check/i);
		expect(answer).toMatch(/may now hold it twice/i);
	});

	it("stays quiet on an ordinary write", async () => {
		const { controller } = build();
		const answer = await controller.remember({ text: "a durable fact" });
		expect(answer).not.toMatch(/without a duplicate check/i);
	});
});

describe("clearing several facts at once", () => {
	it("drops a list in one call", async () => {
		// The job that produces a list of ids is clearing duplicates, and it is
		// the job this tool is for. One-at-a-time made it unreachable: asked to
		// drop four, the model announced "all of them in parallel" and emitted
		// a single call, six times over, because one was all it was offered.
		const { controller, project } = build();
		const ids: number[] = [];
		for (const text of ["fact one", "fact two", "fact three"]) {
			const stored = await controller.remember({ text });
			ids.push(Number(/\[f(\d+)\]/.exec(stored)?.[1]));
		}
		const answer = await controller.forget(ids, "project");
		expect(answer).toMatch(/Forgot \[f0\], \[f1\], \[f2\]/);
		expect(project?.live()).toHaveLength(0);
	});

	it("reports each id that was not there, and drops the rest anyway", async () => {
		const { controller, project } = build();
		const stored = await controller.remember({ text: "a durable fact" });
		const id = Number(/\[f(\d+)\]/.exec(stored)?.[1]);
		const answer = await controller.forget([id, 99], "project");
		expect(answer).toMatch(/Forgot \[f0\]/);
		expect(answer).toMatch(/no live fact \[f99\]/i);
		expect(project?.live()).toHaveLength(0);
	});

	it("says YOU already did that, rather than leaving it ambiguous", async () => {
		// "It may have been forgotten already" is true and useless: the model
		// read it, looked at a block that still listed the fact, and concluded
		// its own tool did nothing.
		const { controller } = build();
		const stored = await controller.remember({ text: "a durable fact" });
		const id = Number(/\[f(\d+)\]/.exec(stored)?.[1]);
		await controller.forget([id], "project");
		expect(await controller.forget([id], "project")).toMatch(
			/YOU forgot it earlier in this session and it worked/,
		);
	});

	it("escalates when the same failing call keeps arriving", async () => {
		const { controller } = build();
		await controller.forget([99], "project");
		expect(await controller.forget([99], "project")).toMatch(/second time/i);
		expect(await controller.forget([99], "project")).toMatch(/^stop\./i);
	});

	it("treats a new user message as a new situation", async () => {
		const { controller } = build();
		await controller.forget([99], "project");
		await controller.forget([99], "project");
		controller.noteUserMessage();
		expect(await controller.forget([99], "project")).not.toMatch(
			/second time/i,
		);
	});
});
