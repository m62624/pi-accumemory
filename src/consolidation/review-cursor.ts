/**
 * How far the review phase has walked each memory.
 *
 * One number per key: the highest fact id it has shown. The next window starts
 * after it, and `0` means start from the beginning - which is also what the
 * runner writes when a window comes back empty, wrapping the walk.
 *
 * Its own file rather than a field beside the transcript cursor, because the
 * two are read at different moments and mean different things, and because a
 * shape change to a state file that already exists on disk is a migration for
 * something that is, by design, throwaway.
 *
 * And throwaway it is: every failure here is swallowed. Losing this costs one
 * pass looking at facts it has looked at before, which is a wasted step and
 * nothing worse - while refusing to work because a small JSON file is corrupt
 * would cost the whole pass.
 */

import type { FileOps } from "../fs-ops.ts";

export interface PathFlavour {
	dirname(file: string): string;
}

export class ReviewCursorStore {
	private at: Record<string, number> = {};
	private loaded = false;

	constructor(
		private readonly fs: FileOps,
		private readonly file: string,
		private readonly flavour: PathFlavour,
	) {}

	async get(key: string): Promise<number> {
		await this.load();
		const value = this.at[key];
		// A negative or fractional number would make `id > after` behave in ways
		// nothing above here expects; treat anything unexpected as the start.
		return typeof value === "number" && Number.isInteger(value) && value >= 0
			? value
			: 0;
	}

	async set(key: string, at: number): Promise<void> {
		await this.load();
		this.at[key] = Math.max(0, Math.trunc(at));
		try {
			await this.fs.mkdir(this.flavour.dirname(this.file));
			await this.fs.writeFile(this.file, JSON.stringify(this.at, null, "\t"));
		} catch {
			// Reviewing the same facts twice is cheap; refusing to work is not.
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
				this.at = parsed as Record<string, number>;
			}
		} catch {
			// A corrupt file starts the walk over, which is the safe direction.
		}
	}
}
