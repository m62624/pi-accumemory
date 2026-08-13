/**
 * The automatic repair, end to end, on a real engine.
 *
 * Split deliberately in two:
 *
 * - the **repair mechanics** run against a stub embedding service started by
 *   the test itself, so they run everywhere - on CI, and on a machine that has
 *   never heard of Ollama. These are the paths where a mistake costs the user
 *   their whole memory, and they must not be the tests that quietly skip;
 * - **semantic quality** - finding a fact by meaning rather than by shared
 *   words - needs a real model and nothing can fake it, so that one skips when
 *   no embedding service answers.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import {
	writeConfigWithoutEmbedder,
	writeEmbedderConfig,
} from "../helpers/plugmem-config.ts";
import {
	type StubEmbedder,
	startStubEmbedder,
} from "../helpers/stub-embedder.ts";

const OLLAMA_URL = "http://localhost:11434/v1/embeddings";
const OLLAMA_MODEL = "nomic-embed-text";
const OLLAMA_DIM = 768;

async function ollamaAvailable(): Promise<boolean> {
	try {
		const response = await fetch(OLLAMA_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: OLLAMA_MODEL, input: "probe" }),
			signal: AbortSignal.timeout(3000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

const available = await ollamaAvailable();

describe("vector repair", () => {
	let root: string;
	let agentDir: string;
	let project: string;
	let embedder: StubEmbedder;
	const started: StartedSession[] = [];

	function settingsWith(patch: (draft: Settings) => void = () => {}): Settings {
		const draft = structuredClone(DEFAULT_SETTINGS);
		draft.memory.consolidation.enabled = false;
		patch(draft);
		return draft;
	}

	/** The file the next session will open with; rewritten to change it. */
	function configFile(): string {
		return extensionLayout(agentDir, path).configToml;
	}

	/** Points the config at the stub service, optionally in another space. */
	async function configureEmbedder(spaceId?: string): Promise<void> {
		await writeEmbedderConfig(configFile(), {
			url: embedder.url,
			model: "stub",
			dim: embedder.dim,
			...(spaceId === undefined ? {} : { spaceId }),
		});
	}

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "pi-accumemory-embed-"));
		agentDir = path.join(root, "agent");
		project = path.join(root, "app");
		await mkdir(path.join(project, ".git"), { recursive: true });
		embedder = await startStubEmbedder();
	});

	afterEach(async () => {
		for (const session of started.splice(0)) session.close();
		await embedder.close();
		await rm(root, { recursive: true, force: true });
	});

	async function start(settings: Settings): Promise<StartedSession> {
		const session = await startSession({
			settings,
			layout: extensionLayout(agentDir, path),
			fs: nodeFileOps,
			pathModule: path,
			agentDir,
			cwd: project,
		});
		started.push(session);
		return session;
	}

	it("repairs itself after the semantic space changes", async () => {
		// Without the repair this session's every text lookup and every text
		// write fails with `vector space mismatch`, and the user finds out in
		// the middle of a task rather than at startup.
		await configureEmbedder();
		const first = await start(settingsWith());
		await first.controller.remember({
			text: "the cache is disabled because it raced with the warmup task",
		});
		first.close();
		started.pop();

		await configureEmbedder("a-deliberately-different-space");
		const second = await start(settingsWith());
		expect(second.notices.join(" ")).toMatch(/embedding model changed/i);
		expect(second.notices.join(" ")).toMatch(/nothing was lost/i);
		// The point: it answers, rather than throwing.
		expect(await second.controller.ask({ question: "warmup cache" })).toContain(
			"warmup",
		);
	});

	it("reports instead of repairing when told to", async () => {
		await configureEmbedder();
		const first = await start(settingsWith());
		await first.controller.remember({
			text: "biome is the formatter used here",
		});
		first.close();
		started.pop();

		await configureEmbedder("another-space");
		const second = await start(
			settingsWith((draft) => {
				draft.memory.autoReembed = false;
			}),
		);
		expect(second.notices.join(" ")).toContain("/longterm-reembed");
	});

	it("fills in vectors for facts stored before the embedder existed", async () => {
		// The quiet case: nothing errors, meaning-based recall just answers from
		// the fraction of the memory that has vectors and says nothing about it.
		await writeConfigWithoutEmbedder(configFile());
		const first = await start(settingsWith());
		await first.controller.remember({
			text: "the cache is disabled because it raced with the warmup task",
		});
		first.close();
		started.pop();

		await configureEmbedder();
		const second = await start(settingsWith());
		expect(second.notices.join(" ")).toMatch(/filled in/i);
		expect(await second.controller.ask({ question: "warmup cache" })).toContain(
			"warmup",
		);
	});

	it("rebuilds every database on demand", async () => {
		// What /longterm-reembed does, including the database this session is
		// itself holding the writer for.
		await configureEmbedder();
		const session = await start(settingsWith());
		await session.controller.remember({ text: "vitest runs the tests here" });
		const before = embedder.embedded();
		const { steps } = await session.reembed();
		expect(steps.map((step) => step.state)).toEqual(["done", "done"]);
		expect(embedder.embedded()).toBeGreaterThan(before);
	});
});

describe.skipIf(!available)("semantic recall on a real embedder", () => {
	let root: string;
	let project: string;
	const started: StartedSession[] = [];

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "pi-accumemory-ollama-"));
		project = path.join(root, "app");
		await mkdir(path.join(project, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const session of started.splice(0)) session.close();
		await rm(root, { recursive: true, force: true });
	});

	it("finds a fact by meaning, not by shared words", async () => {
		// The whole reason the embedder is recommended, and the one thing no
		// stub can stand in for. These two share almost no vocabulary; lexical
		// retrieval alone connects them to nothing.
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.memory.consolidation.enabled = false;
		const layout = extensionLayout(path.join(root, "agent"), path);
		await writeEmbedderConfig(layout.configToml, {
			url: OLLAMA_URL,
			model: OLLAMA_MODEL,
			dim: OLLAMA_DIM,
		});

		const session = await startSession({
			settings,
			layout,
			fs: nodeFileOps,
			pathModule: path,
			agentDir: path.join(root, "agent"),
			cwd: project,
		});
		started.push(session);

		await session.controller.remember({
			text: "the cache is disabled because it raced with the warmup task",
		});
		expect(
			await session.controller.ask({
				question: "why is caching turned off here",
			}),
		).toContain("warmup");
	});
});
