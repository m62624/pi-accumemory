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

/**
 * The stored vectors were produced in a different semantic space than the one
 * now configured.
 *
 * This is the failure mode behind changing the embedding model. The database
 * still OPENS - which is what makes it dangerous - and then every recall and
 * every write fails, so the memory is not degraded but dead. The engine reports
 * it as `PLUGMEM_ENGINE` with a distinctive message, so the message is what
 * identifies it; the code alone is too broad to branch on.
 */
export function isVectorSpaceMismatch(error: unknown): boolean {
	if (errorCode(error) !== PLUGMEM_ENGINE) return false;
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("vector space mismatch");
}

export const PLUGMEM_ENGINE = "PLUGMEM_ENGINE";

/**
 * The embedding provider could not be reached, or answered with something
 * unusable, and the engine was told to fail rather than carry on.
 *
 * Only reachable under `on_error = "fail"`: with the default this extension
 * writes, `"degrade"`, plugmem stores and answers without the vector instead
 * and suspends the embedder, so nothing throws at all. Someone who chose to
 * fail chose to be told - but "PLUGMEM_ENGINE: embedder: error sending
 * request" reaching the model as a tool error tells the wrong reader in the
 * wrong words, and the model then decides the memory is broken.
 *
 * The engine reports it as `PLUGMEM_ENGINE` with a message that starts at the
 * embedder, so the message is what identifies it - the code alone covers every
 * engine failure there is.
 */
export function isEmbedderFailure(error: unknown): boolean {
	if (errorCode(error) !== PLUGMEM_ENGINE) return false;
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("embedder:");
}
