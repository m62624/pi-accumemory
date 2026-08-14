import { describe, expect, it } from "vitest";
import {
	buildRebindOptions,
	orderCandidates,
	REBIND_PAGE_SIZE,
	type RebindCandidate,
	rebindLabel,
	resolveRebindPick,
} from "../../src/ui/rebind-picker.ts";

function candidate(over: Partial<RebindCandidate> = {}): RebindCandidate {
	return {
		projectId: "aaa111",
		name: "app",
		path: "/home/m/Projects/app",
		bound: true,
		folderExists: true,
		databaseExists: true,
		facts: 84,
		current: false,
		...over,
	};
}

describe("orderCandidates", () => {
	it("offers unbound memories first, then ones whose folder is not here", () => {
		// The two groups a person looks for after copying a memory directory from
		// another machine. Anything else is a folder they can just open.
		const ordered = orderCandidates([
			candidate({ projectId: "ccc333", name: "here" }),
			candidate({ projectId: "bbb222", name: "gone", folderExists: false }),
			candidate({ projectId: "aaa111", name: "loose", bound: false }),
		]);
		expect(ordered.map((c) => c.projectId)).toEqual([
			"aaa111",
			"bbb222",
			"ccc333",
		]);
	});

	it("sorts by folder name inside a group, so the list does not reshuffle", () => {
		const ordered = orderCandidates([
			candidate({ projectId: "b", name: "zeta" }),
			candidate({ projectId: "a", name: "alpha" }),
		]);
		expect(ordered.map((c) => c.name)).toEqual(["alpha", "zeta"]);
	});
});

describe("rebindLabel", () => {
	it("names the id, the folder, the size and the full path", () => {
		const label = rebindLabel(candidate(), 1, 120);
		expect(label).toContain("aaa111");
		expect(label).toContain("app");
		expect(label).toContain("84 facts");
		expect(label).toContain("/home/m/Projects/app");
	});

	it("marks an unbound memory and calls its path history", () => {
		// Otherwise the path reads as a live binding, and the row looks like a
		// project the user simply has not opened lately.
		const label = rebindLabel(candidate({ bound: false }), 1, 120);
		expect(label).toContain("NOT BOUND");
		expect(label).toContain("was: /home/m/Projects/app");
	});

	it("marks a folder that is not on this machine, and a missing database", () => {
		expect(rebindLabel(candidate({ folderExists: false }), 1, 120)).toContain(
			"FOLDER GONE",
		);
		expect(rebindLabel(candidate({ databaseExists: false }), 1, 120)).toContain(
			"NO DATABASE",
		);
	});

	it("says so when the count could not be read, rather than showing zero", () => {
		const label = rebindLabel(candidate({ facts: undefined }), 1, 120);
		expect(label).toContain("facts unknown");
		expect(label).not.toContain("0 facts");
	});

	it("counts one fact in the singular", () => {
		expect(rebindLabel(candidate({ facts: 1 }), 1, 120)).toContain("1 fact ");
	});

	it("never exceeds the terminal width", () => {
		const label = rebindLabel(candidate({ path: "/x".repeat(200) }), 1, 40);
		expect([...label]).toHaveLength(40);
	});
});

describe("buildRebindOptions", () => {
	it("keeps labels distinct even when clipped to an absurd width", () => {
		// `ui.select` answers with the chosen STRING, so two identical labels
		// would be one unresolvable row. The leading ordinal is what guarantees
		// this at any width the layout floor allows.
		const same = { path: "/home/m/very/long/path/that/gets/clipped/away" };
		const options = buildRebindOptions(
			[
				candidate({ projectId: "aaa111", ...same }),
				candidate({ projectId: "bbb222", ...same }),
			],
			{ width: 10 },
		);
		const labels = options.map((option) => option.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("pages a long roster and offers a way forward, not a wall of rows", () => {
		const many = Array.from({ length: REBIND_PAGE_SIZE + 3 }, (_, index) =>
			candidate({ projectId: `id${index}`, name: `p${index}` }),
		);
		const first = buildRebindOptions(many, { width: 100 });
		expect(first.filter((o) => o.pick.kind === "bind")).toHaveLength(
			REBIND_PAGE_SIZE,
		);
		expect(first.at(-1)?.pick).toEqual({ kind: "page", page: 1 });

		const second = buildRebindOptions(many, { page: 1, width: 100 });
		expect(second.filter((o) => o.pick.kind === "bind")).toHaveLength(3);
		expect(second.at(-1)?.pick).toEqual({ kind: "page", page: 0 });
	});

	it("clamps a page number nobody could have reached", () => {
		const options = buildRebindOptions([candidate()], { page: 9, width: 100 });
		expect(options).toHaveLength(1);
		expect(options[0]?.pick).toEqual({ kind: "bind", projectId: "aaa111" });
	});

	it("has nothing to offer when there are no memories", () => {
		expect(buildRebindOptions([], { width: 100 })).toEqual([]);
	});
});

describe("resolveRebindPick", () => {
	it("maps the selected line back to exactly one memory", () => {
		const options = buildRebindOptions(
			[candidate({ projectId: "aaa111" }), candidate({ projectId: "bbb222" })],
			{ width: 100 },
		);
		const second = options[1];
		expect(resolveRebindPick(options, second?.label ?? "")).toEqual({
			kind: "bind",
			projectId: second?.pick.kind === "bind" ? second.pick.projectId : "",
		});
	});

	it("answers null for a line it did not write", () => {
		expect(resolveRebindPick([], "whatever the terminal sent")).toBeNull();
	});
});
