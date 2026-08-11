/**
 * The extension actually loads.
 *
 * Every other test drives a module directly. This one goes through the entry
 * point pi calls, with a stubbed ExtensionAPI, and checks the two things that
 * can only break there: the tools register, and a failure to open the databases
 * does not take the session down with it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	const api = {
		registerTool: (tool: RegisteredTool) => tools.push(tool),
		registerCommand: (name: string) => commands.push(name),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	const ctx = {
		ui: {
			notify: (message: string) => notices.push(message),
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
	return { api, tools, commands, notices, fire };
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

	it("registers every tool and every command", async () => {
		const { api, tools, commands, fire } = stubApi();
		const { default: accumemory } = await import("../../src/index.ts");
		accumemory(api as never);

		expect(tools.map((tool) => tool.name)).toEqual([...LONGTERM_TOOL_NAMES]);
		expect(commands).toEqual([
			"longterm-status",
			"longterm-consolidate",
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

	it("appends its tail as the last message, never above the transcript", async () => {
		const { api, fire } = stubApi();
		const { default: accumemory } = await import("../../src/index.ts");
		accumemory(api as never);

		const messages = [{ role: "user", content: "why is the cache off" }];
		const [result] = (await fire("context", { type: "context", messages })) as [
			{ messages?: { role: string; content: string }[] } | undefined,
		];
		// A tail is optional - an empty memory adds nothing - but when there is
		// one it goes last and the transcript above it is untouched.
		if (result?.messages !== undefined) {
			expect(result.messages.length).toBe(messages.length + 1);
			expect(result.messages.slice(0, messages.length)).toEqual(messages);
			expect(result.messages.at(-1)?.role).toBe("user");
		}
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
