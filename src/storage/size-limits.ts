/**
 * Byte limits for one plugmem database.
 *
 * The native engine exposes pool and current-snapshot sizes, but a Node host
 * also has a journal, manifest and lock file. This module measures the active
 * database family through FileOps, so the policy is independent of the host
 * operating system and does not need a shell utility such as `du`.
 */

import type { FileOps } from "../fs-ops.ts";
import type { SizeLimitSettings } from "../settings/defaults.ts";
import type { PathModule } from "../startup.ts";
import type {
	EdgeRef,
	FactCard,
	GuardedRememberResult,
	MemoryStats,
	RecallInput,
	RecallResult,
	RememberInput,
	RememberResult,
	ScanFilter,
	ScannedFact,
	TagPage,
	TagQuery,
	WritableMemory,
} from "./port.ts";

export type SizeScope = "user" | "project";

export type SizeState =
	| "disabled"
	| "ok"
	| "warning"
	| "pressure"
	| "over-limit";

export interface MemoryFootprint {
	/** Manifest + current snapshot + journal + lock. */
	activeBytes: number;
	/** Old generations and temporary files belonging to this database. */
	overheadBytes: number;
	currentSnapshotBytes: number;
	journalBytes: number;
}

export interface SizeSnapshot {
	scope: SizeScope;
	footprint: MemoryFootprint;
	limitBytes: number;
	state: SizeState;
	ratio: number;
}

export class MemoryLimitError extends Error {
	readonly name = "MemoryLimitError";

	constructor(readonly snapshot: SizeSnapshot) {
		super(
			`Memory limit reached for ${snapshot.scope} memory: ` +
				`${snapshot.footprint.activeBytes} of ${snapshot.limitBytes} bytes. ` +
				"Safe memory growth is blocked until space is freed or the limit is increased.",
		);
	}
}

export class ProtectedFactError extends Error {
	readonly name = "ProtectedFactError";

	constructor(
		readonly scope: SizeScope,
		readonly id: number,
		readonly tags: readonly string[],
	) {
		super(
			`Fact [f${id}] is protected and cannot be removed automatically. ` +
				`Protected tags: ${tags.join(", ")}.`,
		);
	}
}

export interface SizeLimitOptions {
	scope: SizeScope;
	inner: WritableMemory;
	settings: SizeLimitSettings;
	fs: FileOps;
	pathModule: Pick<PathModule, "join" | "dirname" | "sep">;
	dbPath: string;
	/** Called after a mutation when the threshold state changes or is pressure. */
	onSize: (snapshot: SizeSnapshot) => void | Promise<void>;
}

/**
 * Measures the active database and reports old generations separately.
 *
 * The highest numbered published-looking snapshot is treated as current. The
 * writer cleans crash debris on open; excluding older generations keeps a
 * reader that pins history from making the logical memory limit impossible to
 * satisfy. Those bytes remain visible as overhead to the user.
 */
export async function measureDatabaseFootprint(
	fs: FileOps,
	pathModule: Pick<PathModule, "join" | "dirname" | "sep">,
	dbPath: string,
): Promise<MemoryFootprint> {
	const dir = pathModule.dirname(dbPath);
	const base = basename(dbPath, pathModule.sep);
	const files = await fs.listFiles(dir);
	const snapshots = files
		.map((name) => {
			const match = name.match(
				new RegExp(`^${escapeRegExp(base)}\\.snap\\.(\\d+)$`, "u"),
			);
			return match === null
				? undefined
				: { name, generation: Number(match[1]) };
		})
		.filter(
			(entry): entry is { name: string; generation: number } =>
				entry !== undefined && Number.isSafeInteger(entry.generation),
		);
	const current = snapshots.reduce(
		(highest, entry) =>
			entry.generation > (highest?.generation ?? -1) ? entry : highest,
		undefined as { name: string; generation: number } | undefined,
	);

	const size = async (name: string): Promise<number> =>
		(await fs.fileSize(pathModule.join(dir, name))) ?? 0;
	const manifest = await size(base);
	const journal = await size(`${base}.journal`);
	const lock = await size(`${base}.lock`);
	const currentSnapshot = current === undefined ? 0 : await size(current.name);
	const activeBytes = manifest + journal + lock + currentSnapshot;
	let overheadBytes = 0;
	for (const snapshot of snapshots) {
		if (snapshot.name !== current?.name)
			overheadBytes += await size(snapshot.name);
	}
	for (const file of files) {
		if (
			file === `${base}.tmp` ||
			(file.startsWith(`${base}.snap.`) && file.endsWith(".tmp")) ||
			file === `${base}.manifest.tmp`
		) {
			overheadBytes += await size(file);
		}
	}

	return {
		activeBytes,
		overheadBytes,
		currentSnapshotBytes: currentSnapshot,
		journalBytes: journal,
	};
}

/** A writable memory decorated with admission control and protected deletes. */
export class SizeLimitedMemory implements WritableMemory {
	private lastState: SizeState | undefined;
	private onSize: (snapshot: SizeSnapshot) => void | Promise<void>;

	constructor(private readonly options: SizeLimitOptions) {
		this.onSize = options.onSize;
	}

	setOnSize(callback: (snapshot: SizeSnapshot) => void | Promise<void>): void {
		this.onSize = callback;
	}

	async snapshot(): Promise<SizeSnapshot> {
		const footprint = await measureDatabaseFootprint(
			this.options.fs,
			this.options.pathModule,
			this.options.dbPath,
		);
		const limitBytes = this.limitBytes();
		const ratio = limitBytes === 0 ? 0 : footprint.activeBytes / limitBytes;
		const state = classifySize(ratio, limitBytes, this.options.settings);
		return { scope: this.options.scope, footprint, limitBytes, state, ratio };
	}

	async remember(input: RememberInput): Promise<RememberResult> {
		await this.beforeGrowth();
		const result = await this.options.inner.remember(input);
		await this.afterMutation();
		return result;
	}

	async rememberGuarded(input: RememberInput): Promise<GuardedRememberResult> {
		await this.beforeGrowth();
		const result = await this.options.inner.rememberGuarded(input);
		if (result.status === "stored") await this.afterMutation();
		return result;
	}

	async revise(id: number, input: RememberInput): Promise<RememberResult> {
		await this.beforeGrowth();
		const result = await this.options.inner.revise(id, input);
		await this.afterMutation();
		return result;
	}

	async forget(id: number): Promise<boolean> {
		const result = await this.options.inner.forget(id);
		await this.afterMutation();
		return result;
	}

	async forgetMany(ids: readonly number[]): Promise<boolean[]> {
		const result = await this.options.inner.forgetMany(ids);
		if (result.some(Boolean)) await this.afterMutation();
		return result;
	}

	async link(edge: EdgeRef): Promise<void> {
		await this.beforeGrowth();
		await this.options.inner.link(edge);
		await this.afterMutation();
	}

	async unlink(edge: Omit<EdgeRef, "provenance">): Promise<boolean> {
		const result = await this.options.inner.unlink(edge);
		await this.afterMutation();
		return result;
	}

	recall(input: RecallInput): Promise<RecallResult> {
		return this.options.inner.recall(input);
	}

	scan(filter: ScanFilter = {}): Promise<ScannedFact[]> {
		return this.options.inner.scan(filter);
	}

	get(id: number): Promise<FactCard | null> {
		return this.options.inner.get(id);
	}

	tagsOf(id: number): Promise<string[]> {
		return this.options.inner.tagsOf(id);
	}

	listEdges(): Promise<EdgeRef[]> {
		return this.options.inner.listEdges?.() ?? Promise.resolve([]);
	}

	listTags(query: TagQuery = {}): Promise<TagPage> {
		return this.options.inner.listTags(query);
	}

	stats(): Promise<MemoryStats> {
		return this.options.inner.stats();
	}

	async maintain(mode: "auto" | "compact" | "full" = "auto"): Promise<void> {
		await this.options.inner.maintain(mode);
		await this.afterMutation();
	}

	async checkpoint(): Promise<void> {
		await this.options.inner.checkpoint();
		await this.afterMutation();
	}

	private limitBytes(): number {
		return this.options.scope === "user"
			? this.options.settings.userBytes
			: this.options.settings.projectBytes;
	}

	private async beforeGrowth(): Promise<void> {
		const snapshot = await this.snapshot();
		if (
			snapshot.limitBytes > 0 &&
			snapshot.footprint.activeBytes >= snapshot.limitBytes
		) {
			throw new MemoryLimitError(snapshot);
		}
	}

	private async afterMutation(): Promise<void> {
		const snapshot = await this.snapshot();
		const enteredPressure =
			snapshot.state === "pressure" || snapshot.state === "over-limit";
		if (snapshot.state !== this.lastState || enteredPressure) {
			this.lastState = snapshot.state;
			await this.onSize(snapshot);
		}
	}
}

function classifySize(
	ratio: number,
	limitBytes: number,
	settings: SizeLimitSettings,
): SizeState {
	if (limitBytes === 0) return "disabled";
	if (ratio >= 1) return "over-limit";
	if (ratio >= settings.consolidationRatio) return "pressure";
	if (ratio >= settings.warningRatio) return "warning";
	return "ok";
}

function basename(file: string, separator: string): string {
	const at = file.lastIndexOf(separator);
	return at === -1 ? file : file.slice(at + separator.length);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
