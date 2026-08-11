/**
 * The one adapter from pi's messages to the flat {@link Turn} view.
 *
 * It is written against the *structure* rather than the SDK's types on
 * purpose. The same function has to read two things: live messages handed to a
 * `context` handler, and lines parsed out of a session file that may have been
 * written by a different version of pi. Typed narrowly it would do the first
 * and throw on the second, and a consolidation pass that dies on an unfamiliar
 * content block is a pass that silently stops running one upgrade from now.
 *
 * So everything unknown is skipped, nothing throws, and the result is text.
 */

import type { Turn } from "./memory/transcript-view.ts";

/** Converts what it recognises, in order, dropping what it does not. */
export function toTurns(messages: readonly unknown[]): Turn[] {
	const turns: Turn[] = [];
	for (const message of messages) {
		const turn = messageToTurn(message);
		if (turn !== undefined) turns.push(turn);
	}
	return turns;
}

export function messageToTurn(message: unknown): Turn | undefined {
	if (!isRecord(message)) return undefined;
	switch (message.role) {
		case "user":
			return { role: "user", text: textOf(message.content) };
		case "assistant":
			return { role: "assistant", text: assistantText(message.content) };
		case "toolResult":
			return { role: "tool", text: textOf(message.content) };
		default:
			return undefined;
	}
}

/** Whether an assistant message asked for any tool at all. */
export function hasToolCalls(message: unknown): boolean {
	if (!isRecord(message) || message.role !== "assistant") return false;
	const content = message.content;
	if (!Array.isArray(content)) return false;
	return content.some((block) => isRecord(block) && block.type === "toolCall");
}

function assistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		// Thinking is the model talking to itself. Feeding it back as a recall
		// query asks the memory about the model's own uncertainty.
		if (block.type === "text" && typeof block.text === "string")
			parts.push(block.text);
		else if (block.type === "toolCall" && typeof block.name === "string") {
			// The name, never the arguments: those are routinely a whole file,
			// and as query text they drown everything else in the window.
			parts.push(`(called ${block.name})`);
		}
	}
	return parts.join("\n");
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is Record<string, unknown> => isRecord(block))
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
