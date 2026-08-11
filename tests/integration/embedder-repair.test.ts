/**
 * The auto-repair, end to end, against a real embedding service.
 *
 * Skipped when no embedding endpoint answers, so CI and a machine without
 * Ollama stay green - a test that needs a live service must never be the reason
 * a build is red. When it does run, it is the only proof that the repair works
 * on real vectors rather than on a fake that agrees with us.
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

const EMBEDDER_URL = "http://localhost:11434/v1/embeddings";
const EMBEDDER_MODEL = "nomic-embed-text";
const EMBEDDER_DIM = 768;

async function embedderAvailable(): Promise<boolean> {
	try {
		const response = await fetch(EMBEDDER_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: EMBEDDER_MODEL, input: "probe" }),
			signal: AbortSignal.timeout(3000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

const available = await embedderAvailable();

describe.skipIf(!available)("vector repair on a real embedder", () => {
	let root: string;
	let agentDir: string;
	let project: string;
	const started: StartedSession[] = [];

	function settingsWith(patch: (draft: Settings) => void): Settings {
		const draft = structuredClone(DEFAULT_SETTINGS);
		draft.memory.embedder.enabled = true;
		draft.memory.embedder.url = EMBEDDER_URL;
		draft.memory.embedder.model = EMBEDDER_MODEL;
		draft.memory.embedder.dim = EMBEDDER_DIM;
		draft.memory.consolidation.enabled = false;
		patch(draft);
		return draft;
	}

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "pi-accumemory-embed-"));
		agentDir = path.join(root, "agent");
		project = path.join(root, "app");
		await mkdir(path.join(project, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const session of started.splice(0)) session.close();
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

	it("finds a fact by meaning, not by shared words", async () => {
		// The whole reason the embedder is recommended. These two share almost
		// no vocabulary; lexical retrieval alone connects them to nothing.
		const session = await start(settingsWith(() => {}));
		await session.controller.remember({
			text: "the cache is disabled because it raced with the warmup task",
		});
		expect(
			await session.controller.ask({
				question: "why is caching turned off here",
			}),
		).toContain("warmup");
	});

	it("repairs itself after the semantic space changes", async () => {
		// Without the repair this session's every text lookup and text write
		// fails with `vector space mismatch`, and the user finds out mid-task.
		const first = await start(settingsWith(() => {}));
		await first.controller.remember({
			text: "the cache is disabled because it raced with the warmup task",
		});
		first.close();
		started.pop();

		const second = await start(
			settingsWith((draft) => {
				draft.memory.embedder.spaceId = "a-deliberately-different-space";
			}),
		);
		expect(second.notices.join(" ")).toMatch(/embedding model changed/i);
		expect(second.notices.join(" ")).toMatch(/nothing was lost/i);
		// The point: it answers, rather than throwing.
		expect(
			await second.controller.ask({
				question: "why is caching turned off here",
			}),
		).toContain("warmup");
	});

	it("reports instead of repairing when told to", async () => {
		const first = await start(settingsWith(() => {}));
		await first.controller.remember({
			text: "biome is the formatter used here",
		});
		first.close();
		started.pop();

		const second = await start(
			settingsWith((draft) => {
				draft.memory.embedder.spaceId = "another-space";
				draft.memory.embedder.autoReembed = false;
			}),
		);
		expect(second.notices.join(" ")).toContain("/longterm-reembed");
	});

	it("fills in vectors for facts stored before the embedder existed", async () => {
		// The quiet case: nothing errors, meaning-based recall just answers from
		// the fraction of the memory that has vectors and says nothing.
		const withoutEmbedder = structuredClone(DEFAULT_SETTINGS);
		withoutEmbedder.memory.consolidation.enabled = false;
		const first = await start(withoutEmbedder);
		await first.controller.remember({
			text: "the cache is disabled because it raced with the warmup task",
		});
		first.close();
		started.pop();

		const second = await start(settingsWith(() => {}));
		expect(second.notices.join(" ")).toMatch(/filled in/i);
		expect(
			await second.controller.ask({
				question: "why is caching turned off here",
			}),
		).toContain("warmup");
	});
});
