import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTranscriptTail } from "../../src/consolidation/transcript.ts";
import { FakeFs } from "../helpers/fake-fs.ts";

const dir = "/agent/sessions/--home-m-app--";

async function withLines(...lines: string[]) {
	const fs = new FakeFs();
	await fs.writeFile(`${dir}/2026-01-01_a.jsonl`, lines.join("\n"));
	return fs;
}

function read(fs: FakeFs, maxChars = 1000) {
	return readTranscriptTail(fs, {
		flavour: path.posix,
		sessionsRoot: "/agent/sessions",
		cwd: "/home/m/app",
		maxChars,
	});
}

describe("readTranscriptTail edge cases", () => {
	it("ignores files that are not session transcripts", async () => {
		const fs = new FakeFs();
		await fs.writeFile(`${dir}/notes.txt`, "not a transcript");
		expect((await read(fs)).turns).toEqual([]);
	});

	it("returns nothing for an empty transcript file", async () => {
		expect((await read(await withLines(""))).turns).toEqual([]);
	});

	it("skips a JSON line that is not an object", async () => {
		// These files are written by another program; one odd line must not
		// cost the whole pass.
		const fs = await withLines("null", "42", '"a string"');
		expect((await read(fs)).turns).toEqual([]);
	});

	it("skips a message whose content yields no text", async () => {
		const fs = await withLines(
			JSON.stringify({
				type: "message",
				message: { role: "user", content: [] },
			}),
			JSON.stringify({
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "real" }] },
			}),
		);
		expect((await read(fs)).turns).toEqual([{ role: "user", text: "real" }]);
	});

	it("skips a message of a role it does not know", async () => {
		const fs = await withLines(
			JSON.stringify({
				type: "message",
				message: { role: "system", content: "x" },
			}),
		);
		expect((await read(fs)).turns).toEqual([]);
	});

	it("applies no budget when maxChars is zero", async () => {
		const fs = await withLines(
			JSON.stringify({
				type: "message",
				message: { role: "user", content: "x".repeat(5000) },
			}),
		);
		expect((await read(fs, 0)).turns).toHaveLength(1);
	});

	it("keeps at least the newest turn even when it alone exceeds the budget", async () => {
		// Returning nothing would mean the pass never sees a long message, and
		// the cursor would step over it on the next run.
		const fs = await withLines(
			JSON.stringify({
				type: "message",
				message: { role: "user", content: "y".repeat(5000) },
			}),
		);
		expect((await read(fs, 10)).turns).toHaveLength(1);
	});
});
