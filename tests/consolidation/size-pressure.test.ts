import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DONE_TOOL, type PassAgent } from "../../src/consolidation/runner.ts";
import { SizePressureRunner } from "../../src/consolidation/size-pressure.ts";
import type { MemoryController } from "../../src/session/controller.ts";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults.ts";
import { SizeLimitedMemory } from "../../src/storage/size-limits.ts";
import { FakeFs } from "../helpers/fake-fs.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

const DB = "/memory/db/common.plugmem";

function makeMemory(
	fs: FakeFs,
	limitBytes = 10,
	snapshotBytes = 5,
): SizeLimitedMemory {
	fs.files.set(DB, "base");
	fs.files.set(`${DB}.snap.1`, "1".repeat(snapshotBytes));
	return new SizeLimitedMemory({
		scope: "user",
		inner: new FakeMemory(),
		settings: {
			...DEFAULT_SETTINGS.memory.sizeLimits,
			userBytes: limitBytes,
			projectBytes: limitBytes,
		},
		fs,
		pathModule: path.posix,
		dbPath: DB,
		onSize: () => {},
	});
}

function runner(
	memory: SizeLimitedMemory,
	controller: Partial<MemoryController>,
	agent: PassAgent,
	limitBytes = 10,
	maxPasses = 3,
): SizePressureRunner {
	return new SizePressureRunner({
		settings: DEFAULT_SETTINGS.memory.consolidation,
		limits: {
			...DEFAULT_SETTINGS.memory.sizeLimits,
			userBytes: limitBytes,
			projectBytes: limitBytes,
			maxPasses,
		},
		controller: controller as MemoryController,
		memories: { user: memory },
		instructions: { read: vi.fn(async () => "Keep facts atomic.") } as never,
		agent,
		scopeLabel: (scope) => `${scope} memory`,
		clock: () => "[Now: 2026-08-20T00:00:00Z]",
	});
}

describe("SizePressureRunner", () => {
	it("runs a bounded safe pass and stops after the size falls below pressure", async () => {
		const fs = new FakeFs();
		const memory = makeMemory(fs);
		const agent: PassAgent = {
			run: async (request) => {
				request.onToolCall("longterm_forget_many", "[0]");
				await memory.forgetMany([0]);
				fs.files.set(`${DB}.snap.1`, "1");
				request.onToolCall(DONE_TOOL, "");
			},
		};
		const controller = {
			sizeCandidates: vi.fn(async () => [
				{ id: 0, text: "A temporary detail.", tags: ["temporary"] },
			]),
			withAutomaticDeleteProtection: async <T>(work: () => Promise<T>) =>
				work(),
		};

		const outcome = await runner(memory, controller, agent).run("user");

		expect(outcome.reason).toBe("resolved");
		expect(outcome.passes).toBe(1);
		expect(outcome.after.state).toBe("ok");
		expect(controller.sizeCandidates).toHaveBeenCalledWith("user", 12);
	});

	it("stops without invoking the agent when no safe candidates exist", async () => {
		const fs = new FakeFs();
		const memory = makeMemory(fs);
		const agent: PassAgent = { run: vi.fn() };
		const controller = {
			sizeCandidates: vi.fn(async () => []),
			withAutomaticDeleteProtection: async <T>(work: () => Promise<T>) =>
				work(),
		};

		const outcome = await runner(memory, controller, agent).run("user");

		expect(outcome.reason).toBe("no-candidates");
		expect(outcome.passes).toBe(0);
		expect(agent.run).not.toHaveBeenCalled();
	});

	it("reports disabled and already-resolved limits without a pass", async () => {
		const disabledFs = new FakeFs();
		const disabledAgent: PassAgent = { run: vi.fn() };
		const disabled = await runner(
			makeMemory(disabledFs, 0),
			{},
			disabledAgent,
			0,
		).run("user");
		expect(disabled.reason).toBe("disabled");

		const resolvedFs = new FakeFs();
		const resolvedAgent: PassAgent = { run: vi.fn() };
		const resolved = await runner(
			makeMemory(resolvedFs, 20),
			{},
			resolvedAgent,
			20,
		).run("user");
		expect(resolved.reason).toBe("resolved");
		expect(resolvedAgent.run).not.toHaveBeenCalled();
	});

	it("honours interruption before and during a private pass", async () => {
		const beforeFs = new FakeFs();
		const beforeAbort = new AbortController();
		beforeAbort.abort();
		const before = await runner(
			makeMemory(beforeFs),
			{ sizeCandidates: async () => [{ id: 0, text: "detail", tags: [] }] },
			{ run: vi.fn() },
		).run("user", beforeAbort.signal);
		expect(before.reason).toBe("interrupted");
		expect(before.ran).toBe(false);

		const duringFs = new FakeFs();
		const duringAbort = new AbortController();
		const during = await runner(
			makeMemory(duringFs),
			{
				sizeCandidates: async () => [{ id: 0, text: "detail", tags: [] }],
				withAutomaticDeleteProtection: async <T>(work: () => Promise<T>) =>
					work(),
			},
			{
				run: async () => duringAbort.abort(),
			},
		).run("user", duringAbort.signal);
		expect(during.reason).toBe("interrupted");
		expect(during.ran).toBe(true);
	});

	it("stops on no progress and does not exceed its pass budget", async () => {
		const noProgressFs = new FakeFs();
		const noProgress = await runner(
			makeMemory(noProgressFs),
			{
				sizeCandidates: async () => [{ id: 0, text: "detail", tags: [] }],
				withAutomaticDeleteProtection: async <T>(work: () => Promise<T>) =>
					work(),
			},
			{ run: async (request) => request.onToolCall(DONE_TOOL, "") },
		).run("user");
		expect(noProgress.reason).toBe("no-progress");

		const maxFs = new FakeFs();
		let pass = 0;
		const max = await runner(
			makeMemory(maxFs, 20, 16),
			{
				sizeCandidates: async () => [{ id: 0, text: "detail", tags: [] }],
				withAutomaticDeleteProtection: async <T>(work: () => Promise<T>) =>
					work(),
			},
			{
				run: async (request) => {
					pass += 1;
					maxFs.files.set(`${DB}.snap.1`, "1".repeat(16 - pass));
					request.onToolCall(DONE_TOOL, "");
				},
			},
			20,
			2,
		).run("user");
		expect(max.reason).toBe("max-passes");
		expect(max.passes).toBe(2);
	});

	it("refuses to run a project pass when no project memory is open", async () => {
		const fs = new FakeFs();
		const memory = makeMemory(fs);
		await expect(
			runner(memory, {}, { run: vi.fn() }).run("project"),
		).rejects.toThrow(/no project memory is open/i);
	});
});
