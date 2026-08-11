/**
 * plugmem's error codes, and what each one means for us.
 *
 * They arrive as `error.code` on a napi error - verified against the addon, not
 * assumed - which makes them the reliable thing to branch on. The message text
 * is for humans and may be reworded between releases.
 */

export const PLUGMEM_NEEDS_CHECKPOINT = "PLUGMEM_NEEDS_CHECKPOINT";
export const PLUGMEM_LOCKED = "PLUGMEM_LOCKED";
export const PLUGMEM_READ_ONLY = "PLUGMEM_READ_ONLY";
export const PLUGMEM_BUSY = "PLUGMEM_BUSY";

export function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/**
 * A database that exists but has never published a snapshot.
 *
 * Not a fault: a freshly created database has a journal and no snapshot, and so
 * does one that has never been opened at all. Read-only opens reject on it, and
 * the fix is to open it once as a writer and checkpoint. Without this branch a
 * clean machine cannot start.
 */
export function needsCheckpoint(error: unknown): boolean {
	return errorCode(error) === PLUGMEM_NEEDS_CHECKPOINT;
}

/** Another process holds the writer lock. */
export function isLocked(error: unknown): boolean {
	return errorCode(error) === PLUGMEM_LOCKED;
}
