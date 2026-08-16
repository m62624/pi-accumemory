import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	factKey,
	type InspectFactRow,
	type InspectScope,
	InspectSelection,
	type InspectSnapshot,
	inspectPage,
	openMemoryInspector,
	parseInspectTags,
} from "../../src/ui/memory-inspect.ts";

function fact(
	id: number,
	scope: "project" | "user" = "project",
): InspectFactRow {
	return {
		scope,
		label: scope === "project" ? "demo project" : "shared memory",
		card: {
			id,
			text: `synthetic fact ${id}`,
			tags: id % 2 === 0 ? ["demo", "stable"] : [],
			metadata: { source: "test" },
			recordedAt: 1_700_000_000_000,
			validFrom: 1_700_000_000_000,
			validTo: Number.MAX_SAFE_INTEGER,
		},
	};
}

describe("memory inspector selection", () => {
	it("keeps project and shared ids distinct", () => {
		const project = fact(4, "project");
		const shared = fact(4, "user");
		expect(factKey(project)).not.toBe(factKey(shared));

		const model = new InspectSelection([project, shared]);
		model.toggle();
		model.move(1);
		model.toggle();
		expect(model.selectedKeys()).toEqual(["project:4", "user:4"]);
	});

	it("removes selections that disappeared after a search", () => {
		const model = new InspectSelection([fact(1), fact(2)]);
		model.move(1);
		model.toggle();
		model.toggle();
		model.setFacts([fact(1)]);
		expect(model.selectedKeys()).toEqual([]);
		const empty = new InspectSelection([]);
		empty.move(1);
		empty.toggle();
		expect(empty.current()).toBeUndefined();
	});
});

describe("memory inspector filters and paging", () => {
	it("parses comma and whitespace separated tags without duplicates", () => {
		expect(parseInspectTags("demo, stable demo  local")).toEqual([
			"demo",
			"stable",
			"local",
		]);
	});

	it("honours the configured page size and keeps the cursor visible", () => {
		const facts = Array.from({ length: 9 }, (_, index) => fact(index));
		expect(inspectPage(facts, 7, 3)).toEqual({ start: 6, end: 9 });
		expect(inspectPage(facts, 8, 5)).toEqual({ start: 4, end: 9 });
	});
});

function snapshotFacts(): InspectFactRow[] {
	return [fact(1), fact(2, "user")];
}

function fakeSnapshot() {
	return {
		facts: snapshotFacts(),
		edges: [
			{
				scope: "project" as const,
				label: "demo project",
				src: "service",
				rel: "uses",
				dst: "cache",
				provenance: 1,
			},
		],
	};
}

const testTheme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
};

async function driveInspector(
	initial: InspectSnapshot,
	actions: {
		search: (
			query: string,
			tags: string[],
			scopes: readonly InspectScope[],
		) => Promise<InspectFactRow[]>;
		delete: (
			keys: `${"project" | "user"}:${number}`[],
		) => Promise<`${"project" | "user"}:${number}`[]>;
	},
	drive: (component: {
		render(width: number): string[];
		handleInput(data: string): void;
	}) => Promise<void>,
): Promise<void> {
	type Factory = (
		tui: { requestRender(): void; terminal: { rows: number } },
		theme: typeof testTheme,
		keybindings: unknown,
		done: (value: undefined) => void,
	) => { render(width: number): string[]; handleInput(data: string): void };
	const ui = {
		custom: async (factory: Factory) =>
			await new Promise<void>((resolve) => {
				let result: undefined;
				const component = factory(
					{ requestRender: () => {}, terminal: { rows: 40 } },
					testTheme,
					{},
					(value: undefined) => {
						result = value;
						resolve();
					},
				);
				void drive(component).then(() => {
					if (result === undefined) component.handleInput("\x1b");
				});
			}),
	};
	await openMemoryInspector(ui as never, initial, actions, 3);
}

describe("memory inspector TUI", () => {
	it("searches, filters, expands, checks and deletes through one UI session", async () => {
		const searches: string[] = [];
		const deleted: string[][] = [];
		await driveInspector(
			fakeSnapshot(),
			{
				search: async (query, tags) => {
					searches.push(`${query}|${tags.join(",")}`);
					return snapshotFacts();
				},
				delete: async (keys) => {
					deleted.push(keys);
					return keys;
				},
			},
			async (component) => {
				expect(
					component.render(24).every((line) => visibleWidth(line) <= 24),
				).toBe(true);
				component.handleInput("a");
				component.handleInput("\x7f");
				component.handleInput("a");
				component.handleInput("\x1b[D");
				component.handleInput("\x1b[C");
				component.handleInput("\x7f");
				component.handleInput("\x1b[3~");
				await new Promise((resolve) => setTimeout(resolve, 140));
				component.handleInput("\t");
				component.handleInput("d");
				await new Promise((resolve) => setTimeout(resolve, 140));
				component.handleInput("\t");
				component.handleInput("\t");
				component.handleInput("\r");
				expect(component.render(100).join("\n")).toContain(
					"Links in project: 1",
				);
				component.handleInput(" ");
				component.handleInput("\r");
				await new Promise((resolve) => setTimeout(resolve, 30));
				expect(component.render(100).join("\n")).toContain("0 selected");
			},
		);
		expect(searches).toContain("|d");
		expect(deleted).toEqual([["project:1"]]);
	});

	it("filters by scope and wraps long facts inside a closed frame", async () => {
		const scopes: InspectScope[][] = [];
		const long = fact(8, "project");
		long.card.text =
			"a synthetic fact with enough words to wrap inside the inspector window";
		await driveInspector(
			{ facts: [long, fact(9, "user")], edges: [] },
			{
				search: async (_query, _tags, selected) => {
					scopes.push([...selected]);
					return [long];
				},
				delete: async (keys) => keys,
			},
			async (component) => {
				const rendered = component.render(60);
				expect(rendered.every((line) => visibleWidth(line) <= 60)).toBe(true);
				expect(rendered.some((line) => line.endsWith("│"))).toBe(true);
				expect(rendered.some((line) => line.includes("╯"))).toBe(true);
				component.handleInput("\t");
				component.handleInput("\t");
				expect(component.render(60).join("\n")).toContain("Scope:");
				component.handleInput("\x1b[C");
				component.handleInput("\x1b[D");
				component.handleInput("\x1b[B");
				component.handleInput("\x1b[A");
				component.handleInput(" ");
				component.handleInput("\x1b[C");
				component.handleInput(" ");
				component.handleInput(" ");
				await new Promise((resolve) => setTimeout(resolve, 140));
			},
		);
		expect(scopes.at(-1)).toEqual(["user"]);
	});

	it("renders search and delete failures without escaping the window", async () => {
		let deleteCalls = 0;
		await driveInspector(
			fakeSnapshot(),
			{
				search: async () => {
					throw new Error("synthetic search failure");
				},
				delete: async () => {
					deleteCalls += 1;
					throw { kind: "synthetic delete failure" };
				},
			},
			async (component) => {
				component.handleInput("\x7f");
				component.handleInput("q");
				await new Promise((resolve) => setTimeout(resolve, 140));
				expect(component.render(40).join("\n")).toContain("Search failed");
				component.handleInput("\t");
				component.handleInput("\t");
				component.handleInput(" ");
				component.handleInput("\t");
				component.handleInput(" ");
				component.handleInput("x");
				await new Promise((resolve) => setTimeout(resolve, 30));
				expect(component.render(40).join("\n")).toContain("Delete failed");
			},
		);
		expect(deleteCalls).toBe(1);
	});

	it("handles an empty result and a configured scrolling page", async () => {
		const many = Array.from({ length: 6 }, (_, index) => fact(index + 1));
		await driveInspector(
			{ facts: many, edges: [] },
			{
				search: async () => [],
				delete: async (keys) => keys,
			},
			async (component) => {
				component.handleInput("q");
				await new Promise((resolve) => setTimeout(resolve, 140));
				expect(component.render(80).join("\n")).toContain("No matching facts");
				component.handleInput("\x1b[B");
				component.handleInput("\x1b[B");
				component.handleInput("x");
			},
		);

		await driveInspector(
			{ facts: many, edges: [] },
			{
				search: async () => many,
				delete: async () => [],
			},
			async (component) => {
				expect(component.render(100).join("\n")).toContain("more");
				component.handleInput("\t");
				component.handleInput("\t");
				component.handleInput("\t");
				component.handleInput("\x1b[B");
				component.handleInput("\x1b[A");
				component.handleInput(" ");
				expect(component.render(100).join("\n")).toContain("[x]");
				component.handleInput("\r");
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(component.render(100).join("\n")).toContain("1 selected");
			},
		);
		let rejectFirst: (() => void) | undefined;
		let failedCalls = 0;
		await driveInspector(
			fakeSnapshot(),
			{
				search: async () => {
					failedCalls += 1;
					if (failedCalls === 1)
						return new Promise<InspectFactRow[]>((_resolve, reject) => {
							rejectFirst = () => reject(new Error("stale"));
						});
					return snapshotFacts();
				},
				delete: async (keys) => keys,
			},
			async (component) => {
				component.handleInput("z");
				await new Promise((resolve) => setTimeout(resolve, 140));
				component.handleInput("y");
				await new Promise((resolve) => setTimeout(resolve, 140));
				rejectFirst?.();
				await new Promise((resolve) => setTimeout(resolve, 10));
			},
		);
	});

	it("drops stale search completions", async () => {
		let calls = 0;
		let releaseFirst: (() => void) | undefined;
		await driveInspector(
			fakeSnapshot(),
			{
				search: async () => {
					calls += 1;
					if (calls === 1)
						return new Promise<InspectFactRow[]>((resolve) => {
							releaseFirst = () => resolve([]);
						});
					return snapshotFacts();
				},
				delete: async (keys) => keys,
			},
			async (component) => {
				component.handleInput("a");
				await new Promise((resolve) => setTimeout(resolve, 140));
				component.handleInput("b");
				await new Promise((resolve) => setTimeout(resolve, 140));
				releaseFirst?.();
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(component.render(80).join("\n")).toContain("2 results");
			},
		);
	});

	it("skips a sparse result slot without breaking rendering", async () => {
		const sparse: InspectFactRow[] = [];
		sparse[1] = fact(9);
		await driveInspector(
			{ facts: sparse, edges: [] },
			{ search: async () => sparse, delete: async (keys) => keys },
			async (component) => {
				expect(component.render(80).join("\n")).toContain("f9");
			},
		);
	});

	it("shows non-empty tags, closed validity, metadata and unprovenanced links", async () => {
		const detailed = fact(7);
		detailed.card.text = "";
		detailed.card.tags = ["demo"];
		detailed.card.validTo = detailed.card.validFrom + 1000;
		await driveInspector(
			{
				facts: [detailed],
				edges: [
					{
						scope: "project",
						label: "demo project",
						src: "service",
						rel: "owns",
						dst: "cache",
					},
				],
			},
			{
				search: async () => [detailed],
				delete: async (keys) => keys,
			},
			async (component) => {
				component.handleInput("\t");
				component.handleInput("\t");
				component.handleInput("\t");
				component.handleInput("\r");
				const rendered = component.render(100).join("\n");
				expect(rendered).toContain("Tags: #demo");
				expect(rendered).toContain("Valid:");
				expect(rendered).toContain("Links in project: 1");
			},
		);
	});

	it("shows a busy deletion state while the batch is in flight", async () => {
		await driveInspector(
			fakeSnapshot(),
			{
				search: async () => snapshotFacts(),
				delete: async (keys) => {
					await new Promise((resolve) => setTimeout(resolve, 50));
					return keys;
				},
			},
			async (component) => {
				component.handleInput("\t");
				component.handleInput("\t");
				component.handleInput("\t");
				component.handleInput("\x1b[3~");
				component.handleInput(" ");
				component.handleInput("x");
				expect(component.render(100).join("\n")).toContain("Deleting 1");
				await new Promise((resolve) => setTimeout(resolve, 70));
				component.handleInput("\x1b[3~");
				component.handleInput("\t");
			},
		);
	});
});
