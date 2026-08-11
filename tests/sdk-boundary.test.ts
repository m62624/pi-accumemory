/**
 * Where the pi SDK is allowed to be imported.
 *
 * The peer dependency is `*` — the extension runs against whatever pi the user
 * has installed — so every SDK surface it touches is a surface that can move
 * underneath it. Keeping those touches in two named files means an SDK upgrade
 * is reviewed in two places rather than hunted for across forty, and it is what
 * makes the SDK-watch workflow's pass/fail signal mean something.
 *
 * Everything else in `src/` is plain TypeScript over its own interfaces, which
 * is also why nearly all of it is unit-testable without booting an agent.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;

/** The only files permitted to import `@earendil-works/*`. */
const BOUNDARY = ["index.ts", "consolidation/pi-agent.ts"];

async function sourceFiles(dir: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			files.push(...(await sourceFiles(path.join(dir, entry.name), relative)));
		} else if (entry.name.endsWith(".ts")) {
			files.push(relative);
		}
	}
	return files.sort();
}

describe("the pi SDK boundary", () => {
	it("is only crossed in the files that declare they cross it", async () => {
		const offenders: string[] = [];
		for (const file of await sourceFiles(SRC)) {
			const source = await readFile(path.join(SRC, file), "utf8");
			if (!source.includes("@earendil-works/")) continue;
			if (!BOUNDARY.includes(file)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	it("names files that actually exist and actually import it", async () => {
		// A boundary list that has drifted past the code protects nothing.
		for (const file of BOUNDARY) {
			const source = await readFile(path.join(SRC, file), "utf8");
			expect(source, `${file} no longer imports the SDK`).toContain(
				"@earendil-works/",
			);
		}
	});

	it("keeps the native memory engine out of everything but its adapter", async () => {
		// Same reasoning, different dependency: `plugmem` is a native addon, and
		// a module that reaches for it directly cannot be tested without it.
		const allowed = ["storage/plugmem-store.ts"];
		const offenders: string[] = [];
		for (const file of await sourceFiles(SRC)) {
			const source = await readFile(path.join(SRC, file), "utf8");
			if (!/from "plugmem"/.test(source)) continue;
			if (!allowed.includes(file)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});
