import { beforeEach, describe, expect, it } from "vitest";
import {
	IDENTIFIES,
	pathEntity,
	projectEntity,
} from "../../src/router/entities.ts";
import { ProjectRouter } from "../../src/router/router.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

/** Ids are handed out from a list so every assertion below names a real one. */
function fixedIds(...ids: string[]): () => string {
	const queue = [...ids];
	return () => queue.shift() ?? "exhausted";
}

describe("ProjectRouter", () => {
	let common: FakeMemory;
	let router: ProjectRouter;

	beforeEach(() => {
		common = new FakeMemory();
		router = new ProjectRouter(common, {
			newId: fixedIds("aaa111", "bbb222", "ccc333"),
		});
	});

	it("registers a project on first sight and returns it again afterwards", async () => {
		const first = await router.resolve("/home/m/Projects/app");
		expect(first).toEqual({ projectId: "aaa111", created: true });

		const second = await router.resolve("/home/m/Projects/app");
		expect(second).toEqual({ projectId: "aaa111", created: false });
	});

	it("does not confuse two projects sharing a path prefix", async () => {
		// The reason routes are entity names and not searchable text: these two
		// share every token but the last, and a ranked text search returns the
		// wrong one often enough to corrupt a project's memory.
		const app = await router.resolve("/home/m/Projects/app");
		const appV2 = await router.resolve("/home/m/Projects/app-v2");
		expect(app.projectId).not.toBe(appV2.projectId);
		expect((await router.resolve("/home/m/Projects/app")).projectId).toBe(
			app.projectId,
		);
		expect((await router.resolve("/home/m/Projects/app-v2")).projectId).toBe(
			appV2.projectId,
		);
	});

	it("publishes a checkpoint after registering, so other sessions can see it", async () => {
		// A read-only handle in another terminal sees published generations only.
		// A registration nobody checkpointed is a project the next session
		// registers a second time, under a second id.
		await router.resolve("/home/m/Projects/app");
		expect(common.checkpoints).toBeGreaterThan(0);
	});

	it("does not write anything when the project is already known", async () => {
		await router.resolve("/home/m/Projects/app");
		const factsAfterFirst = common.facts.length;
		const checkpointsAfterFirst = common.checkpoints;
		await router.resolve("/home/m/Projects/app");
		expect(common.facts.length).toBe(factsAfterFirst);
		expect(common.checkpoints).toBe(checkpointsAfterFirst);
	});

	it("links the path entity to the project entity", async () => {
		await router.resolve("/home/m/Projects/app");
		expect(common.edges).toContainEqual(
			expect.objectContaining({
				src: pathEntity("/home/m/Projects/app"),
				rel: IDENTIFIES,
				dst: projectEntity("aaa111"),
			}),
		);
	});

	it("refuses a path that is not in canonical stored form", async () => {
		// A native Windows path arriving here would be a second spelling of a
		// project already registered under its canonical one.
		await expect(router.resolve("C:\\Users\\m\\app")).rejects.toThrow(
			/canonical/i,
		);
		await expect(router.resolve("relative/path")).rejects.toThrow(/canonical/i);
	});
});

describe("ProjectRouter.relocate", () => {
	let common: FakeMemory;
	let router: ProjectRouter;

	beforeEach(() => {
		common = new FakeMemory();
		router = new ProjectRouter(common, { newId: fixedIds("aaa111", "bbb222") });
	});

	it("keeps the project id, so the database file is untouched", async () => {
		// This is the whole reason the router exists. Keying a database by a
		// hash of the live path means moving the folder orphans it and silently
		// starts a second, empty memory.
		const before = await router.resolve("/home/m/Projects/app");
		await router.relocate("/home/m/Projects/app", "/home/m/work/app");
		const after = await router.resolve("/home/m/work/app");
		expect(after.projectId).toBe(before.projectId);
		expect(after.created).toBe(false);
	});

	it("stops resolving the old path to the project", async () => {
		await router.resolve("/home/m/Projects/app");
		await router.relocate("/home/m/Projects/app", "/home/m/work/app");
		const stale = await router.resolve("/home/m/Projects/app");
		expect(stale.created).toBe(true);
		expect(stale.projectId).toBe("bbb222");
	});

	it("moves the identifying edge rather than adding a second one", async () => {
		await router.resolve("/home/m/Projects/app");
		await router.relocate("/home/m/Projects/app", "/home/m/work/app");
		const identifying = common.edges.filter((edge) => edge.rel === IDENTIFIES);
		expect(identifying).toHaveLength(1);
		expect(identifying[0]?.src).toBe(pathEntity("/home/m/work/app"));
	});

	it("still answers where the project used to live", async () => {
		// `revise` closes the old fact instead of deleting it, so the history
		// stays answerable — that is what bitemporality is for.
		await router.resolve("/home/m/Projects/app");
		const beforeMove = Date.now();
		await new Promise((resolve) => setTimeout(resolve, 2));
		await router.relocate("/home/m/Projects/app", "/home/m/work/app");

		expect(await router.pathOf("aaa111")).toBe("/home/m/work/app");
		expect(await router.pathOf("aaa111", beforeMove)).toBe(
			"/home/m/Projects/app",
		);
	});

	it("refuses to relocate a path it never registered", async () => {
		await expect(
			router.relocate("/home/m/nope", "/home/m/work/app"),
		).rejects.toThrow(/not registered/i);
	});

	it("refuses to relocate onto a path another project already holds", async () => {
		// Silently merging two projects' memories is unrecoverable; failing is not.
		await router.resolve("/home/m/Projects/app");
		await router.resolve("/home/m/Projects/other");
		await expect(
			router.relocate("/home/m/Projects/app", "/home/m/Projects/other"),
		).rejects.toThrow(/already/i);
	});

	it("publishes the move", async () => {
		await router.resolve("/home/m/Projects/app");
		const before = common.checkpoints;
		await router.relocate("/home/m/Projects/app", "/home/m/work/app");
		expect(common.checkpoints).toBeGreaterThan(before);
	});
});

describe("ProjectRouter.list", () => {
	it("names every known project, so the model never guesses one", async () => {
		const common = new FakeMemory();
		const router = new ProjectRouter(common, {
			newId: fixedIds("aaa111", "bbb222"),
		});
		await router.resolve("/home/m/Projects/app");
		await router.resolve("/home/m/Projects/api");

		const projects = await router.list();
		expect(projects.map((project) => project.name).sort()).toEqual([
			"api",
			"app",
		]);
		expect(projects.find((project) => project.name === "app")?.path).toBe(
			"/home/m/Projects/app",
		);
	});

	it("is empty before anything is registered", async () => {
		const router = new ProjectRouter(new FakeMemory(), {
			newId: fixedIds("aaa111"),
		});
		expect(await router.list()).toEqual([]);
	});

	it("resolves a project by name for a cross-project question", async () => {
		const router = new ProjectRouter(new FakeMemory(), {
			newId: fixedIds("aaa111", "bbb222"),
		});
		await router.resolve("/home/m/Projects/app");
		await router.resolve("/home/m/Projects/api");

		expect((await router.findByName("api"))?.projectId).toBe("bbb222");
		// An unknown name is an honest miss, never a silently empty answer.
		expect(await router.findByName("ghost")).toBeUndefined();
	});
});
