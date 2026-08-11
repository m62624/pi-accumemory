import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectRouter } from "../../src/router/router.ts";
import {
	CommonStore,
	type LeasedWriter,
} from "../../src/storage/common-store.ts";
import { needsCheckpoint } from "../../src/storage/errors.ts";
import {
	openReadable,
	PlugmemReader,
	PlugmemStore,
} from "../../src/storage/plugmem-store.ts";
import { type TempWorkspace, tempWorkspace } from "../helpers/temp-memory.ts";

describe("plugmem adapter, against the real engine", () => {
	let workspace: TempWorkspace;
	const openHandles: { close(): void }[] = [];

	beforeEach(async () => {
		workspace = await tempWorkspace();
	});

	afterEach(async () => {
		for (const handle of openHandles.splice(0)) {
			try {
				handle.close();
			} catch {
				// Already closed by the test; nothing to do.
			}
		}
		await workspace.cleanup();
	});

	function track<T extends { close(): void }>(handle: T): T {
		openHandles.push(handle);
		return handle;
	}

	it("stores and recalls a fact", async () => {
		const store = track(await PlugmemStore.open(workspace.db("p")));
		const stored = await store.remember({
			text: "the cache is disabled because it raced with the warmup task",
			entity: "project:x",
			tags: ["gotcha"],
		});
		const found = await store.recall({ query: "cache warmup race" });
		expect(found.facts.map((fact) => fact.id)).toContain(stored.id);
		expect(found.rendered).toContain("warmup");
	});

	it("hands out fact ids starting at zero", async () => {
		// Load-bearing: any code testing an id for truthiness silently loses
		// the oldest fact in every database.
		const store = track(await PlugmemStore.open(workspace.db("p")));
		const first = await store.remember({ text: "the first fact" });
		expect(first.id).toBe(0);
		expect(await store.get(0)).not.toBeNull();
	});

	it("rejects a read-only open of a database with no published snapshot", async () => {
		// The branch that decides whether a clean machine can start at all.
		await expect(PlugmemReader.open(workspace.db("fresh"))).rejects.toSatisfy(
			needsCheckpoint,
		);
	});

	it("openReadable creates and publishes one instead of failing", async () => {
		const reader = track(await openReadable(workspace.db("fresh")));
		expect(reader.generation()).toBeGreaterThan(0);
		expect((await reader.stats()).facts).toBe(0);
	});

	it("lets a reader and a writer hold the same database at once", async () => {
		// This is what makes several pi sessions on one machine possible, and
		// what makes asking another project's memory safe while it is in use.
		const writer = track(await PlugmemStore.open(workspace.db("p")));
		await writer.remember({
			text: "tests run under vitest",
			entity: "project:x",
		});
		await writer.checkpoint();

		const reader = track(await PlugmemReader.open(workspace.db("p")));
		expect((await reader.recall({ query: "vitest" })).facts).toHaveLength(1);

		// The writer is still live and still writable with the reader attached.
		await expect(
			writer.remember({ text: "another fact" }),
		).resolves.toBeDefined();
	});

	it("hides an unpublished write from a reader until it refreshes", async () => {
		const writer = track(await PlugmemStore.open(workspace.db("p")));
		await writer.remember({ text: "first" });
		await writer.checkpoint();
		const reader = track(await PlugmemReader.open(workspace.db("p")));

		await writer.remember({ text: "the second fact mentions biome" });
		await writer.checkpoint();
		expect((await reader.recall({ query: "biome" })).facts).toHaveLength(0);
		expect(reader.refresh()).toBe(true);
		expect((await reader.recall({ query: "biome" })).facts).toHaveLength(1);
	});

	it("refuses a second writer, and says why", async () => {
		track(await PlugmemStore.open(workspace.db("p")));
		await expect(PlugmemStore.open(workspace.db("p"))).rejects.toThrow(
			/locked/i,
		);
	});

	it("closes a revision instead of overwriting it", async () => {
		const store = track(await PlugmemStore.open(workspace.db("p")));
		const original = await store.remember({
			text: "the project lives at /home/m/app",
			entity: "path:x",
		});
		await new Promise((done) => setTimeout(done, 5));
		const asOfBefore = Date.now();
		await new Promise((done) => setTimeout(done, 5));
		await store.revise(original.id, {
			text: "the project lives at /home/m/work/app",
			entity: "path:x",
		});

		const now = await store.recall({ entities: ["path:x"] });
		expect(now.rendered).toContain("work/app");
		const then = await store.recall({ entities: ["path:x"], asOf: asOfBefore });
		expect(then.rendered).toContain("/home/m/app");
	});

	it("blocks a guarded write of something it already holds", async () => {
		const store = track(await PlugmemStore.open(workspace.db("p")));
		const text =
			"formatting in this repository is done with biome, not prettier";
		await store.remember({ text, entity: "project:x" });
		const second = await store.rememberGuarded({ text, entity: "project:x" });
		expect(second.status).toBe("blocked");
	});

	it("counts tags for the manifest", async () => {
		const store = track(await PlugmemStore.open(workspace.db("p")));
		await store.remember({ text: "one decision", tags: ["decision"] });
		await store.remember({ text: "another decision", tags: ["decision"] });
		await store.remember({ text: "a gotcha", tags: ["gotcha"] });
		const page = await store.listTags();
		expect(page.items).toContainEqual({ name: "decision", count: 2 });
	});

	it("works with no embedder at all", async () => {
		// Degrading to lexical, graph and time retrieval is a supported mode,
		// not a broken one - a machine with no embedding service still works.
		const store = track(await PlugmemStore.open(workspace.db("p"), { dim: 0 }));
		await store.remember({ text: "biome is the formatter here" });
		expect(
			(await store.recall({ query: "biome formatter" })).facts,
		).toHaveLength(1);
	});
});

describe("the router, against the real engine", () => {
	let workspace: TempWorkspace;
	const openHandles: { close(): void }[] = [];

	beforeEach(async () => {
		workspace = await tempWorkspace();
	});

	afterEach(async () => {
		for (const handle of openHandles.splice(0)) {
			try {
				handle.close();
			} catch {
				// Already closed.
			}
		}
		await workspace.cleanup();
	});

	async function commonStore(): Promise<CommonStore> {
		const path = workspace.db("common");
		const reader = await openReadable(path);
		openHandles.push(reader);
		return new CommonStore(reader, async () => {
			const writer = await PlugmemStore.open(path);
			return writer as unknown as LeasedWriter;
		});
	}

	it("resolves the same project twice to the same id", async () => {
		const common = await commonStore();
		const router = new ProjectRouter(common);
		const first = await router.resolve("/home/m/Projects/app");
		expect(first.created).toBe(true);
		const second = await router.resolve("/home/m/Projects/app");
		expect(second).toEqual({ projectId: first.projectId, created: false });
	});

	it("does not confuse paths sharing a prefix, on the real index", async () => {
		// The reason routes are entity lookups and not text search. BM25 would
		// rank these two nearly identically - they differ by one token.
		const common = await commonStore();
		const router = new ProjectRouter(common);
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

	it("keeps the project id across a move, and remembers the old path", async () => {
		const common = await commonStore();
		const router = new ProjectRouter(common);
		const before = await router.resolve("/home/m/Projects/app");
		await new Promise((done) => setTimeout(done, 5));
		const beforeMove = Date.now();
		await new Promise((done) => setTimeout(done, 5));

		await router.relocate("/home/m/Projects/app", "/home/m/work/app");
		expect((await router.resolve("/home/m/work/app")).projectId).toBe(
			before.projectId,
		);
		expect(await router.pathOf(before.projectId)).toBe("/home/m/work/app");
		expect(await router.pathOf(before.projectId, beforeMove)).toBe(
			"/home/m/Projects/app",
		);
	});

	it("lists projects for a cross-project question", async () => {
		const common = await commonStore();
		const router = new ProjectRouter(common);
		await router.resolve("/home/m/Projects/app");
		await router.resolve("/home/m/Projects/api");
		expect((await router.list()).map((project) => project.name).sort()).toEqual(
			["api", "app"],
		);
		expect(await router.findByName("api")).toBeDefined();
		expect(await router.findByName("ghost")).toBeUndefined();
	});
});
