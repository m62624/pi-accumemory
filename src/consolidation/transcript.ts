/**
 * The raw material of a consolidation pass: pi's own session transcript.
 *
 * Nothing is duplicated into the database to make this work. pi already writes
 * every session to `<agentDir>/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`,
 * and that directory is split by working directory - which is to say, by
 * project. A cursor per project records how far the last pass read.
 *
 * Everything here is defensive on purpose. These files are written by another
 * program, possibly a different version of it, and one unparseable line must
 * not cost the whole pass.
 */

import type { FileOps } from "../fs-ops.ts";
import type { Turn } from "../memory/transcript-view.ts";
import { messageToTurn } from "../messages.ts";

export interface PathFlavour {
	isAbsolute(file: string): boolean;
	join(...parts: string[]): string;
	resolve(...parts: string[]): string;
}

export interface TranscriptCursor {
	/** File name only; the directory is derived from the project. */
	file: string;
	/** Lines already consumed. */
	line: number;
	/** Older cursors counted the empty segment after a final newline. */
	version?: 2;
}

export interface ReadOptions {
	flavour: PathFlavour;
	sessionsRoot: string;
	cwd: string;
	maxChars: number;
	cursor?: TranscriptCursor;
}

export interface TranscriptTail {
	turns: Turn[];
	/** Where to resume; `undefined` when there was nothing to read. */
	cursor?: TranscriptCursor;
}

/**
 * pi's encoding of a working directory into a directory name.
 *
 * Reproduced from pi's own encoder rather than approximated. Getting it wrong
 * makes this read a directory that does not exist, which presents as "there was
 * nothing to consolidate" - indistinguishable from working perfectly.
 */
export function sessionDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export async function readTranscriptTail(
	fs: FileOps,
	options: ReadOptions,
): Promise<TranscriptTail> {
	const dir = options.flavour.join(
		options.sessionsRoot,
		sessionDirName(options.cwd),
	);
	const files = (await fs.listFiles(dir))
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.reverse();
	const cwd = options.flavour.resolve(options.cwd);
	for (const file of files) {
		const raw = await fs.readFile(options.flavour.join(dir, file));
		if (raw === undefined) continue;
		const lines = raw.split("\n");
		const header = parseRecord(lines[0] ?? "");
		// The directory encoding is lossy, so two different working directories
		// can share it. Use the original cwd recorded by Pi to identify the file.
		if (
			header?.type !== "session" ||
			typeof header.cwd !== "string" ||
			!options.flavour.isAbsolute(header.cwd) ||
			options.flavour.resolve(header.cwd) !== cwd
		) {
			continue;
		}
		return readLines(file, lines, options);
	}
	return { turns: [] };
}

function readLines(
	file: string,
	lines: string[],
	options: ReadOptions,
): TranscriptTail {
	const last = lines.at(-1);
	if (last !== undefined && parseRecord(last) === undefined) {
		// Neither a trailing newline nor a partially written JSON record has
		// consumed a line yet. The next append can fill this same slot.
		lines.pop();
	}
	const cursor = options.cursor;
	const saved = cursor?.file === file ? cursor.line : 0;
	// Re-read one line for legacy cursors. A repeated fact is safer than
	// starting at a line that the old cursor accidentally skipped.
	const adjusted = saved - (cursor?.version === 2 ? 0 : 1);
	const from =
		Number.isSafeInteger(saved) && adjusted <= lines.length
			? Math.max(0, adjusted)
			: 0;

	const turns: Turn[] = [];
	for (const line of lines.slice(from)) {
		const record = parseRecord(line);
		if (record?.type !== "message") continue;
		const turn = messageToTurn(record.message);
		if (turn !== undefined && turn.text !== "") turns.push(turn);
	}
	return {
		turns: clampToBudget(turns, options.maxChars),
		cursor: { file, line: lines.length, version: 2 },
	};
}

function parseRecord(line: string): Record<string, unknown> | undefined {
	const trimmed = line.trim();
	if (trimmed === "") return undefined;
	let entry: unknown;
	try {
		entry = JSON.parse(trimmed);
	} catch {
		// One bad line, not one bad pass.
		return undefined;
	}
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return undefined;
	}
	return entry as Record<string, unknown>;
}

/**
 * Drops from the front until the tail fits.
 *
 * The newest end is what the pass has not seen; the front is what an earlier
 * pass most likely already handled, and what the next one will pick up again
 * from the unchanged cursor.
 */
function clampToBudget(turns: Turn[], maxChars: number): Turn[] {
	if (maxChars <= 0) return turns;
	const kept: Turn[] = [];
	let used = 0;
	for (let i = turns.length - 1; i >= 0; i -= 1) {
		const turn = turns[i];
		if (turn === undefined) continue;
		if (used + turn.text.length > maxChars && kept.length > 0) break;
		kept.unshift(turn);
		used += turn.text.length;
	}
	return kept;
}
