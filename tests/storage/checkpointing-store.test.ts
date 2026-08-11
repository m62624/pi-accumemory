import { describe, expect, it } from "vitest";
import { CheckpointingStore } from "../../src/storage/checkpointing-store.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

describe("CheckpointingStore", () => {
	it("publishes after every write", async () => {
		// A project database written but never checkpointed cannot be opened
		// read-only from anywhere - which is exactly what a cross-project
		// question does, and it fails outright rather than answering emptily.
		const inner = new FakeMemory();
		const store = new CheckpointingStore(inner);
		await store.remember({ text: "a fact" });
		expect(inner.checkpoints).toBe(1);
		await store.rememberGuarded({ text: "a different fact entirely" });
		expect(inner.checkpoints).toBe(2);
	});

	it("publishes after a revision, a forget and a link", async () => {
		const inner = new FakeMemory();
		const store = new CheckpointingStore(inner);
		const stored = await store.remember({ text: "the linter is eslint" });
		const revised = await store.revise(stored.id, {
			text: "the linter is biome",
		});
		await store.forget(revised.id);
		await store.link({ src: "a", rel: "needs", dst: "b" });
		await store.unlink({ src: "a", rel: "needs", dst: "b" });
		expect(inner.checkpoints).toBe(5);
	});

	it("does not publish on a read", async () => {
		const inner = new FakeMemory();
		const store = new CheckpointingStore(inner);
		await store.recall({ query: "anything" });
		await store.scan();
		await store.get(0);
		await store.tagsOf(0);
		await store.listTags();
		await store.stats();
		expect(inner.checkpoints).toBe(0);
	});

	it("still reports the write when publishing fails", async () => {
		// The fact IS stored at that point. Reporting a failure would tell the
		// model to store it again, turning a visibility problem into a
		// duplicate.
		const inner = new FakeMemory();
		inner.checkpoint = async () => {
			throw new Error("disk full");
		};
		const store = new CheckpointingStore(inner);
		await expect(store.remember({ text: "a fact" })).resolves.toBeDefined();
		expect(inner.live()).toHaveLength(1);
	});

	it("lets a caller publish explicitly", async () => {
		const inner = new FakeMemory();
		await new CheckpointingStore(inner).checkpoint();
		expect(inner.checkpoints).toBe(1);
	});

	it("passes a write failure through untouched", async () => {
		const inner = new FakeMemory();
		inner.failNextWrite = new Error("locked");
		await expect(
			new CheckpointingStore(inner).remember({ text: "x" }),
		).rejects.toThrow("locked");
	});
});
