/**
 * Which folder gets a memory, decided on a real filesystem and a real engine.
 *
 * The rules are cheap to state and easy to get subtly wrong, and every mistake
 * here is silent: facts land in a memory nobody looks at, or in the shared one
 * where they follow the user into every other project. So the two passes are
 * exercised end to end - an existing binding beats a marker, a nearer binding
 * beats a farther one, and a folder nobody claimed has no memory at all until
 * somebody asks for one.
 */

import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extensionLayout } from "../../src/layout.ts";
import { nodeFileOps } from "../../src/node-fs.ts";
import {
	DEFAULT_SETTINGS,
	type Settings,
} from "../../src/settings/defaults.ts";
import { type StartedSession, startSession } from "../../src/startup.ts";

function settingsWith(patch: (draft: Settings) => void): Settings {
	const draft = structuredClone(DEFAULT_SETTINGS);
	patch(draft);
	return draft;
}

describe("finding this folder's memory", () => {
	let root: string;
	let agentDir: string;
	let repo: string;
	const started: StartedSession[] = [];

	beforeEach(async () => {
		// `realpath` because macOS hands out `/var/...` and resolves it to
		// `/private/var/...`, and the search resolves before it compares - a test
		// asserting on the unresolved name would fail there and only there.
		root = await nodeFileOps.realPath(
			await mkdtemp(path.join(tmpdir(), "pi-accumemory-locate-")),
		);
		agentDir = path.join(root, "agent");
		repo = path.join(root, "repo");
		await mkdir(path.join(repo, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const session of started.splice(0)) {
			try {
				session.close();
			} catch {
				// Already closed by the test.
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

	/** Runs a session, keeps what it decided, and closes it again. */
	async function once<T>(
		cwd: string,
		read: (session: StartedSession) => T | Promise<T>,
		settings = DEFAULT_SETTINGS,
	): Promise<T> {
		const session = await start(cwd, settings);
		const value = await read(session);
		session.close();
		started.pop();
		return value;
	}

	it("gives a subfolder the memory of the project above it", async () => {
		const deep = path.join(repo, "src", "storage");
		await mkdir(deep, { recursive: true });

		const atRoot = await once(repo, (s) => s.projectId);
		const inside = await once(deep, (s) => ({
			id: s.projectId,
			root: s.projectRoot,
		}));
		expect(inside.id).toBe(atRoot);
		expect(inside.root).toBe(repo);
	});

	it("leaves a folder with no marker without a memory of its own", async () => {
		const loose = path.join(root, "notes");
		await mkdir(loose, { recursive: true });
		expect(await once(loose, (s) => s.projectId)).toBeUndefined();
	});

	it("takes the marker list from the settings", async () => {
		const rusty = path.join(root, "rusty");
		await mkdir(rusty, { recursive: true });
		await nodeFileOps.writeFile(path.join(rusty, "Cargo.toml"), "[package]\n");

		expect(await once(rusty, (s) => s.projectId)).toBeUndefined();
		expect(
			await once(
				rusty,
				(s) => s.projectId,
				settingsWith((draft) => {
					draft.memory.project.markers = [".git", "Cargo.toml"];
				}),
			),
		).toBeDefined();
	});

	it("gives a folder its own memory when asked, and it outranks the one above", async () => {
		const inner = path.join(repo, "packages", "api");
		await mkdir(inner, { recursive: true });
		const outer = await once(repo, (s) => s.projectId);

		const session = await start(inner);
		expect(session.projectId).toBe(outer);
		const outcome = await session.newMemoryHere();
		expect(outcome).toMatchObject({ ok: true, folder: inner });
		session.close();
		started.pop();

		const now = await once(inner, (s) => ({
			id: s.projectId,
			root: s.projectRoot,
		}));
		expect(now.root).toBe(inner);
		expect(now.id).not.toBe(outer);
		// And the folders above are untouched.
		expect(await once(repo, (s) => s.projectId)).toBe(outer);
	});

	it("gives a marker-less folder a memory too, which is the point of the command", async () => {
		const loose = path.join(root, "scripts");
		await mkdir(loose, { recursive: true });

		const session = await start(loose);
		expect(session.projectId).toBeUndefined();
		expect(await session.newMemoryHere()).toMatchObject({ ok: true });
		session.close();
		started.pop();

		expect(await once(loose, (s) => s.projectRoot)).toBe(loose);
		// And it covers what is under it, without a marker anywhere.
		const deeper = path.join(loose, "deploy");
		await mkdir(deeper, { recursive: true });
		expect(await once(deeper, (s) => s.projectRoot)).toBe(loose);
	});

	it("refuses to give a folder a second memory of its own", async () => {
		const session = await start(repo);
		const outcome = await session.newMemoryHere();
		expect(outcome).toMatchObject({ ok: false });
		expect(outcome.ok === false && outcome.reason).toMatch(/already has/i);
	});

	it("treats a folder reached through a symlink as the folder itself", async () => {
		// Two names for one directory would otherwise be two memories, neither
		// aware of the other.
		const link = path.join(root, "link-to-repo");
		await symlink(repo, link, "dir");

		const direct = await once(repo, (s) => s.projectId);
		const linked = await once(link, (s) => ({
			id: s.projectId,
			root: s.projectRoot,
		}));
		expect(linked.id).toBe(direct);
		expect(linked.root).toBe(repo);
	});

	it("stops climbing where it was told to", async () => {
		const deep = path.join(repo, "a", "b", "c");
		await mkdir(deep, { recursive: true });
		expect(
			await once(
				deep,
				(s) => s.projectId,
				settingsWith((draft) => {
					draft.memory.project.maxParents = 2;
				}),
			),
		).toBeUndefined();
	});
});
