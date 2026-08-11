/**
 * The flattened view of a conversation the memory modules work on.
 *
 * Deliberately not pi's `AgentMessage`. Those carry content blocks, images,
 * tool payloads and provider detail, none of which a recall query has any use
 * for — and depending on them would drag the SDK into every pure module and
 * into every unit test. One adapter converts; everything downstream sees this.
 */

export type TurnRole = "user" | "assistant" | "tool";

export interface Turn {
	role: TurnRole;
	/** Plain text. Empty for a message that carried no text at all. */
	text: string;
}
