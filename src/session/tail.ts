/**
 * The trailing message: everything this extension ever adds to a prompt.
 *
 * One place, one order, and nothing anywhere else. The rule it exists to
 * enforce is that all of it goes BELOW the transcript. A backend caches a
 * prefix, so anything written above the conversation is charged the whole
 * conversation each time it changes - and every part of this changes.
 *
 * The order is fixed and is not cosmetic:
 *
 * 1. **the clock**, first, because everything after it can be dated. Without a
 *    current time, "Saturday at 20:30" cannot be recognised as already past,
 *    and stale facts never get retired.
 * 2. **the memory block** - the substance.
 * 3. **always-instructions** - the model's own standing rules.
 * 4. **the write reminder**, if due.
 * 5. **the ask hint**, if due.
 *
 * The nudges come last because a model acts on the last thing it read, and
 * they are the parts that ask for an action.
 *
 * The clock lives INSIDE this message rather than in one of its own. A separate
 * message carrying the time gets read as somebody speaking - pi-telegram-manager
 * watched a model reply to its own clock - and it breaks the cache on every
 * tick, since a new minute is new bytes at a message boundary.
 */

export interface TailParts {
	clock?: string;
	block?: string;
	alwaysInstructions?: string;
	writeNudge?: string;
	askHint?: string;
}

/** Joins the parts that are present. Empty when none are. */
export function buildTail(parts: TailParts): string {
	const sections = [
		parts.clock,
		parts.block,
		parts.alwaysInstructions,
		parts.writeNudge,
		parts.askHint,
	]
		.map((section) => section?.trim() ?? "")
		.filter((section) => section !== "");
	return sections.join("\n\n");
}

/**
 * The clock line.
 *
 * The zone is named explicitly because a bare timestamp is ambiguous, and this
 * is used to judge whether a dated fact has expired - a judgement that is wrong
 * by a day if the zone is guessed.
 */
export function clockLine(at: Date, timeZone: string | null): string {
	const options: Intl.DateTimeFormatOptions = {
		dateStyle: "full",
		timeStyle: "short",
		...(timeZone === null ? {} : { timeZone }),
	};
	let formatted: string;
	try {
		formatted = new Intl.DateTimeFormat("en-GB", options).format(at);
	} catch {
		// An invalid zone in settings must not take the session down; the host's
		// own zone is a fine answer and the misconfiguration surfaces elsewhere.
		formatted = new Intl.DateTimeFormat("en-GB", {
			dateStyle: "full",
			timeStyle: "short",
		}).format(at);
	}
	const zone = timeZone ?? resolvedZone();
	return `[Now: ${formatted}${zone === undefined ? "" : ` (${zone})`}]`;
}

/**
 * The standing instructions the model wrote for itself.
 *
 * Capped hard, in both count and characters. These bypass retrieval entirely -
 * they are in every prompt of every session - so without a ceiling this becomes
 * the unbounded markdown file the design was meant to avoid, one line at a time.
 */
export function alwaysBlock(
	instructions: readonly string[],
	limits: { alwaysMax: number; alwaysMaxChars: number },
): string {
	const kept: string[] = [];
	let used = 0;
	for (const instruction of instructions) {
		if (kept.length >= limits.alwaysMax) break;
		const line = `- ${instruction.trim()}`;
		if (used + line.length > limits.alwaysMaxChars) break;
		kept.push(line);
		used += line.length;
	}
	if (kept.length === 0) return "";
	return `Standing rules you wrote for yourself:\n${kept.join("\n")}`;
}

function resolvedZone(): string | undefined {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone;
	} catch {
		return undefined;
	}
}
