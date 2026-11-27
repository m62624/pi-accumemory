import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as piSdk from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { piPassAgent } from "../../src/consolidation/pi-agent.ts";
import { DONE_TOOL } from "../../src/consolidation/runner.ts";

vi.mock(import("@earendil-works/pi-coding-agent"), async (load) => {
	const sdk = await load();
	return { ...sdk, createAgentSession: vi.fn(sdk.createAgentSession) };
});

it("exposes only the memory tools to a real Pi consolidation session", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "accumemory-pass-agent-"));
	const { createAgentSession: create } = await vi.importActual<typeof piSdk>(
		"@earendil-works/pi-coding-agent",
	);
	const spy = vi.mocked(piSdk.createAgentSession);
	let agent: Awaited<ReturnType<typeof create>>["session"] | undefined;
	try {
		spy.mockImplementationOnce(async (options) => {
			const result = await create(options);
			agent = result.session;
			vi.spyOn(agent, "prompt").mockResolvedValue(undefined);
			return result;
		});
		await piPassAgent({
			cwd: dir,
			agentDir: dir,
			tools: [
				{
					name: "longterm_remember",
					label: "Remember",
					description: "Write a fact",
					parameters: { type: "object", properties: {} },
					run: async () => "Stored",
				},
			],
		}).run({
			prompt: "Consolidate public chat",
			tail: () => "",
			onToolCall: () => {},
			onIdleTurn: () => {},
			finished: () => true,
		});
		expect(agent?.getActiveToolNames().sort()).toEqual([
			DONE_TOOL,
			"longterm_remember",
		]);
		expect(agent?.sessionManager.getSessionFile()).toBeUndefined();
	} finally {
		spy.mockRestore();
		agent?.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});
