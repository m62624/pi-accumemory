/**
 * The rows of the "which memory belongs to this folder" picker.
 *
 * A memory database is portable - plugmem's snapshot is byte-identical on every
 * platform, and its workspace naming rules exist so a directory can be copied
 * between machines. What is not portable is the BINDING: a project is found by
 * its absolute path, and that path is different on the other machine. So a copied
 * memory arrives intact and unreachable, and something has to reattach it.
 *
 * That something is a person, not a heuristic. Matching folder names, or git
 * remotes, would guess - and a wrong guess merges two memories, which cannot be
 * undone (see `ProjectRouter.relocate`). Here the machine only shows what it has;
 * the choice is made by someone who can recognise their own project.
 *
 * Pure: every function is a fold over plain data, so the layout, the paging and
 * the marks are tested without a terminal. `index.ts` does the talking.
 */

import { fitLine } from "./fit.ts";

/** One memory the picker can offer, as the session found it on disk. */
export interface RebindCandidate {
	projectId: string;
	/** The folder name — what a person calls the project. */
	name: string;
	/** Where it is bound, or where it was bound before it was released. */
	path: string;
	/** False once released: the path above is history, not a binding. */
	bound: boolean;
	/** Whether that folder exists on THIS machine. */
	folderExists: boolean;
	/** Whether the database file is there at all. */
	databaseExists: boolean;
	/** Live facts, or `undefined` when the database would not open. */
	facts?: number;
	/** Whether this is the memory serving the folder we are standing in. */
	current: boolean;
}

/** What a row in the picker means. */
export type RebindPick =
	| { kind: "bind"; projectId: string }
	| { kind: "page"; page: number };

/** One picker row: the text shown, and the choice it stands for. */
export interface RebindOption {
	label: string;
	pick: RebindPick;
}

/**
 * How many memories one page shows.
 *
 * The SDK's `ui.select` renders a flat list with no scrollback, so an unbounded
 * roster scrolls its own top off-screen. Same size as pi-telegram-manager's
 * session picker, for the same reason.
 */
export const REBIND_PAGE_SIZE = 8;

const OLDER_LABEL = "▽  More memories";
const NEWER_LABEL = "△  Previous page";

/**
 * The order the rows are offered in.
 *
 * Released memories first, then ones bound to a folder that is not on this
 * machine. Those two groups are exactly what somebody who has just copied a
 * memory directory is looking for, so they are not made to scroll for it. Within
 * a group, by folder name, so the list does not reshuffle between runs.
 */
export function orderCandidates(
	candidates: readonly RebindCandidate[],
): RebindCandidate[] {
	const rank = (candidate: RebindCandidate): number => {
		if (!candidate.bound) return 0;
		if (!candidate.folderExists) return 1;
		return 2;
	};
	return [...candidates].sort(
		(a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
	);
}

/**
 * A row's text, numbered from 1 within its page.
 *
 * The number is load-bearing rather than decoration. `ui.select` answers with the
 * chosen STRING, not an index, so two rows sharing a label are indistinguishable -
 * and a label is clipped from the right on a narrow terminal, which can eat every
 * field that told them apart. A leading ordinal survives any width the layout
 * floor allows, so a row always resolves back to exactly one memory.
 *
 * After that come the marks (a row must not have to be wide to warn you), the id,
 * and the full path - which is what a person actually recognises the project by.
 * On an unbound row the path is prefixed `was:` so it is not misread as a live
 * binding.
 */
export function rebindLabel(
	candidate: RebindCandidate,
	position: number,
	width: number,
): string {
	const marks: string[] = [];
	if (candidate.current) marks.push("●");
	if (!candidate.bound) marks.push("✗ NOT BOUND");
	else if (!candidate.folderExists) marks.push("? FOLDER GONE");
	if (!candidate.databaseExists) marks.push("! NO DATABASE");

	const facts =
		candidate.facts === undefined
			? "facts unknown"
			: `${candidate.facts} ${candidate.facts === 1 ? "fact" : "facts"}`;
	const where = candidate.bound ? candidate.path : `was: ${candidate.path}`;
	const parts = [...marks, candidate.projectId, candidate.name, facts, where];
	return fitLine(`${position})  ${parts.join("  ·  ")}`, width);
}

/**
 * The rows for one page.
 *
 * A page row (`▽` / `△`) re-opens the picker on another page rather than choosing
 * anything, which is how a scrollback-less selector stays navigable.
 */
export function buildRebindOptions(
	candidates: readonly RebindCandidate[],
	options: { page?: number; width: number },
): RebindOption[] {
	const ordered = orderCandidates(candidates);
	const pageCount = rebindPageCount(candidates);
	const page = Math.min(Math.max(options.page ?? 0, 0), pageCount - 1);
	const start = page * REBIND_PAGE_SIZE;

	const rows: RebindOption[] = ordered
		.slice(start, start + REBIND_PAGE_SIZE)
		.map((candidate, index) => ({
			label: rebindLabel(candidate, index + 1, options.width),
			pick: { kind: "bind" as const, projectId: candidate.projectId },
		}));
	if (page > 0) {
		rows.push({ label: NEWER_LABEL, pick: { kind: "page", page: page - 1 } });
	}
	if (page < pageCount - 1) {
		rows.push({ label: OLDER_LABEL, pick: { kind: "page", page: page + 1 } });
	}
	return rows;
}

/** How many pages the roster spans (at least one, even when empty). */
export function rebindPageCount(
	candidates: readonly RebindCandidate[],
): number {
	return Math.max(1, Math.ceil(candidates.length / REBIND_PAGE_SIZE));
}

/** Map the label the selector returned back to its choice (null if it matches none). */
export function resolveRebindPick(
	options: readonly RebindOption[],
	selectedLabel: string,
): RebindPick | null {
	return options.find((option) => option.label === selectedLabel)?.pick ?? null;
}
