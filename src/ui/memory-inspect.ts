import {
	CURSOR_MARKER,
	type KeyId,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { EdgeRef, FactCard } from "../storage/port.ts";

export type InspectScope = "project" | "user";

export interface InspectFactRow {
	scope: InspectScope;
	label: string;
	card: FactCard;
}

export interface InspectEdgeRow extends EdgeRef {
	scope: InspectScope;
	label: string;
}

export interface InspectSnapshot {
	facts: InspectFactRow[];
	edges: InspectEdgeRow[];
}

export type InspectKey = `${InspectScope}:${number}`;

export interface InspectDeleteResult {
	deleted: InspectKey[];
	message?: string;
}

export interface InspectUi {
	custom<T>(
		factory: (
			tui: {
				requestRender(): void;
				terminal: { rows: number };
			},
			theme: {
				fg(role: string, text: string): string;
				bold(text: string): string;
			},
			keybindings: unknown,
			done: (result: T) => void,
		) => {
			render(width: number): string[];
			invalidate(): void;
			handleInput(data: string): void;
		},
		options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
	): Promise<T>;
}

export interface InspectActions {
	search(
		query: string,
		tags: string[],
		scopes: readonly InspectScope[],
	): Promise<InspectFactRow[]>;
	delete(keys: InspectKey[]): Promise<InspectDeleteResult>;
}

const DEFAULT_PAGE_SIZE = 40;

/** Pure selection state, matching pi-planner's checkbox picker semantics. */
export class InspectSelection {
	cursor = 0;
	private readonly selected = new Set<InspectKey>();

	constructor(private facts: readonly InspectFactRow[]) {}

	setFacts(facts: readonly InspectFactRow[]): void {
		this.facts = facts;
		this.cursor = Math.min(this.cursor, Math.max(0, facts.length - 1));
		for (const key of this.selected) {
			if (!facts.some((fact) => factKey(fact) === key))
				this.selected.delete(key);
		}
	}

	move(delta: number): void {
		if (this.facts.length === 0) return;
		this.cursor = (this.cursor + delta + this.facts.length) % this.facts.length;
	}

	toggle(): void {
		const fact = this.facts[this.cursor];
		if (fact === undefined) return;
		const key = factKey(fact);
		if (this.selected.has(key)) this.selected.delete(key);
		else this.selected.add(key);
	}

	current(): InspectFactRow | undefined {
		return this.facts[this.cursor];
	}

	isSelected(fact: InspectFactRow): boolean {
		return this.selected.has(factKey(fact));
	}

	selectedKeys(): InspectKey[] {
		return this.facts
			.filter((fact) => this.selected.has(factKey(fact)))
			.map(factKey);
	}

	selectedCount(): number {
		return this.selected.size;
	}
}

export function factKey(fact: InspectFactRow): InspectKey {
	return `${fact.scope}:${fact.card.id}`;
}

export function parseInspectTags(value: string): string[] {
	return [
		...new Set(
			value
				.split(/[\s,]+/u)
				.map((tag) => tag.trim())
				.filter(Boolean),
		),
	];
}

export function inspectPage(
	facts: readonly InspectFactRow[],
	cursor: number,
	maxVisible = DEFAULT_PAGE_SIZE,
): { start: number; end: number } {
	if (facts.length <= maxVisible) return { start: 0, end: facts.length };
	const start = Math.min(
		Math.max(0, cursor - Math.floor(maxVisible / 2)),
		facts.length - maxVisible,
	);
	return { start, end: start + maxVisible };
}

export async function openMemoryInspector(
	ui: InspectUi,
	initial: InspectSnapshot,
	actions: InspectActions,
	pageSize = DEFAULT_PAGE_SIZE,
): Promise<void> {
	await ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let facts = initial.facts;
			const edges = initial.edges;
			let focus: "search" | "list" = "search";
			let searchField: "query" | "tags" | "scope" = "query";
			let query = "";
			let tags = "";
			let queryCursor = 0;
			let tagsCursor = 0;
			let scopeCursor = 0;
			const selectedScopes = new Set<InspectScope>(["project", "user"]);
			let expanded = false;
			let busy = "";
			let error = "";
			let notice = "";
			let searchTimer: ReturnType<typeof setTimeout> | undefined;
			let searchSerial = 0;
			const selection = new InspectSelection(facts);

			const renderRequest = () => tui.requestRender();

			const runSearch = () => {
				if (searchTimer !== undefined) clearTimeout(searchTimer);
				notice = "";
				const serial = ++searchSerial;
				searchTimer = setTimeout(async () => {
					busy = "Searching…";
					error = "";
					renderRequest();
					try {
						const next = await actions.search(query, parseInspectTags(tags), [
							...selectedScopes,
						]);
						if (serial !== searchSerial) return;
						facts = next;
						selection.setFacts(facts);
					} catch (reason) {
						if (serial === searchSerial)
							error = `Search failed: ${reason instanceof Error ? reason.message : String(reason)}`;
					} finally {
						if (serial === searchSerial) {
							busy = "";
							renderRequest();
						}
					}
				}, 120);
			};

			const deleteSelected = async () => {
				const keys = selection.selectedKeys();
				if (keys.length === 0) return;
				busy = `Deleting ${keys.length}…`;
				error = "";
				notice = "";
				renderRequest();
				try {
					const result = await actions.delete(keys);
					const deleted = result.deleted;
					const deletedSet = new Set(deleted);
					facts = facts.filter((fact) => !deletedSet.has(factKey(fact)));
					selection.setFacts(facts);
					expanded = false;
					notice =
						result.message ??
						(deleted.length === 0
							? "Nothing was deleted."
							: `Forgot ${deleted.length} fact${deleted.length === 1 ? "" : "s"}; removed from recall.`);
				} catch (reason) {
					error = `Delete failed: ${reason instanceof Error ? reason.message : String(reason)}`;
				} finally {
					busy = "";
					renderRequest();
				}
			};

			const edit = (
				value: string,
				cursor: number,
				key: KeyId,
			): [string, number] => {
				if (matchesKey(key, "backspace")) {
					if (cursor === 0) return [value, cursor];
					return [value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1];
				}
				if (matchesKey(key, "delete")) {
					return [value.slice(0, cursor) + value.slice(cursor + 1), cursor];
				}
				if (matchesKey(key, "left")) return [value, Math.max(0, cursor - 1)];
				if (matchesKey(key, "right"))
					return [value, Math.min(value.length, cursor + 1)];
				return [value, cursor];
			};

			const isPrintable = (data: string): boolean =>
				data.length > 0 &&
				[...data].every((char) => {
					const code = char.charCodeAt(0);
					return code >= 32 && code !== 127;
				});

			const inputLine = (
				label: string,
				value: string,
				cursor: number,
				active: boolean,
				width: number,
			): string => {
				const before = value.slice(0, cursor);
				const at = value.slice(cursor, cursor + 1) || " ";
				const after = value.slice(cursor + 1);
				const shown = `${active ? theme.fg("accent", "›") : " "} ${label}: ${before}${active ? CURSOR_MARKER : ""}\x1b[7m${at}\x1b[27m${after}`;
				return truncateToWidth(shown, width, "");
			};

			const wrap = (value: string, width: number): string[] =>
				wrapTextWithAnsi(value.replace(/[\r\n]+/gu, " "), Math.max(1, width));

			const detailLines = (fact: InspectFactRow, width: number): string[] => {
				const card = fact.card;
				const lines = [
					theme.fg("accent", `f${card.id} · ${fact.scope} · ${fact.label}`),
					...wrap(card.text, width),
					`Tags: ${card.tags.length === 0 ? "(none)" : card.tags.map((tag) => `#${tag}`).join(" ")}`,
					`Recorded: ${new Date(card.recordedAt).toISOString()}`,
					`Valid: ${new Date(card.validFrom).toISOString()} → ${card.validTo >= 8_640_000_000_000_000 ? "open" : new Date(card.validTo).toISOString()}`,
				];
				for (const [key, value] of Object.entries(card.metadata))
					lines.push(`Metadata ${key}: ${value}`);
				const linked = edges.filter((edge) => edge.scope === fact.scope);
				lines.push(`Links in ${fact.scope}: ${linked.length}`);
				for (const edge of linked)
					lines.push(
						`  ${edge.src} -${edge.rel}-> ${edge.dst}${edge.provenance === undefined ? "" : ` [f${edge.provenance}]`}`,
					);
				return lines;
			};

			return {
				render(width: number): string[] {
					const safe = Math.max(8, width);
					const contentWidth = Math.max(1, safe - 4);
					const border = (role: string, text: string): string =>
						theme.fg(role, text);
					const frameLine = (content = ""): string => {
						const clipped = truncateToWidth(content, contentWidth, "");
						return `${border("border", "│")} ${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))} ${border("border", "│")}`;
					};
					const frameTop = `${border("border", "╭")}${border("border", "─".repeat(Math.max(0, safe - 2)))}${border("border", "╮")}`;
					const frameBottom = `${border("border", "╰")}${border("border", "─".repeat(Math.max(0, safe - 2)))}${border("border", "╯")}`;
					const factLines = (
						fact: InspectFactRow,
						current: boolean,
					): string[] => {
						const checked = selection.isSelected(fact);
						const box = checked ? "[x]" : "[ ]";
						const lead = `${current ? "›" : " "} ${box} [f${fact.card.id}] ${fact.scope} · `;
						const continuation = " ".repeat(visibleWidth(lead));
						const textLines = wrap(
							fact.card.text,
							contentWidth - visibleWidth(lead),
						);
						const rows = [
							`${lead}${textLines[0] ?? ""}`,
							...textLines.slice(1).map((line) => `${continuation}${line}`),
						];
						return rows.map((line) =>
							current ? theme.fg("accent", line) : line,
						);
					};
					const scopeText = (["project", "user"] as const)
						.map((scope, index) => {
							const marker =
								focus === "search" &&
								searchField === "scope" &&
								scopeCursor === index
									? theme.fg("accent", "›")
									: " ";
							const box = selectedScopes.has(scope) ? "[x]" : "[ ]";
							return `${marker} ${box} ${scope}`;
						})
						.join("   ");
					const lines: string[] = [
						frameTop,
						frameLine(theme.fg("accent", theme.bold("Long-term memory"))),
						frameLine(
							theme.fg(
								"dim",
								"Search facts, inspect full data, and mark several for deletion",
							),
						),
						frameLine(
							inputLine(
								"Search",
								query,
								queryCursor,
								focus === "search" && searchField === "query",
								contentWidth,
							),
						),
						frameLine(
							inputLine(
								"Tags",
								tags,
								tagsCursor,
								focus === "search" && searchField === "tags",
								contentWidth,
							),
						),
						frameLine(`Scope: ${scopeText}`),
						frameLine(
							theme.fg(
								"dim",
								"Tab search/list · ↑↓ field/item · ←→ scope · Space select · Enter open/delete · x/Delete remove",
							),
						),
						frameLine(
							theme.fg(
								"dim",
								`${facts.length} result${facts.length === 1 ? "" : "s"} · ${edges.length} graph links · ${selection.selectedCount()} selected`,
							),
						),
					];
					if (busy !== "") lines.push(frameLine(theme.fg("warning", busy)));
					if (error !== "") lines.push(frameLine(theme.fg("error", error)));
					if (notice !== "") lines.push(frameLine(theme.fg("success", notice)));
					lines.push(
						frameLine(theme.fg("dim", "─".repeat(Math.max(1, contentWidth)))),
					);

					const visiblePageSize = Math.max(
						1,
						Math.min(pageSize, Math.max(3, tui.terminal.rows - 14)),
					);
					const page = inspectPage(facts, selection.cursor, visiblePageSize);
					if (facts.length === 0)
						lines.push(frameLine(theme.fg("dim", "No matching facts.")));
					for (let index = page.start; index < page.end; index++) {
						const fact = facts[index];
						if (fact === undefined) continue;
						const current = index === selection.cursor;
						for (const row of factLines(fact, current))
							lines.push(frameLine(row));
						if (expanded && current) {
							for (const detail of detailLines(fact, contentWidth - 2))
								for (const line of wrap(detail, contentWidth - 2))
									lines.push(frameLine(`  ${line}`));
						}
					}
					if (facts.length > page.end)
						lines.push(
							frameLine(theme.fg("dim", `… ${facts.length - page.end} more`)),
						);
					lines.push(
						frameLine(
							theme.fg(
								"dim",
								"Space only marks a fact · Enter or x/Delete starts confirmed deletion · Esc close",
							),
						),
					);
					lines.push(frameBottom);
					return lines.map((line) => truncateToWidth(line, safe, ""));
				},

				invalidate() {},

				handleInput(data: string): void {
					const is = (key: KeyId) => matchesKey(data, key);
					if (is("escape")) {
						done();
						return;
					}
					if (is("tab")) {
						focus = focus === "search" ? "list" : "search";
						renderRequest();
						return;
					}
					if (focus === "search") {
						if (searchField === "scope") {
							if (is("left")) scopeCursor = Math.max(0, scopeCursor - 1);
							else if (is("right")) scopeCursor = Math.min(1, scopeCursor + 1);
							else if (is("space")) {
								const scope = scopeCursor === 0 ? "project" : "user";
								if (selectedScopes.has(scope)) selectedScopes.delete(scope);
								else selectedScopes.add(scope);
								runSearch();
							} else if (is("up")) searchField = "tags";
							renderRequest();
							return;
						}
						const value = searchField === "query" ? query : tags;
						const cursor = searchField === "query" ? queryCursor : tagsCursor;
						if (is("down") || is("enter")) {
							searchField = searchField === "query" ? "tags" : "scope";
							renderRequest();
							return;
						}
						if (is("up")) {
							searchField = "query";
							renderRequest();
							return;
						}
						const [edited, nextCursor] = edit(value, cursor, data as KeyId);
						const nextValue = isPrintable(data)
							? value.slice(0, cursor) + data + value.slice(cursor)
							: edited;
						const nextPosition = isPrintable(data)
							? cursor + data.length
							: nextCursor;
						if (searchField === "query") {
							query = nextValue;
							queryCursor = nextPosition;
						} else {
							tags = nextValue;
							tagsCursor = nextPosition;
						}
						runSearch();
						renderRequest();
						return;
					}
					if (is("up")) selection.move(-1);
					else if (is("down")) selection.move(1);
					else if (is("space")) selection.toggle();
					else if (is("enter")) {
						if (selection.selectedCount() > 0) void deleteSelected();
						else expanded = !expanded;
					} else if (is("x") || is("delete")) void deleteSelected();
					renderRequest();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: "92%",
				maxHeight: "92%",
				anchor: "center",
				margin: 1,
			},
		},
	);
}
