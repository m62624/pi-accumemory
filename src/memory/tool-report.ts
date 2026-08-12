/**
 * What the PERSON sees when a memory tool runs.
 *
 * The module next door explains the split: the model gets everything, the
 * person gets what they asked for. Until now only writes honoured it, so every
 * other tool printed its model-facing answer straight into the terminal - and
 * that answer is addressed to a reader for whom `[f2]` is the whole point,
 * because an id is how a fact is spoken to. To a person `[f2]` is nothing.
 * "Forgot [f2], [f5], [f6], [f7]" says four things went away and not one word
 * about what they were.
 *
 * So each tool reports what it did as data, and this file turns that into one
 * line for a person. Two rules run through all of it:
 *
 * - **The text comes from the store, never from the model.** At the moment of
 *   a forget the model does not have the fact's text - it read it in a block
 *   several turns ago and that block has been rebuilt since. Asked to describe
 *   what it deleted it would describe what it believed it deleted, which is a
 *   plausible sentence with nothing checking it. So the controller reads the
 *   fact before closing it and passes the text along.
 * - **Long text is cut, never summarised.** Cutting is honest and reversible in
 *   the reader's head; a paraphrase generated here would be a second claim
 *   about the fact, sitting where the fact itself should be.
 */

import type { WriteReport } from "./write-report.ts";
import { modelReport } from "./write-report.ts";

/** How much of a memory call reaches the terminal. */
export type Output = "short" | "full" | "hidden";

/** One fact, as it was when something happened to it. */
export interface FactLine {
	id: number;
	text: string;
}

/**
 * What a tool did, as data rather than as prose.
 *
 * A tagged union so each rendering is a total function of its own case: adding
 * a tool means adding a case, and the compiler names the place.
 */
export type ToolReport =
	| { kind: "write"; write: WriteReport }
	| {
			kind: "revise";
			scopeLabel: string;
			oldId: number;
			newId: number;
			before: string;
			after: string;
	  }
	| {
			kind: "forget";
			scopeLabel: string;
			forgot: readonly FactLine[];
			absent: readonly number[];
	  }
	| { kind: "ask"; label: string; question: string; found: number }
	| { kind: "projects"; count: number }
	| { kind: "tags"; scopeLabel: string; count: number; more: boolean }
	| {
			kind: "link";
			undone: boolean;
			scopeLabel: string;
			src: string;
			rel: string;
			dst: string;
	  }
	| {
			kind: "note";
			action: "created" | "read" | "updated" | "deleted";
			noteId: string;
			title?: string;
			chars?: number;
	  }
	| { kind: "about"; topic: string; chars: number };

/** Where a fact's text is cut when it is shown to a person. */
export const SNIP_CHARS = 96;

/**
 * The report a tool result carries, if it carries one.
 *
 * Checked rather than assumed. The renderer used to decide "this was a write"
 * on the detail not being undefined, and a failed call rendered as
 * `Stored [fundefined] in undefined.` - a crash that reads as a success.
 */
export function isToolReport(value: unknown): value is ToolReport {
	if (typeof value !== "object" || value === null) return false;
	const { kind } = value as { kind?: unknown };
	return typeof kind === "string";
}

/**
 * One line for the terminal, or `undefined` to print what the model was told.
 *
 * `undefined` is not a failure: on `full` the model's own answer IS the full
 * account, and duplicating it here would only let the two drift apart.
 */
export function personLine(
	report: ToolReport,
	mode: Output,
): string | undefined {
	if (mode === "hidden") return "";
	if (mode === "full") {
		// A write is the one case with a fuller rendering of its own; every
		// other tool's fullest form is the answer the model received.
		return report.kind === "write" ? modelReport(report.write) : undefined;
	}
	return shortLine(report);
}

function shortLine(report: ToolReport): string {
	switch (report.kind) {
		case "write":
			return `Stored [f${report.write.id}] in ${report.write.scopeLabel}: ${quote(report.write.text)}`;
		case "revise":
			return [
				`Revised [f${report.oldId}] into [f${report.newId}] in ${report.scopeLabel}.`,
				`  was  ${quote(report.before)}`,
				`  now  ${quote(report.after)}`,
			].join("\n");
		case "forget":
			return forgetLines(report.scopeLabel, report.forgot, report.absent);
		case "ask":
			return report.found === 0
				? `Asked ${report.label}: ${quote(report.question)} - nothing on this.`
				: `Asked ${report.label}: ${quote(report.question)} - ${count(report.found, "fact")}.`;
		case "projects":
			return report.count === 0
				? "No projects have a memory yet."
				: `${count(report.count, "project")} with a memory.`;
		case "tags":
			return `${report.count}${report.more ? "+" : ""} tags in ${report.scopeLabel}.`;
		case "link":
			return `${report.undone ? "Unlinked" : "Linked"} ${report.src} -${report.rel}-> ${report.dst} in ${report.scopeLabel}.`;
		case "note":
			return noteLine(report);
		case "about":
			// Deliberately not the page. It is thousands of characters written
			// for the model, and the person watching wanted to know that their
			// agent went and read the manual, not to read it with it.
			return `Read the "${report.topic}" page of longterm_about (${size(report.chars)}).`;
	}
}

/**
 * Forgotten facts, grouped by what they said.
 *
 * Grouped because the job this tool exists for is clearing duplicates, and
 * four ids over one repeated sentence is the shape that job produces. Printing
 * the same line four times would hide the very thing worth seeing.
 */
function forgetLines(
	scopeLabel: string,
	forgot: readonly FactLine[],
	absent: readonly number[],
): string {
	const lines: string[] = [];
	if (forgot.length > 0) {
		lines.push(`Forgot ${count(forgot.length, "fact")} from ${scopeLabel}.`);
		for (const [text, ids] of groupByText(forgot)) {
			lines.push(`  ${ids.map((id) => `[f${id}]`).join(" ")}  ${quote(text)}`);
		}
	}
	if (absent.length > 0) {
		lines.push(
			`Not there: ${absent.map((id) => `[f${id}]`).join(", ")} in ${scopeLabel}.`,
		);
	}
	return lines.join("\n");
}

function groupByText(facts: readonly FactLine[]): Map<string, number[]> {
	const groups = new Map<string, number[]>();
	for (const fact of facts) {
		const ids = groups.get(fact.text);
		if (ids === undefined) groups.set(fact.text, [fact.id]);
		else ids.push(fact.id);
	}
	return groups;
}

function noteLine(report: Extract<ToolReport, { kind: "note" }>): string {
	const named =
		report.title === undefined
			? `note ${report.noteId}`
			: `note ${report.noteId} "${report.title}"`;
	const verb = report.action[0]?.toUpperCase() + report.action.slice(1);
	const measured = report.chars === undefined ? "" : ` (${size(report.chars)})`;
	return `${verb} ${named}${measured}.`;
}

/**
 * A fact's text, cut where it stops fitting one line.
 *
 * Used for the model too, on a forget: the cut is what makes telling it what
 * it deleted cost a line rather than a paragraph, and a fact whose first
 * ninety characters do not identify it is a fact nobody could have recognised
 * in the memory block either.
 */
export function snip(text: string, max = SNIP_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 3).trimEnd()}...`;
}

/** The same, quoted, for a person. */
export function quote(text: string): string {
	return `"${snip(text)}"`;
}

function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function size(chars: number): string {
	return chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(1)} kB`;
}
