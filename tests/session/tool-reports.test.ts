/**
 * That every tool actually files a report, not just that reports render.
 *
 * The renderer is a total function over the union, so the compiler already
 * guarantees a line exists for each kind. What it cannot guarantee is that the
 * tool bothers to file one - and a tool that files nothing falls back to
 * printing the model's own answer, which is the behaviour this whole channel
 * was built to replace. That failure is silent, so it is tested here.
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
	const tools = longtermTools(controller);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool === undefined) throw new Error(`no tool ${name}`);
		const text = await tool.run(args);
		return { text, report: controller.takeLastReport() };
	};
	return { controller, project, call };
}

describe("what each tool files", () => {
	it("a write, with the text that was stored", async () => {
		const { call } = build();
		const { report } = await call("longterm_remember", {
			text: "the linter here is biome",
		});
		expect(report?.kind).toBe("write");
		if (report?.kind !== "write") throw new Error("expected a write");
		expect(report.write.text).toBe("the linter here is biome");
	});

	it("a revision, with both wordings", async () => {
		const { call } = build();
		await call("longterm_remember", { text: "the cache is off" });
		const { report } = await call("longterm_revise", {
			id: 0,
			text: "the cache is on again",
			scope: "project",
		});
		if (report?.kind !== "revise") throw new Error("expected a revision");
		expect(report.before).toBe("the cache is off");
		expect(report.after).toBe("the cache is on again");
	});

	it("a forget, with the text read BEFORE the fact was closed", async () => {
		// The only moment it can be read at all. Afterwards the fact is gone
		// from recall, and nothing could reconstruct what it said.
		const { call } = build();
		await call("longterm_remember", { text: "a fact worth dropping" });
		const { report } = await call("longterm_forget", {
			id: 0,
			scope: "project",
		});
		if (report?.kind !== "forget") throw new Error("expected a forget");
		expect(report.forgot).toEqual([{ id: 0, text: "a fact worth dropping" }]);
		expect(report.absent).toEqual([]);
	});

	it("a forget that found nothing, so the terminal can say so", async () => {
		const { call } = build();
		const { report } = await call("longterm_forget_many", {
			ids: [42],
			scope: "project",
		});
		if (report?.kind !== "forget") throw new Error("expected a forget");
		expect(report.forgot).toEqual([]);
		expect(report.absent).toEqual([42]);
	});

	it("a question, counted", async () => {
		const { call } = build();
		await call("longterm_remember", { text: "the cache is off" });
		const { report } = await call("longterm_ask", { question: "the cache" });
		if (report?.kind !== "ask") throw new Error("expected an ask");
		expect(report.question).toBe("the cache");
		expect(report.found).toBeGreaterThan(0);
	});

	it("a question about both memories, labelled as such", async () => {
		const { call } = build();
		const { report } = await call("longterm_ask", {
			question: "anything",
			scope: "both",
		});
		if (report?.kind !== "ask") throw new Error("expected an ask");
		expect(report.label).toBe("both memories");
	});

	it("the project list", async () => {
		const { call } = build();
		const { report } = await call("longterm_projects");
		expect(report?.kind).toBe("projects");
	});

	it("the tag list", async () => {
		const { call } = build();
		await call("longterm_remember", { text: "a fact", tags: ["decision"] });
		const { report } = await call("longterm_tags", { scope: "project" });
		if (report?.kind !== "tags") throw new Error("expected tags");
		expect(report.count).toBeGreaterThan(0);
	});

	it("a link, and an unlink", async () => {
		const { call } = build();
		const linked = await call("longterm_link", {
			src: "api",
			rel: "depends-on",
			dst: "db",
		});
		if (linked.report?.kind !== "link") throw new Error("expected a link");
		expect(linked.report.undone).toBe(false);
		const unlinked = await call("longterm_unlink", {
			src: "api",
			rel: "depends-on",
			dst: "db",
		});
		if (unlinked.report?.kind !== "link") throw new Error("expected a link");
		expect(unlinked.report.undone).toBe(true);
	});

	it("nothing for an unlink that removed nothing", async () => {
		const { call } = build();
		const { report } = await call("longterm_unlink", {
			src: "api",
			rel: "depends-on",
			dst: "db",
		});
		expect(report).toBeUndefined();
	});

	it("each of the four note actions", async () => {
		const { call } = build();
		const created = await call("longterm_note_create", {
			title: "layout",
			content: "a body long enough to be a note",
		});
		if (created.report?.kind !== "note") throw new Error("expected a note");
		expect(created.report.action).toBe("created");
		const noteId = created.report.noteId;

		const read = await call("longterm_note_read", { note_id: noteId });
		if (read.report?.kind !== "note") throw new Error("expected a note");
		expect(read.report.action).toBe("read");
		// The body reaches the model and stops there.
		expect(read.text).toContain("a body long enough to be a note");
		expect(read.report.chars).toBeGreaterThan(0);

		const updated = await call("longterm_note_update", {
			note_id: noteId,
			content: "a different body",
		});
		if (updated.report?.kind !== "note") throw new Error("expected a note");
		expect(updated.report.action).toBe("updated");

		const deleted = await call("longterm_note_delete", { note_id: noteId });
		if (deleted.report?.kind !== "note") throw new Error("expected a note");
		expect(deleted.report.action).toBe("deleted");
	});

	it("nothing for a note that is not there", async () => {
		const { call } = build();
		expect((await call("longterm_note_read", { note_id: "n9" })).report).toBe(
			undefined,
		);
		expect((await call("longterm_note_delete", { note_id: "n9" })).report).toBe(
			undefined,
		);
	});

	it("which about page was read, and how big it was", async () => {
		const { call } = build();
		const { report, text } = await call("longterm_about", { topic: "scopes" });
		if (report?.kind !== "about") throw new Error("expected an about");
		expect(report.topic).toBe("scopes");
		expect(report.chars).toBe(text.length);
	});
});

describe("what a refusal files", () => {
	it("nothing, so the model's own wording reaches the terminal", async () => {
		// A refusal is written to be read: it names what went wrong and what to
		// do instead, and a person seeing the same words sees the same problem.
		const { call } = build();
		await call("longterm_remember", { text: "the linter here is biome" });
		const { report } = await call("longterm_remember", {
			text: "the linter here is biome",
		});
		expect(report).toBeUndefined();
	});

	it("nothing when a forget arrives without a scope", async () => {
		const { call } = build();
		const { report } = await call("longterm_forget", { id: 0 });
		expect(report).toBeUndefined();
	});
});
