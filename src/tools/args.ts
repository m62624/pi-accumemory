/**
 * Reading arguments a model sent.
 *
 * A parameter schema is a request, not a guarantee. A model sends a missing
 * field, a number where a string was declared, a single string where an array
 * was, or an enum value it invented - routinely, and not only the small ones.
 * Every one of those has to land somewhere sane, and the tools should not each
 * spell out how.
 *
 * The one rule that is not merely tidiness: an unrecognised scope becomes
 * `project`, never `user`. A wrong fact in the project memory never surfaces
 * elsewhere; a wrong fact in the shared memory is read at the start of every
 * session of every project, forever.
 */

import type { Scope } from "../session/controller.ts";

/** A required string; anything unusable becomes `fallback`. */
export function str(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return fallback;
	return String(value);
}

/** An optional string: present only when it really is one. */
export function optStr(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** An optional number: present only when it really is one, and finite. */
export function optNum(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** A required number; anything unusable becomes `fallback`. */
export function num(value: unknown, fallback = 0): number {
	return optNum(value) ?? fallback;
}

/**
 * A list of fact ids, however the model chose to express it.
 *
 * Both spellings are accepted because both will arrive: a schema is a request,
 * not a guarantee, and a tool that takes `ids` still gets `id` from a model
 * that has seen one before. Non-numeric members are dropped rather than
 * coerced - `Number("f3")` is `NaN`, and a `NaN` id addresses nothing.
 */
export function numArray(list: unknown, single: unknown): number[] {
	const out: number[] = [];
	if (Array.isArray(list)) {
		for (const item of list) {
			const value = optNum(item);
			if (value !== undefined) out.push(value);
		}
	}
	const one = optNum(single);
	if (one !== undefined && !out.includes(one)) out.push(one);
	return out;
}

/** An optional array of strings, with non-string members stringified. */
export function strArray(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.map((item) => str(item)) : undefined;
}

/** The scope, defaulting to the safe one. See the note at the top. */
export function scopeOf(value: unknown): Scope {
	return optScope(value) ?? "project";
}

/** The scope only when it was given as one of the three. */
export function optScope(value: unknown): Scope | undefined {
	return value === "project" || value === "user" || value === "both"
		? value
		: undefined;
}

/**
 * Drops the keys whose value is `undefined`.
 *
 * Used where a downstream option object distinguishes "absent" from
 * "explicitly undefined" - the plugmem bindings do, and so does
 * `exactOptionalPropertyTypes`. Writing the spread-ternary by hand at every
 * call site is where the branch count and the typos both come from.
 */
export function defined<T extends Record<string, unknown>>(
	source: T,
): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined) out[key] = value;
	}
	return out as Partial<T>;
}
