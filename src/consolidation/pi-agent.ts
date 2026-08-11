/**
 * Running a consolidation pass on its own agent session.
 *
 * A separate, in-memory session rather than the user's: the pass is not part of
 * their conversation, must not appear in their transcript, and must not push
 * their context towards a compaction. `SessionManager.inMemory()` gives it
 * somewhere to live that is discarded when it ends.
 *
 * The tool set is exactly the memory tools plus the one that ends the pass.
 * `noTools: "all"` first, because a pass with `bash` available is a pass that
 * can do something other than curate memory.
 */

import {
	createAgentSession,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolSpec } from "../tools/definitions.ts";
import { DONE_TOOL, type PassAgent, type PassAgentRequest } from "./runner.ts";

export interface PiPassAgentOptions {
	cwd: string;
	agentDir: string;
	/** The memory tools, already bound to this session's controller. */
	tools: ToolSpec[];
}

export function piPassAgent(options: PiPassAgentOptions): PassAgent {
	return {
		async run(request: PassAgentRequest): Promise<void> {
			const customTools = [
				...options.tools.map((spec) => toToolDefinition(spec, request)),
				doneTool(request),
			];

			const { session } = await createAgentSession({
				cwd: options.cwd,
				agentDir: options.agentDir,
				// The pass curates memory. Nothing else.
				noTools: "all",
				customTools,
				sessionManager: SessionManager.inMemory(),
			});

			const abort = () => void session.abort();
			request.signal?.addEventListener("abort", abort, { once: true });
			try {
				await session.prompt(request.prompt);
				// `prompt` resolves when the model stops calling tools, which on
				// a pass means it narrated instead of acting. That is the idle
				// turn the ledger exists to catch: nudge, and let the ledger
				// decide when to stop nudging.
				while (!request.finished() && request.signal?.aborted !== true) {
					request.onIdleTurn();
					if (request.finished()) break;
					await session.prompt(request.tail());
				}
			} finally {
				request.signal?.removeEventListener("abort", abort);
			}
		},
	};
}

function toToolDefinition(
	spec: ToolSpec,
	request: PassAgentRequest,
): ToolDefinition {
	return {
		name: spec.name,
		label: spec.label,
		description: spec.description,
		parameters: spec.parameters as never,
		execute: async (_id: string, params: unknown) => {
			const args = (params ?? {}) as Record<string, unknown>;
			request.onToolCall(spec.name, stableKey(args));
			const text = await spec.run(args);
			// The ledger's directive rides back on the tool result. It has to
			// reach the model every step, and a tool result is the one channel
			// that already does - no extension hook to install into a session
			// that has none, and no message the transcript would not have grown
			// anyway.
			const directive = request.tail();
			return {
				content: [
					{
						type: "text" as const,
						text: directive === "" ? text : `${text}\n\n${directive}`,
					},
				],
				details: undefined,
			};
		},
	} as unknown as ToolDefinition;
}

function doneTool(request: PassAgentRequest): ToolDefinition {
	return {
		name: DONE_TOOL,
		label: "Long-term memory: finish this pass",
		description:
			"End this consolidation pass. Call it as soon as there is nothing further " +
			"worth storing, revising or forgetting - anything you leave is picked up by " +
			"the next pass, which resumes from the same place in the transcript.",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			request.onToolCall(DONE_TOOL, "");
			return {
				content: [{ type: "text" as const, text: "Pass finished." }],
				details: undefined,
			};
		},
	} as unknown as ToolDefinition;
}

/**
 * A stable signature for "the same call again".
 *
 * Key order in a parsed JSON object follows the model's output, so two
 * identical calls can serialise differently. Sorting makes the repeat
 * detectable, which is the whole point of recording it.
 */
export function stableKey(args: Record<string, unknown>): string {
	return JSON.stringify(
		Object.keys(args)
			.sort()
			.map((key) => [key, args[key]]),
	);
}
