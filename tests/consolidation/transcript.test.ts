import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	readTranscriptTail,
	sessionDirName,
} from "../../src/consolidation/transcript.ts";
import { FakeFs } from "../helpers/fake-fs.ts";

const posix = path.posix;

function line(role: string, text: string): string {
	return JSON.stringify({
		type: "message",
		message: { role, content: [{ type: "text", text }] },
	});
}

describe("sessionDirName", () => {
	it("matches the name pi actually writes", () => {
		// Reproduced from pi's own encoder rather than guessed: reading a
		// directory that does not exist would fail as "nothing to consolidate",
		// which is indistinguishable from working correctly.
		expect(sessionDirName("/home/m/Projects/app")).toBe(
			"--home-m-Projects-app--",
		);
	});

	it("flattens a windows path, drive colon included", () => {
		// The double dash after the drive letter is not a typo: pi replaces the
		// colon AND the separator, and both land next to each other. We mirror
		// its encoder exactly, quirk included - a prettier name would point at
		// a directory that does not exist.
		expect(sessionDirName("C:\\Users\\m\\app")).toBe("--C--Users-m-app--");
	});
});

describe("readTranscriptTail", () => {
	async function withSession(...lines: string[]) {
		const fs = new FakeFs();
		await fs.writeFile(
			"/agent/sessions/--home-m-app--/2026-01-01_a.jsonl",
			lines.join("\n"),
		);
		return fs;
	}

	it("returns nothing when the project has no session directory", async () => {
		const read = await readTranscriptTail(new FakeFs(), {
			flavour: posix,
			sessionsRoot: "/agent/sessions",
			cwd: "/home/m/app",
			maxChars: 1000,
		});
		expect(read.turns).toEqual([]);
		expect(read.cursor).toBeUndefined();
	});

	it("reads the messages a session file holds", async () => {
		const fs = await withSession(
			line("user", "fix the test"),
			line("assistant", "done"),
		);
		const read = await readTranscriptTail(fs, {
			flavour: posix,
			sessionsRoot: "/agent/sessions",
			cwd: "/home/m/app",
			maxChars: 1000,
		});
		expect(read.turns).toEqual([
			{ role: "user", text: "fix the test" },
			{ role: "assistant", text: "done" },
		]);
	});

	it("returns only what is new since the cursor", async () => {
		// The cursor is what makes a long session get consolidated in several
		// passes instead of one unliftable one.
		const fs = await withSession(line("user", "one"), line("user", "two"));
		const first = await readTranscriptTail(fs, {
			flavour: posix,
			sessionsRoot: "/agent/sessions",
			cwd: "/home/m/app",
			maxChars: 1000,
		});
		const second = await readTranscriptTail(fs, {
			flavour: posix,
			sessionsRoot: "/agent/sessions",
			cwd: "/home/m/app",
			maxChars: 1000,
			cursor: first.cursor,
		});
		expect(second.turns).toEqual([]);
	});

	it("advances the cursor past what it read", async () => {
		const fs = await withSession(line("user", "one"));
		const read = await readTranscriptTail(fs, {
			flavour: posix,
			sessionsRoot: "/agent/sessions",
			cwd: "/home/m/app",
			maxChars: 1000,
		});
		expect(read.cursor).toEqual({
			file: "2026-01-01_a.jsonl",
			line: 1,
		});
	});

	it("starts over when the session file changed", async () => {
		// A new session file means a new conversation, not a continuation, so a
		// line offset from the old one points at the wrong place entirely.
		const fs = await withSession(line("user", "one"));
		const read = await readTranscriptTail(fs, {
			flavour: posix,
			sessionsRoot: "/agent/sessions",
			cwd: "/home/m/app",
			maxChars: 1000,
			cursor: { file: "older.jsonl", line: 500 },
		});
		expect(read.turns).toHaveLength(1);
	});

	it("picks the newest file when a project has several", async () => {
		const fs = new FakeFs();
		await fs.writeFile(
			"/agent/sessions/--home-m-app--/2026-01-01_a.jsonl",
			line("user", "old"),
		);
		await fs.writeFile(
			"/agent/sessions/--home-m-app--/2026-02-01_b.jsonl",
			line("user", "new"),
		);
		const read = await readTranscriptTail(fs, {
			flavour: posix,
			sessionsRoot: "/agent/sessions",
			cwd: "/home/m/app",
			maxChars: 1000,
		});
		expect(read.turns[0]?.text).toBe("new");
	});

	it("keeps the newest end when the tail is over budget", async () => {
		const fs = await withSession(
			line("user", "x".repeat(400)),
			line("user", "NEWEST"),
		);
		const read = await readTranscriptTail(fs, {
			flavour: posix,
			sessionsRoot: "/agent/sessions",
			cwd: "/home/m/app",
			maxChars: 100,
		});
		expect(read.turns.at(-1)?.text).toBe("NEWEST");
		expect(read.turns).toHaveLength(1);
	});

	it("skips a malformed line instead of failing the pass", async () => {
		// These files are written by another program, and one unparseable line
		// must not cost the whole consolidation.
		const fs = await withSession(
			line("user", "one"),
			"{not json",
			line("user", "two"),
		);
		const read = await readTranscriptTail(fs, {
			flavour: posix,
			sessionsRoot: "/agent/sessions",
			cwd: "/home/m/app",
			maxChars: 1000,
		});
		expect(read.turns.map((turn) => turn.text)).toEqual(["one", "two"]);
	});

	it("ignores entries that are not messages", async () => {
		const fs = await withSession(
			JSON.stringify({ type: "model_change", model: "x" }),
			line("user", "one"),
		);
		const read = await readTranscriptTail(fs, {
			flavour: posix,
			sessionsRoot: "/agent/sessions",
			cwd: "/home/m/app",
			maxChars: 1000,
		});
		expect(read.turns).toHaveLength(1);
	});
});
