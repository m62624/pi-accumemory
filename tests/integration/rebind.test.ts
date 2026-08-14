/**
 * Moving a memory to a folder it was not made in, on the real engine.
 *
 * This is the machine-to-machine story end to end. A plugmem database is
 * portable by construction - its snapshot is byte-identical on every platform -
 * but the BINDING is a path, and a path is the one thing that does not survive
 * the trip. So a memory arrives intact and unreachable, and the only fix is a
 * person pointing at it and saying "this one is mine".
 *
 * Simulated here by opening two projects in one workspace and binding the first
 * one's memory to the second one's folder, which is exactly what the copied
 * database looks like from the router's side: a memory whose path is not this.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extensionLayout, projectDbName } from "../../src/layout.ts";
import { nodeFileOps } from "../../src/node-fs.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import { type StartedSession, startSession } from "../../src/startup.ts";

describe("rebinding a memory to this folder", () => {
	let root: string;
	let agentDir: string;
	let carried: string;
	let here: string;
	const started: StartedSession[] = [];

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "pi-accumemory-rebind-"));
		agentDir = path.join(root, "agent");
		carried = path.join(root, "carried");
		here = path.join(root, "here");
		await mkdir(path.join(carried, ".git"), { recursive: true });
		await mkdir(path.join(here, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const session of started.splice(0)) {
			try {
				session.close();
			} catch {
				// Already closed by the test itself.
			}
		}
		await rm(root, { recursive: true, force: true });
	});

	async function start(cwd: string): Promise<StartedSession> {
		const session = await startSession({
			settings: DEFAULT_SETTINGS,
			layout: extensionLayout(agentDir, path),
			fs: nodeFileOps,
			pathModule: path,
			agentDir,
			cwd,
		});
		started.push(session);
		return session;
	}

	/** A memory with something in it, closed, as if it had been copied in. */
	async function seedCarriedMemory(): Promise<string> {
		const session = await start(carried);
		await session.controller.remember({
			text: "the cache is off: it raced with the warmup",
			scope: "project",
		});
		const id = session.projectId;
		session.close();
		started.pop();
		if (id === undefined)
			throw new Error("the carried folder is not a project");
		return id;
	}

	it("hands this folder a memory that was made somewhere else", async () => {
		const carriedId = await seedCarriedMemory();

		const session = await start(here);
		const mine = session.projectId;
		expect(mine).not.toBe(carriedId);

		const outcome = await session.rebindTo(carriedId);
		expect(outcome).toMatchObject({ ok: true, projectId: carriedId });
		session.close();
		started.pop();

		// The proof: a fresh session in the same folder opens the carried memory
		// and answers out of it.
		const reopened = await start(here);
		expect(reopened.projectId).toBe(carriedId);
		expect(
			await reopened.controller.ask({ question: "cache", scope: "project" }),
		).toMatch(/warmup/);
	});

	it("lists the memory it displaced as unbound, with the path it had", async () => {
		const carriedId = await seedCarriedMemory();
		const session = await start(here);
		const displaced = session.projectId;
		await session.rebindTo(carriedId);
		session.close();
		started.pop();

		const reopened = await start(here);
		const orphan = (await reopened.rebindCandidates()).find(
			(candidate) => candidate.projectId === displaced,
		);
		expect(orphan).toMatchObject({ bound: false, path: here });
	});

	it("counts what each memory holds, so the picker shows size and not a file name", async () => {
		const carriedId = await seedCarriedMemory();
		const session = await start(here);
		const candidates = await session.rebindCandidates();

		expect(
			candidates.find((candidate) => candidate.projectId === carriedId),
		).toMatchObject({ facts: 1, bound: true, databaseExists: true });
		expect(
			candidates.find((candidate) => candidate.projectId === session.projectId),
		).toMatchObject({ facts: 0, current: true });
	});

	it("refuses when this folder's memory already holds facts", async () => {
		// Joining two memories is unrecoverable, so it is refused while they are
		// still two.
		const carriedId = await seedCarriedMemory();
		const session = await start(here);
		await session.controller.remember({
			text: "this project uses tabs",
			scope: "project",
		});

		const outcome = await session.rebindTo(carriedId);
		expect(outcome).toMatchObject({ ok: false });
		expect(outcome.ok === false && outcome.reason).toMatch(/already holds 1/i);
		expect((await start(here)).projectId).toBe(session.projectId);
	});

	it("refuses a memory whose database is not there", async () => {
		const carriedId = await seedCarriedMemory();
		const layout = extensionLayout(agentDir, path);
		await rm(
			path.join(layout.memoryDir, "db", `${projectDbName(carriedId)}.plugmem`),
		);

		const session = await start(here);
		const outcome = await session.rebindTo(carriedId);
		expect(outcome).toMatchObject({ ok: false });
		expect(outcome.ok === false && outcome.reason).toMatch(/nothing to bind/i);
	});

	it("deletes an unbound memory: its files, its notes and its place in the list", async () => {
		const carriedId = await seedCarriedMemory();
		const session = await start(here);
		const displaced = session.projectId ?? "";
		await session.rebindTo(carriedId);
		session.close();
		started.pop();

		// After the reopen nothing holds the displaced database, which is what
		// makes deleting it work at all.
		const reopened = await start(here);
		const deleted = await reopened.deleteMemory(displaced);
		expect(deleted.ok).toBe(true);

		const layout = extensionLayout(agentDir, path);
		expect(
			await nodeFileOps.exists(
				path.join(
					layout.memoryDir,
					"db",
					`${projectDbName(displaced)}.plugmem`,
				),
			),
		).toBe(false);
		expect(
			(await reopened.rebindCandidates()).map(
				(candidate) => candidate.projectId,
			),
		).not.toContain(displaced);
	});

	it("will not delete a memory a folder is using", async () => {
		const session = await start(here);
		const mine = session.projectId ?? "";
		const outcome = await session.deleteMemory(mine);
		expect(outcome).toMatchObject({ ok: false });
		expect(outcome.ok === false && outcome.reason).toMatch(/only a memory/i);
	});

	it("says so plainly when there is nothing here to rebind", async () => {
		// A directory with no project marker has no project memory at all, so
		// there is no binding to change - and saying that beats a stack trace.
		const loose = path.join(root, "loose");
		await mkdir(loose, { recursive: true });
		const carriedId = await seedCarriedMemory();

		const session = await start(loose);
		const outcome = await session.rebindTo(carriedId);
		expect(outcome).toMatchObject({ ok: false });
		expect(outcome.ok === false && outcome.reason).toMatch(/not a project/i);
	});

	it("refuses the memory this folder already uses, and one it never heard of", async () => {
		const session = await start(here);
		const mine = session.projectId ?? "";
		expect(await session.rebindTo(mine)).toMatchObject({ ok: false });
		expect(await session.rebindTo("no-such-id")).toMatchObject({ ok: false });
		expect(await session.deleteMemory("no-such-id")).toMatchObject({
			ok: false,
		});
	});
});
