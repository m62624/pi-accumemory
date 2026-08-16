/**
 * The extension actually loads.
 *
 * Every other test drives a module directly. This one goes through the entry
 * point pi calls, with a stubbed ExtensionAPI, and checks the two things that
 * can only break there: the tools register, and a failure to open the databases
 * does not take the session down with it.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extensionLayout } from "../../src/layout.ts";
import { LONGTERM_TOOL_NAMES } from "../../src/tools/definitions.ts";

interface RegisteredTool {
	name: string;
	execute(
		id: string,
		params: unknown,
	): Promise<{ content: { text: string }[] }>;
}

function stubApi() {
	const tools: RegisteredTool[] = [];
	const commands: string[] = [];
	const handlers = new Map<
		string,
		((event: unknown, ctx: unknown) => unknown)[]
	>();
	const notices: string[] = [];
	const noticeLevels: string[] = [];

	const api = {
		registerTool: (tool: RegisteredTool) => tools.push(tool),
		registerCommand: (name: string) => commands.push(name),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	const ctx = {
		ui: {
			notify: (message: string, level = "info") => {
				notices.push(message);
				noticeLevels.push(level);
			},
			setStatus: () => {},
		},
	};
	const fire = async (event: string, payload: unknown) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler(payload, ctx));
		}
		return results;
	};
	return { api, tools, commands, notices, noticeLevels, fire };
}

describe("the extension entry point", () => {
	let home: string;
	let previousHome: string | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "pi-accumemory-home-"));
		previousHome = process.env.HOME;
		process.env.HOME = home;
	});

	afterEach(async () => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	});

	it("shows settings warnings with warning severity", async () => {
		const agentDir = join(home, "agent");
		const layout = extensionLayout(agentDir, posix);
		await mkdir(layout.root, { recursive: true });
		await writeFile(
			layout.settingsFile,
			JSON.stringify({ memory: { unknownSetting: true } }),
		);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const { api, fire, notices, noticeLevels } = stubApi();
			const { default: accumemory } = await import("../../src/index.ts");
			accumemory(api as never);
			await fire("session_start", { type: "session_start", reason: "startup" });

			const warningIndex = notices.findIndex((notice) =>
				notice.includes("memory.unknownSetting"),
			);
			expect(warningIndex).toBeGreaterThanOrEqual(0);
			expect(noticeLevels[warningIndex]).toBe("warning");
			await fire("session_shutdown", {
				type: "session_shutdown",
				reason: "quit",
			});
		} finally {
			if (previousAgentDir === undefined)
				delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("registers every tool and every command", async () => {
		const { api, tools, commands, fire } = stubApi();
		const { default: accumemory } = await import("../../src/index.ts");
		accumemory(api as never);

		expect(tools.map((tool) => tool.name)).toEqual([...LONGTERM_TOOL_NAMES]);
		expect(commands).toEqual([
			"longterm-status",
			"longterm-inspect",
			"longterm-consolidate",
			"longterm-new",
			"longterm-rebind",
			"longterm-reembed",
		]);
		await fire("session_shutdown", {
			type: "session_shutdown",
			reason: "quit",
		});
	});

	it("registers the tools before the databases have opened", async () => {
		// The tool list lives in the head of the prompt. Adding or removing one
		// mid-session invalidates the cache for everything below it, so the
		// list must be complete from the first call, not from whenever the
		// filesystem got around to it.
		const { api, tools } = stubApi();
		const { default: accumemory } = await import("../../src/index.ts");
		accumemory(api as never);
		expect(tools).toHaveLength(LONGTERM_TOOL_NAMES.length);
	});

	it("answers a tool call with text rather than throwing", async () => {
		const { api, tools, fire } = stubApi();
		const { default: accumemory } = await import("../../src/index.ts");
		accumemory(api as never);

		const projects = tools.find((tool) => tool.name === "longterm_projects");
		const result = await projects?.execute("id", {});
		expect(typeof result?.content[0]?.text).toBe("string");
		await fire("session_shutdown", {
			type: "session_shutdown",
			reason: "quit",
		});
	});

	it("puts its instructions first and its memory block last", async () => {
		const { api, fire } = stubApi();
		const { default: accumemory } = await import("../../src/index.ts");
		accumemory(api as never);

		const messages = [{ role: "user", content: "why is the cache off" }];
		const [result] = (await fire("context", { type: "context", messages })) as [
			{ messages?: { role: string; content: string }[] } | undefined,
		];
		const produced = result?.messages;
		expect(produced).toBeDefined();
		if (produced === undefined) return;

		// The instructions. Their absence is the failure this test exists for:
		// they were written, synced to disk and documented for weeks while the
		// live model received none of them and worked off tool descriptions.
		expect(produced[0]?.content).toContain("[SYSTEM_INSTRUCTIONS");
		expect(produced[0]?.content).toMatch(/how to read what you are shown/i);
		expect(produced[0]?.content).toMatch(/never store/i);

		// The transcript, untouched, between head and tail.
		expect(produced.slice(1, 1 + messages.length)).toEqual(messages);
		expect(produced.length).toBeGreaterThanOrEqual(messages.length + 1);
		expect(produced.at(-1)?.role).toBe("user");

		await fire("session_shutdown", {
			type: "session_shutdown",
			reason: "quit",
		});
	});

	it("keeps the head byte-identical between calls, so the prefix caches", async () => {
		const { api, fire } = stubApi();
		const { default: accumemory } = await import("../../src/index.ts");
		accumemory(api as never);

		const messages = [{ role: "user", content: "why is the cache off" }];
		const heads: (string | undefined)[] = [];
		for (let call = 0; call < 3; call += 1) {
			const [result] = (await fire("context", {
				type: "context",
				messages,
			})) as [{ messages?: { content: string }[] } | undefined];
			heads.push(result?.messages?.[0]?.content);
		}
		expect(heads[0]).toBeDefined();
		expect(heads[1]).toBe(heads[0]);
		expect(heads[2]).toBe(heads[0]);

		await fire("session_shutdown", {
			type: "session_shutdown",
			reason: "quit",
		});
	});

	it("survives the lifecycle events firing in any order", async () => {
		const { api, fire } = stubApi();
		const { default: accumemory } = await import("../../src/index.ts");
		accumemory(api as never);

		await expect(
			(async () => {
				await fire("turn_end", {
					type: "turn_end",
					toolResults: [],
					message: {},
				});
				await fire("tool_execution_end", {
					type: "tool_execution_end",
					toolName: "read",
				});
				await fire("before_agent_start", { type: "before_agent_start" });
				await fire("session_compact", { type: "session_compact" });
				await fire("agent_settled", { type: "agent_settled" });
				await fire("session_start", {
					type: "session_start",
					reason: "startup",
				});
				await fire("session_shutdown", {
					type: "session_shutdown",
					reason: "quit",
				});
			})(),
		).resolves.toBeUndefined();
	});
});
