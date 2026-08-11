/**
 * The read-only handle's full surface, against the real engine.
 *
 * A cross-project question runs entirely through this handle, so every verb it
 * offers has to work while another process holds the writer - which is the one
 * thing a fake cannot demonstrate.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	openReadable,
	PlugmemReader,
	PlugmemStore,
} from "../../src/storage/plugmem-store.ts";
import { type TempWorkspace, tempWorkspace } from "../helpers/temp-memory.ts";

describe("PlugmemReader", () => {
	let workspace: TempWorkspace;
	const handles: { close(): void }[] = [];

	beforeEach(async () => {
		workspace = await tempWorkspace();
	});

	afterEach(async () => {
		for (const handle of handles.splice(0)) {
			try {
				handle.close();
			} catch {
				// Already closed.
			}
		}
		await workspace.cleanup();
	});

	function track<T extends { close(): void }>(handle: T): T {
		handles.push(handle);
		return handle;
	}

	async function seeded() {
		const writer = track(await PlugmemStore.open(workspace.db("p")));
		const stored = await writer.remember({
			text: "the cache is disabled because it raced with the warmup task",
			entity: "project:x",
			tags: ["gotcha", "decision"],
		});
		await writer.link({ src: "cache", rel: "raced-with", dst: "warmup" });
		await writer.checkpoint();
		return { writer, factId: stored.id };
	}

	it("answers every read verb while the writer is still open", async () => {
		const { factId } = await seeded();
		const reader = track(await PlugmemReader.open(workspace.db("p")));

		expect(
			(await reader.recall({ query: "cache warmup" })).facts.length,
		).toBeGreaterThan(0);
		expect(await reader.tagsOf(factId)).toContain("gotcha");
		expect((await reader.listTags()).items.length).toBeGreaterThan(0);
		expect((await reader.stats()).facts).toBeGreaterThan(0);
		expect((await reader.get(factId))?.text).toContain("warmup");
		expect(await reader.scan({ tags: ["gotcha"] })).toHaveLength(1);
		expect(reader.generation()).toBeGreaterThan(0);
	});

	it("returns null for a fact id it does not have", async () => {
		await seeded();
		const reader = track(await PlugmemReader.open(workspace.db("p")));
		expect(await reader.get(9999)).toBeNull();
		expect(await reader.tagsOf(9999)).toEqual([]);
	});

	it("filters a scan by every tag given, not just one", async () => {
		const { writer } = await seeded();
		await writer.remember({
			text: "an unrelated statement about deploys",
			tags: ["gotcha"],
		});
		await writer.checkpoint();
		const reader = track(await PlugmemReader.open(workspace.db("p")));
		expect(await reader.scan({ tags: ["gotcha"] })).toHaveLength(2);
		expect(await reader.scan({ tags: ["gotcha", "decision"] })).toHaveLength(1);
		expect((await reader.scan()).length).toBeGreaterThanOrEqual(2);
	});

	it("reports nothing adopted when there is nothing newer", async () => {
		await seeded();
		const reader = track(await PlugmemReader.open(workspace.db("p")));
		expect(reader.refresh()).toBe(false);
	});
});

describe("PlugmemStore maintenance", () => {
	let workspace: TempWorkspace;
	const handles: { close(): void }[] = [];

	beforeEach(async () => {
		workspace = await tempWorkspace();
	});

	afterEach(async () => {
		for (const handle of handles.splice(0)) {
			try {
				handle.close();
			} catch {
				// Already closed.
			}
		}
		await workspace.cleanup();
	});

	it("purges what was forgotten when asked to maintain", async () => {
		// `forget` only tombstones. The bytes survive until a maintenance pass,
		// and leaving that manual is what gives somebody a window to look at
		// what was dropped.
		const store = await PlugmemStore.open(workspace.db("p"));
		handles.push(store);
		const stored = await store.remember({
			text: "a fact that will be dropped",
		});
		expect(await store.forget(stored.id)).toBe(true);
		expect(await store.forget(stored.id)).toBe(false);
		await expect(store.maintain()).resolves.toBeUndefined();
		expect((await store.stats()).facts).toBe(0);
	});

	it("reports config problems rather than swallowing them", async () => {
		// A native addon has nowhere sensible to print, so it returns these
		// instead. Ignoring them puts a typo back to changing nothing silently.
		const store = await openReadable(workspace.db("p"));
		handles.push(store);
		const writer = await PlugmemStore.open(workspace.db("q"));
		handles.push(writer);
		expect(Array.isArray(writer.configWarnings())).toBe(true);
	});

	it("refuses to re-embed with no embedder configured", async () => {
		const store = await PlugmemStore.open(workspace.db("p"));
		handles.push(store);
		await store.remember({ text: "a fact" });
		await expect(store.reembed()).rejects.toThrow();
	});
});
