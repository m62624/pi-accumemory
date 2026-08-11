/**
 * Repairing another project's vectors on demand.
 *
 * Startup repairs two databases: the shared one and this project's. Every other
 * project in the workspace is repaired by its own session - which means a
 * project nobody has opened since the embedder changed still holds vectors from
 * the old space. A cross-project question opens it READ-ONLY, and a read-only
 * handle refuses every write, so it cannot repair itself. Hence this path.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { NoteStore } from "../../src/notes/store.ts";
import { ProjectRouter } from "../../src/router/router.ts";
import { MemoryController } from "../../src/session/controller.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import { PLUGMEM_ENGINE } from "../../src/storage/errors.ts";
import { FakeFs } from "../helpers/fake-fs.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

function mismatch(): Error {
	return Object.assign(
		new Error(
			'vector space mismatch: stored "a", requested "b"; run an explicit reembed',
		),
		{ code: PLUGMEM_ENGINE },
	);
}

async function build(options: {
	repair?: (projectId: string) => Promise<string | undefined>;
	broken?: boolean;
}) {
	const common = new FakeMemory();
	const other = new FakeMemory();
	await other.remember({
		text: "auth here uses a signed cookie rather than a JWT",
	});
	if (options.broken === true) other.failEveryRecall = mismatch();

	const router = new ProjectRouter(common);
	await router.resolve("/home/m/Projects/api");

	const controller = new MemoryController({
		settings: DEFAULT_SETTINGS,
		common,
		router,
		notesCommon: new NoteStore(common, {
			fs: new FakeFs(),
			dir: "/c",
			flavour: path.posix,
		}),
		openProjectReader: async () => ({ memory: other, close: () => {} }),
		...(options.repair === undefined ? {} : { repairProject: options.repair }),
	});
	return { controller, other };
}

describe("cross-project vector repair", () => {
	it("answers normally when nothing is wrong", async () => {
		const { controller } = await build({});
		expect(await controller.askProject("api", "how is auth done")).toContain(
			"signed cookie",
		);
	});

	it("repairs the other project and answers on the retry", async () => {
		const { controller, other } = await build({
			broken: true,
			repair: async () => {
				other.failEveryRecall = undefined;
				return undefined;
			},
		});
		expect(await controller.askProject("api", "how is auth done")).toContain(
			"signed cookie",
		);
	});

	it("repairs at most once, rather than looping", async () => {
		let repairs = 0;
		const { controller } = await build({
			broken: true,
			repair: async () => {
				repairs += 1;
				// Deliberately does not fix it: the retry must still fail.
				return undefined;
			},
		});
		expect(await controller.askProject("api", "how is auth done")).toMatch(
			/different embedding model/i,
		);
		expect(repairs).toBe(1);
	});

	it("says why it could not repair, when the reason is known", async () => {
		const { controller } = await build({
			broken: true,
			repair: async () => "a session is open in it right now",
		});
		expect(await controller.askProject("api", "how is auth done")).toContain(
			"a session is open in it",
		);
	});

	it("explains itself when no repair path is wired at all", async () => {
		const { controller } = await build({ broken: true });
		const answer = await controller.askProject("api", "how is auth done");
		expect(answer).toMatch(/different embedding model/i);
		expect(answer).toContain("/longterm-reembed");
	});

	it("does not swallow an unrelated failure", async () => {
		// Only a space mismatch is repairable. Anything else is a real fault,
		// and turning it into "nothing on this" would hide it.
		const { controller, other } = await build({});
		other.failEveryRecall = new Error("disk on fire");
		await expect(
			controller.askProject("api", "how is auth done"),
		).rejects.toThrow("disk on fire");
	});
});
