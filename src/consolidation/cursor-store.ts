/**
 * How far the consolidation pass has read each transcript.
 *
 * Keyed by project id inside a project and by working directory outside one,
 * because that is what pi keys the transcript itself by.
 *
 * A tiny JSON file, and deliberately the least important thing in the system:
 * losing it costs one pass re-reading material it has already seen, which the
 * duplicate guard on `remember` absorbs. So every failure here is swallowed -
 * a corrupt state file must never be the reason a session will not start.
 */

import type { FileOps } from "../fs-ops.ts";
import type { TranscriptCursor } from "./transcript.ts";

export interface PathFlavour {
	dirname(file: string): string;
}

type CursorMap = Record<string, TranscriptCursor>;

export class CursorStore {
	private cursors: CursorMap = {};
	private loaded = false;

	constructor(
		private readonly fs: FileOps,
		private readonly file: string,
		private readonly flavour: PathFlavour,
	) {}

	async get(key: string): Promise<TranscriptCursor | undefined> {
		await this.load();
		return this.cursors[key];
	}

	async set(key: string, cursor: TranscriptCursor): Promise<void> {
		await this.load();
		this.cursors[key] = cursor;
		try {
			await this.fs.mkdir(this.flavour.dirname(this.file));
			await this.fs.writeFile(
				this.file,
				JSON.stringify(this.cursors, null, "\t"),
			);
		} catch {
			// Re-reading a transcript is cheap; refusing to work is not.
		}
	}

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const raw = await this.fs.readFile(this.file);
			if (raw === undefined) return;
			const parsed: unknown = JSON.parse(raw);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed)
			) {
				this.cursors = parsed as CursorMap;
			}
		} catch {
			// A truncated write from a previous crash reads as "start over".
			this.cursors = {};
		}
	}
}
