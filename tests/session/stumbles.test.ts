/**
 * The counter has to be right about one thing above all: what counts as a
 * habit. Too eager and it spends permanent context on a bad evening; too shy
 * and it never notices anything.
 *
 * So the tests are mostly about the boundary - one occurrence is nothing, two
 * in one session is one session, twenty in one session is still one session -
 * and about the two ways the file on disk can lie: absent, and edited by hand.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	REPEATS_PER_SESSION,
	StumbleLog,
	unfixableNotice,
} from "../../src/session/stumbles.ts";
import { FakeFs } from "../helpers/fake-fs.ts";

const FILE = "/ext/state/stumbles.json";

function log(fs: FakeFs, sessionId: string): StumbleLog {
	return new StumbleLog({
		fs,
		file: FILE,
		flavour: path.posix,
		sessionId,
		now: () => new Date("2026-08-12T10:00:00Z"),
	});
}

/** Enough occurrences for one session to count. */
async function habitIn(one: StumbleLog): Promise<void> {
	for (let i = 0; i < REPEATS_PER_SESSION; i++) {
		await one.note("id_without_scope");
	}
}

describe("what counts as a habit", () => {
	it("ignores a single occurrence: everyone gets it wrong once", async () => {
		const fs = new FakeFs();
		const one = log(fs, "s1");
		await one.note("id_without_scope");
		expect(await one.report()).toEqual([]);
	});

	it("counts a session once it repeats inside it", async () => {
		const fs = new FakeFs();
		const one = log(fs, "s1");
		await habitIn(one);
		expect(await one.report()).toEqual([
			{
				kind: "id_without_scope",
				sessions: 1,
				lastSeen: "2026-08-12",
				covered: false,
				sinceCovered: 0,
			},
		]);
	});

	it("counts one session once, however many times it happens", async () => {
		const fs = new FakeFs();
		const one = log(fs, "s1");
		for (let i = 0; i < 20; i++) await one.note("id_without_scope");
		const [row] = await one.report();
		expect(row?.sessions).toBe(1);
	});

	it("adds a session when a different one repeats the mistake", async () => {
		const fs = new FakeFs();
		await habitIn(log(fs, "s1"));
		await habitIn(log(fs, "s2"));
		const third = log(fs, "s3");
		await habitIn(third);
		const [row] = await third.report();
		expect(row?.sessions).toBe(3);
	});

	it("keeps kinds apart", async () => {
		const fs = new FakeFs();
		const one = log(fs, "s1");
		await one.note("duplicate_refused");
		await one.note("duplicate_refused");
		await one.note("id_not_there");
		const report = await one.report();
		expect(report.map((row) => row.kind)).toEqual(["duplicate_refused"]);
	});

	it("reports the worst first", async () => {
		const fs = new FakeFs();
		for (const session of ["s1", "s2", "s3"]) {
			const one = log(fs, session);
			await one.note("id_without_scope");
			await one.note("id_without_scope");
		}
		const one = log(fs, "s4");
		await one.note("duplicate_refused");
		await one.note("duplicate_refused");
		const report = await one.report();
		expect(report[0]?.kind).toBe("id_without_scope");
	});
});

describe("what a pass is offered", () => {
	it("offers nothing below the threshold", async () => {
		const fs = new FakeFs();
		await habitIn(log(fs, "s1"));
		const one = log(fs, "s2");
		await habitIn(one);
		expect(await one.worstUncovered(3)).toBeUndefined();
	});

	it("offers the habit once it is one", async () => {
		const fs = new FakeFs();
		for (const session of ["s1", "s2", "s3"]) await habitIn(log(fs, session));
		const one = log(fs, "s4");
		expect((await one.worstUncovered(3))?.kind).toBe("id_without_scope");
	});

	it("offers exactly one kind, so one pass writes one rule", async () => {
		const fs = new FakeFs();
		for (const session of ["s1", "s2", "s3"]) {
			const one = log(fs, session);
			await one.note("id_without_scope");
			await one.note("id_without_scope");
			await one.note("duplicate_refused");
			await one.note("duplicate_refused");
		}
		const one = log(fs, "s4");
		const offered = await one.worstUncovered(3);
		expect(offered).toBeDefined();
		// The other one is still there; it is simply the next pass's business.
		expect((await one.report()).length).toBe(2);
	});

	it("stops offering a kind once a rule was written about it", async () => {
		const fs = new FakeFs();
		for (const session of ["s1", "s2", "s3"]) await habitIn(log(fs, session));
		const one = log(fs, "s4");
		await one.markCovered("id_without_scope");
		expect(await one.worstUncovered(3)).toBeUndefined();
	});
});

describe("a rule that did not work", () => {
	it("says nothing while the habit stays cured", async () => {
		const fs = new FakeFs();
		for (const session of ["s1", "s2", "s3"]) await habitIn(log(fs, session));
		const one = log(fs, "s4");
		await one.markCovered("id_without_scope");
		expect(await one.unfixable(3)).toEqual([]);
		expect(unfixableNotice(await one.unfixable(3))).toBe("");
	});

	it("counts the sessions that happened after the rule", async () => {
		const fs = new FakeFs();
		for (const session of ["s1", "s2", "s3"]) await habitIn(log(fs, session));
		await log(fs, "s3").markCovered("id_without_scope");
		for (const session of ["s4", "s5", "s6"]) await habitIn(log(fs, session));
		const one = log(fs, "s7");
		const stuck = await one.unfixable(3);
		expect(stuck[0]?.sinceCovered).toBe(3);
		expect(stuck[0]?.sessions).toBe(6);
	});

	it("tells the human it is probably not the model", async () => {
		const notice = unfixableNotice([
			{
				kind: "id_without_scope",
				sessions: 6,
				lastSeen: "2026-08-12",
				covered: true,
				sinceCovered: 3,
			},
		]);
		expect(notice).toContain("id_without_scope: 6 sessions");
		expect(notice).toContain("not that the model will not learn");
	});
});

describe("the file on disk", () => {
	it("starts from nothing when there is none", async () => {
		expect(await log(new FakeFs(), "s1").report()).toEqual([]);
	});

	it("survives a corrupt file rather than refusing to work", async () => {
		const fs = new FakeFs();
		await fs.writeFile(FILE, "{ not json");
		const one = log(fs, "s1");
		await habitIn(one);
		expect((await one.report())[0]?.sessions).toBe(1);
	});

	it("ignores a kind somebody invented by hand", async () => {
		const fs = new FakeFs();
		await fs.writeFile(
			FILE,
			JSON.stringify({
				made_up_kind: {
					sessions: 99,
					lastSession: "x",
					lastSeen: "2026-01-01",
					covered: false,
					sinceCovered: 0,
				},
			}),
		);
		// Otherwise a hand-edited file could put an unknown string in front of
		// the model as though the runtime had observed it.
		expect(await log(fs, "s1").report()).toEqual([]);
	});

	it("ignores an entry of the wrong shape", async () => {
		const fs = new FakeFs();
		await fs.writeFile(
			FILE,
			JSON.stringify({ id_without_scope: { sessions: "many" } }),
		);
		expect(await log(fs, "s1").report()).toEqual([]);
	});

	it("never lets a write failure reach the caller", async () => {
		const fs = new FakeFs();
		fs.failWrites = new Error("read-only disk");
		const one = log(fs, "s1");
		await expect(habitIn(one)).resolves.toBeUndefined();
	});
});
