/**
 * Bringing a real session up on a real engine, in a temporary directory.
 *
 * The point is the startup path specifically: a clean machine, a directory that
 * is not a project, a second session on the same project. Each of those is a
 * place where the extension could plausibly refuse to start, and the whole
 * philosophy here is that it must not.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extensionLayout, projectDbName } from "../../src/layout.ts";
import { nodeFileOps } from "../../src/node-fs.ts";
import {
	DEFAULT_SETTINGS,
	type Settings,
} from "../../src/settings/defaults.ts";
import { type StartedSession, startSession } from "../../src/startup.ts";
import { PlugmemStore } from "../../src/storage/plugmem-store.ts";
import { reembedSummary } from "../../src/ui/reembed-progress.ts";
import {
	type StubEmbedder,
	startStubEmbedder,
} from "../helpers/stub-embedder.ts";

function settingsWith(patch: (draft: Settings) => void): Settings {
	const draft = structuredClone(DEFAULT_SETTINGS);
	patch(draft);
	return draft;
}

describe("startSession", () => {
	let root: string;
	let agentDir: string;
	let project: string;
	let embedder: StubEmbedder | undefined;
	const started: StartedSession[] = [];
	const extra: { close(): void }[] = [];

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "pi-accumemory-start-"));
		agentDir = path.join(root, "agent");
		project = path.join(root, "app");
		await mkdir(path.join(project, ".git"), { recursive: true });
	});

	/** Settings pointing at a stub embedding service started on demand. */
	async function embedding(): Promise<Settings> {
		embedder ??= await startStubEmbedder();
		const service = embedder;
		return settingsWith((draft) => {
			draft.memory.embedder.enabled = true;
			draft.memory.embedder.url = service.url;
			draft.memory.embedder.model = "stub";
			draft.memory.embedder.dim = service.dim;
		});
	}

	afterEach(async () => {
		for (const session of started.splice(0)) session.close();
		await embedder?.close();
		embedder = undefined;
		for (const handle of extra.splice(0)) {
			try {
				handle.close();
			} catch {
				// Already closed.
			}
		}
		await rm(root, { recursive: true, force: true });
	});

	async function start(
		cwd: string,
		settings = DEFAULT_SETTINGS,
	): Promise<StartedSession> {
		const session = await startSession({
			settings,
			layout: extensionLayout(agentDir, path),
			fs: nodeFileOps,
			pathModule: path,
			agentDir,
			cwd,
		});
		started.push(session);
		return session;
	}

	it("starts on a completely clean machine", async () => {
		// The database has no published snapshot yet, which a read-only open
		// rejects outright. Without the checkpoint fallback the very first
		// session anyone runs fails, before any project is even resolved.
		const session = await start(project);
		expect(session.projectId).toBeDefined();
		expect(session.projectRoot).toBe(project);
	});

	it("writes the plugmem config and the instruction defaults", async () => {
		await start(project);
		const layout = extensionLayout(agentDir, path);
		expect(await nodeFileOps.readFile(layout.configToml)).toContain("[engine]");
		expect(
			await nodeFileOps.readFile(
				path.join(layout.instructionsDefaultsDir, "secrets.md"),
			),
		).toMatch(/never store/i);
	});

	it("gives the same project the same id on the next session", async () => {
		const first = await start(project);
		first.close();
		started.pop();
		const second = await start(project);
		expect(second.projectId).toBe(first.projectId);
	});

	it("creates no project database outside a project", async () => {
		// One database per visited directory turns the workspace into a
		// junkyard, and each junk file then has to be explained to somebody.
		const session = await start(root);
		expect(session.projectId).toBeUndefined();
		expect(session.notices.join(" ")).toMatch(/not a project/i);
	});

	it("runs without project memory when another session holds it", async () => {
		const first = await start(project);
		const layout = extensionLayout(agentDir, path);
		expect(first.projectId).toBeDefined();

		// A second session in the same project: the project writer is taken.
		const second = await startSession({
			settings: DEFAULT_SETTINGS,
			layout,
			fs: nodeFileOps,
			pathModule: path,
			agentDir,
			cwd: project,
		});
		started.push(second);
		expect(second.notices.join(" ")).toMatch(/another session/i);
		// The shared memory still answers, which is the point of the read-only
		// handle: it takes a shared lock and blocks nobody.
		await expect(second.controller.projects()).resolves.toContain("app");
	});

	it("stores a fact and finds it again in a new session", async () => {
		const first = await start(project);
		await first.controller.remember({
			text: "the cache is off because of a warmup race",
		});
		first.close();
		started.pop();

		const second = await start(project);
		expect(
			await second.controller.ask({ question: "why is the cache off" }),
		).toContain("warmup");
	});

	it("keeps a fact about the user visible from a different project", async () => {
		const other = path.join(root, "other");
		await mkdir(path.join(other, ".git"), { recursive: true });

		const first = await start(project);
		await first.controller.remember({
			text: "prefers Rust for systems work",
			scope: "user",
		});
		first.close();
		started.pop();

		const second = await start(other);
		expect(
			await second.controller.ask({
				question: "which language for systems work",
				scope: "user",
			}),
		).toContain("Rust");
	});

	it("answers a question put to another project, while it is open", async () => {
		const api = path.join(root, "api");
		await mkdir(path.join(api, ".git"), { recursive: true });

		const apiSession = await start(api);
		await apiSession.controller.remember({
			text: "auth here uses a signed cookie rather than a JWT",
		});
		const apiId = apiSession.projectId;
		expect(apiId).toBeDefined();

		// Deliberately left OPEN: a cross-project question has to work while
		// somebody is working in that project, and it does because the reader
		// takes a shared lock.
		const appSession = await start(project);
		const answer = await appSession.controller.askProject(
			"api",
			"how is auth done",
		);
		expect(answer).toContain("signed cookie");
	});

	it("reports an unknown project rather than answering emptily", async () => {
		const session = await start(project);
		const answer = await session.controller.askProject("ghost", "anything");
		expect(answer).toMatch(/no project named "ghost"/i);
	});

	it("says the embedder is off, once", async () => {
		const session = await start(project);
		expect(session.notices.join(" ")).toMatch(/embedder is off/i);
	});

	it("still has a consolidation pass outside a project", async () => {
		// It used to refuse, on the reasoning that there was nothing to resume
		// from - which was simply wrong: pi keys the transcript directory by
		// WORKING DIRECTORY, not by project. What a non-project directory lacks
		// is a project memory, so the pass curates the shared memory about the
		// user and nothing else. That is the right answer rather than a
		// degraded one; there is no codebase there to hold facts about.
		const session = await start(root);
		expect(session.projectId).toBeUndefined();
		expect(session.consolidation).toBeDefined();
		expect(session.consolidationQuietMs).toBeGreaterThan(0);
	});

	it("disables the idle timer when consolidation is switched off", async () => {
		const session = await start(
			project,
			settingsWith((draft) => {
				draft.memory.consolidation.enabled = false;
			}),
		);
		expect(session.consolidationQuietMs).toBe(0);
	});

	it("says there is nothing to rebuild when no embedder is configured", async () => {
		// Better than the engine's own error, which arrives after the command
		// has already told the user it started.
		const session = await start(project);
		const result = await session.reembed();
		expect(result.blocked).toMatch(/no embedder configured/i);
		expect(result.steps).toEqual([]);
	});

	it("refuses an embedder that plugmem would refuse, before opening anything", async () => {
		await expect(
			start(
				project,
				settingsWith((draft) => {
					draft.memory.embedder.enabled = true;
					draft.memory.embedder.url = "";
				}),
			),
		).rejects.toThrow(/memory\.embedder\.url/);
	});

	it("prefers a project-local instruction append over the global one", async () => {
		const layout = extensionLayout(agentDir, path);
		await mkdir(layout.instructionsAppendDir, { recursive: true });
		await writeFile(
			path.join(layout.instructionsAppendDir, "memory.md"),
			"global text",
		);
		const projectAppend = path.join(
			project,
			".pi",
			"pi-accumemory",
			"instructions",
			"append",
		);
		await mkdir(projectAppend, { recursive: true });
		await writeFile(path.join(projectAppend, "memory.md"), "project text");

		const session = await start(project);
		const text = await session.instructions.read("memory");
		expect(text).toContain("project text");
		expect(text).not.toContain("global text");
	});

	it("leaves an existing database openable by a plain writer afterwards", async () => {
		// Nothing here holds a lock it does not release, which is what lets the
		// CLI be used for debugging between sessions.
		const session = await start(project);
		const id = session.projectId ?? "";
		session.close();
		started.pop();

		const layout = extensionLayout(agentDir, path);
		const writer = await PlugmemStore.open(
			path.join(layout.memoryDir, "db", `${projectDbName(id)}.plugmem`),
		);
		extra.push(writer);
		await expect(writer.stats()).resolves.toBeDefined();
	});

	it("re-embeds its own project without colliding with itself", async () => {
		// The session holds the writer for its own project for as long as it
		// runs. A rebuild that opens a second writer on that same file is
		// refused by the engine, and the message it produces - "locked by
		// another process" - names this very session as the other process.
		// No embedder needs to answer for this: with nothing stored there is
		// nothing to send, and the lock is taken before any of that.
		const session = await start(project, await embedding());
		let updates = 0;
		const { steps } = await session.reembed(() => {
			updates += 1;
		});
		expect(steps.map((step) => step.state)).toEqual(["done", "done"]);
		// A person watching needs to see it move, so every database reports
		// twice: once when it starts and once when it ends.
		expect(updates).toBe(4);
		expect(reembedSummary(steps)).toBe("Rebuilt 2 of 2 memories.");
	});

	it("names the databases the way a person names them", async () => {
		// `p_dd21d9ddb1fa` identifies a file to the engine and nothing to the
		// person reading which memory was skipped.
		const session = await start(project, await embedding());
		const { steps } = await session.reembed();
		expect(steps.map((step) => step.label)).toEqual([
			"shared memory about you",
			"app",
		]);
	});

	it("rebuilds the rest when one database is held by somebody else", async () => {
		// A workspace answering from two vector spaces at once is the failure
		// this reports rather than hides.
		const other = path.join(root, "other");
		await mkdir(path.join(other, ".git"), { recursive: true });

		await start(other, await embedding());
		const session = await start(project, await embedding());
		const { steps } = await session.reembed();
		expect(steps.filter((step) => step.state === "done")).toHaveLength(2);

		const summary = reembedSummary(steps);
		// Named by its folder, and told what to do about it. A skipped database
		// is the one thing here nothing else will ever mention again.
		expect(summary).toContain("Rebuilt 2 of 3");
		expect(summary).toContain("other");
		expect(summary).toMatch(/another pi session has it open/i);
		expect(summary).toContain("/longterm-reembed");
	});

	it("stores a repeated fact once, even when nothing named an entity", async () => {
		// The duplicate guard compares a new fact against the recent facts of
		// the entity it names. A fact naming none is compared against nothing,
		// so an unqualified guarded write silently degrades into an unguarded
		// one - which is how six identical calls produced six facts.
		const session = await start(project);
		const text = "the cache is off because it raced with the warmup task";
		expect(await session.controller.remember({ text })).toMatch(/Stored \[f/);
		for (let attempt = 0; attempt < 3; attempt += 1) {
			expect(await session.controller.remember({ text })).toMatch(
				/already holds this/i,
			);
		}
	});

	it("never lets the engine write without a duplicate check", async () => {
		// plugmem's detector is scoped to the fact's entity, and a write naming
		// none is stored with no check at all - which is how one sentence ended
		// up stored six times. Since 0.10.0 the engine says which of the two
		// happened, so this asserts the thing that actually protects us: every
		// write from here names an entity, on both scopes.
		const session = await start(project);
		for (const scope of ["project", "user"] as const) {
			const answer = await session.controller.remember({
				text: `a durable fact about ${scope}`,
				scope,
			});
			expect(answer, scope).toMatch(/Stored \[f/);
			expect(answer, scope).not.toMatch(/without a duplicate check/i);
		}
	});

	it("guards a repeated fact about the user the same way", async () => {
		const session = await start(project);
		const text = "prefers Rust for systems work";
		expect(await session.controller.remember({ text, scope: "user" })).toMatch(
			/Stored \[f/,
		);
		expect(await session.controller.remember({ text, scope: "user" })).toMatch(
			/already holds this/i,
		);
	});
});
