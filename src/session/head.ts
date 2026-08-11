/**
 * The standing instructions, at the HEAD of every context.
 *
 * This module exists because the extension spent its first weeks not doing it.
 * The instruction files were written, synced to disk, documented - and handed
 * only to the background consolidation pass. A live session's model received
 * nothing but the tool descriptions, so it had no idea when to ask its memory,
 * which memory a fact belonged in, how to read the block it was shown, or that
 * it must never store a credential. Everything that looked like the model being
 * stupid was the model being uninstructed.
 *
 * Two decisions, both copied from pi-telegram-manager because they are already
 * paid for:
 *
 * 1. **Head, not tail.** These bytes never change during a session, so putting
 *    them first costs one cached prefix and nothing after that. The memory block
 *    goes at the tail for the opposite reason - it changes, and anything below a
 *    change is re-read. Head for the stable, tail for the volatile.
 * 2. **Rebuilt on every call rather than written into the session.** A block
 *    that is not part of the conversation cannot be summarised away, so it
 *    survives a compaction with no separate re-injection path.
 *
 * `timestamp: 0` keeps it sorted before the conversation: it is not a turn, and
 * a model that reads it as one starts answering it.
 */

/** Marks the block as instructions rather than as somebody speaking. */
export const SYSTEM_INSTRUCTIONS_HEADER =
	"[SYSTEM_INSTRUCTIONS: pi-accumemory]";

/** A message shaped the way pi's context hook expects. */
export interface HeadMessage {
	role: "user";
	content: string;
	timestamp: 0;
}

export function headMessage(block: string): HeadMessage {
	return {
		role: "user",
		content: `${SYSTEM_INSTRUCTIONS_HEADER}\n\n${block}`,
		timestamp: 0,
	};
}

/**
 * Put the block in front, and change nothing else.
 *
 * An empty block returns the messages untouched - an empty header is a message
 * that says nothing, and the model would still have to read it.
 */
export function withHead<T>(
	messages: readonly T[],
	block: string,
): (T | HeadMessage)[] {
	if (block.trim() === "") return [...messages];
	return [headMessage(block), ...messages];
}
