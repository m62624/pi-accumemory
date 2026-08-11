/**
 * A real plugmem database in a temporary directory, cleaned up afterwards.
 *
 * The unit tests run against `FakeMemory`; these run against the addon. Both
 * are needed: the fake proves the logic, and only the real engine proves the
 * assumptions the logic rests on - that ids start at zero, that a read-only
 * handle coexists with a writer, that a fresh database rejects a read-only
 * open until it has been checkpointed once.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempWorkspace {
	dir: string;
	/** Native path of a database inside it; the file appears on first write. */
	db(name: string): string;
	cleanup(): Promise<void>;
}

export async function tempWorkspace(): Promise<TempWorkspace> {
	const dir = await mkdtemp(join(tmpdir(), "pi-accumemory-"));
	return {
		dir,
		db: (name: string) => join(dir, `${name}.plugmem`),
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}
