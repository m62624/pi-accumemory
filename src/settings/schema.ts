/**
 * Validation of `settings.json`.
 *
 * Two different failures deserve two different reactions, and conflating them
 * is how configuration goes quietly wrong:
 *
 * - a **misspelled key** is reported as a warning and ignored. The user meant
 *   something; the extension keeps running and says what it did not understand.
 * - a **wrong type** throws, naming the full dotted path. Coercing `"25"` to
 *   `25` would work until the day it silently does not.
 */

import { DEFAULT_SETTINGS, type Settings } from "./defaults.ts";

export class SettingsError extends Error {}

type FieldSpec =
	| { kind: "boolean" }
	| { kind: "string"; nullable?: boolean }
	/** A non-negative integer: a count of messages, milliseconds or characters. */
	| { kind: "count"; nullable?: boolean }
	/** One of a fixed set of words; anything else names the allowed ones. */
	| { kind: "choice"; of: readonly string[] }
	/** A list of non-empty strings; the empty list is a legitimate value. */
	| { kind: "strings" }
	/** Additional secret-blocking regex objects, validated and filtered at load. */
	| { kind: "customPatterns" }
	| { kind: "section"; fields: Record<string, FieldSpec> };

const COUNT: FieldSpec = { kind: "count" };
const BOOL: FieldSpec = { kind: "boolean" };

const SCHEMA: Record<string, FieldSpec> = {
	timezone: { kind: "string", nullable: true },
	memory: {
		kind: "section",
		fields: {
			enabled: BOOL,
			output: { kind: "choice", of: ["short", "full", "hidden"] },
			recallTokenBudget: COUNT,
			recallK: COUNT,
			graphDepth: { kind: "count", nullable: true },
			manifest: BOOL,
			queryMaxChars: COUNT,
			plugmemConfig: { kind: "string", nullable: true },
			autoReembed: BOOL,
			refresh: {
				kind: "section",
				fields: {
					afterToolCalls: COUNT,
					onCompact: BOOL,
					askHintAfterIdleInferences: COUNT,
				},
			},
			project: {
				kind: "section",
				fields: { markers: { kind: "strings" }, maxParents: COUNT },
			},
			instructions: {
				kind: "section",
				fields: { alwaysMax: COUNT, alwaysMaxChars: COUNT },
			},
			notes: {
				kind: "section",
				fields: { overviewMaxChars: COUNT },
			},
			nudge: {
				kind: "section",
				fields: {
					enabled: BOOL,
					afterMessages: COUNT,
					afterToolCalls: COUNT,
					cooldownTurns: COUNT,
				},
			},
			inspect: {
				kind: "section",
				fields: { pageSize: COUNT },
			},
			security: {
				kind: "section",
				fields: { customPatterns: { kind: "customPatterns" } },
			},
			consolidation: {
				kind: "section",
				fields: {
					enabled: BOOL,
					quietMs: COUNT,
					maxSteps: COUNT,
					maxNudges: COUNT,
					maxTranscriptChars: COUNT,
					promoteToCommon: BOOL,
					review: {
						kind: "section",
						fields: {
							enabled: BOOL,
							intervalMs: COUNT,
							sampleSize: COUNT,
						},
					},
					habits: {
						kind: "section",
						fields: { enabled: BOOL, afterSessions: COUNT },
					},
					maintain: BOOL,
				},
			},
			crossProject: {
				kind: "section",
				fields: { enabled: BOOL },
			},
		},
	},
};

export interface ParsedSettings {
	settings: Settings;
	/** One human-readable line per key nothing claimed. */
	warnings: string[];
}

/**
 * Overlays `raw` onto {@link DEFAULT_SETTINGS}.
 *
 * @throws {SettingsError} on a value of the wrong type or shape.
 */
export function parseSettings(raw: unknown): ParsedSettings {
	if (raw === undefined || raw === null) {
		return { settings: clone(DEFAULT_SETTINGS), warnings: [] };
	}
	if (!isPlainObject(raw)) {
		throw new SettingsError("settings: the document must be a JSON object");
	}
	const warnings: string[] = [];
	const settings = clone(DEFAULT_SETTINGS) as unknown as Record<
		string,
		unknown
	>;
	overlay(settings, raw, SCHEMA, "", warnings);
	return { settings: settings as unknown as Settings, warnings };
}

function overlay(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
	schema: Record<string, FieldSpec>,
	prefix: string,
	warnings: string[],
): void {
	for (const [key, value] of Object.entries(source)) {
		const dotted = prefix === "" ? key : `${prefix}.${key}`;
		const spec = schema[key];
		if (spec === undefined) {
			warnings.push(`settings: unknown key "${dotted}" was ignored`);
			continue;
		}
		if (spec.kind === "section") {
			if (!isPlainObject(value)) {
				throw new SettingsError(`settings: "${dotted}" must be an object`);
			}
			overlay(
				target[key] as Record<string, unknown>,
				value,
				spec.fields,
				dotted,
				warnings,
			);
			continue;
		}
		target[key] = checkScalar(dotted, value, spec, warnings);
	}
}

function checkScalar(
	dotted: string,
	value: unknown,
	spec: FieldSpec,
	warnings: string[] = [],
): unknown {
	if (spec.kind === "section") {
		throw new SettingsError(`settings: "${dotted}" must be an object`);
	}
	if (value === null) {
		if (
			(spec.kind === "string" || spec.kind === "count") &&
			spec.nullable === true
		)
			return null;
		throw new SettingsError(`settings: "${dotted}" must not be null`);
	}
	switch (spec.kind) {
		case "boolean":
			if (typeof value !== "boolean") {
				throw new SettingsError(`settings: "${dotted}" must be a boolean`);
			}
			return value;
		case "string":
			if (typeof value !== "string") {
				throw new SettingsError(`settings: "${dotted}" must be a string`);
			}
			return value;
		case "count":
			if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
				throw new SettingsError(
					`settings: "${dotted}" must be a number: a non-negative whole count`,
				);
			}
			return value;
		case "strings": {
			// Named one by one rather than "must be an array of strings": the
			// mistake here is nearly always one bad entry among good ones, and
			// finding it by eye in a list of twelve is the slow part.
			if (!Array.isArray(value)) {
				throw new SettingsError(`settings: "${dotted}" must be an array`);
			}
			const bad = value.findIndex(
				(entry) => typeof entry !== "string" || entry.trim() === "",
			);
			if (bad !== -1) {
				throw new SettingsError(
					`settings: "${dotted}[${bad}]" must be a non-empty string`,
				);
			}
			return [...(value as string[])];
		}
		case "customPatterns":
			return checkCustomPatterns(dotted, value, warnings);
		case "choice":
			// Named rather than "invalid value": a typo in one of three words is
			// fixed in a second when the three are printed, and guessed at for
			// minutes when they are not.
			if (typeof value !== "string" || !spec.of.includes(value)) {
				throw new SettingsError(
					`settings: "${dotted}" must be one of ${spec.of.map((word) => `"${word}"`).join(", ")}`,
				);
			}
			return value;
	}
}

const MAX_CUSTOM_PATTERNS = 64;
const MAX_CUSTOM_PATTERN_CHARS = 500;

function checkCustomPatterns(
	dotted: string,
	value: unknown,
	warnings: string[],
): Array<{ name: string; pattern: string; description: string }> {
	if (!Array.isArray(value))
		throw new SettingsError(`settings: "${dotted}" must be an array`);
	if (value.length > MAX_CUSTOM_PATTERNS) {
		warnings.push(
			`settings: "${dotted}" has more than ${MAX_CUSTOM_PATTERNS} entries; extras were ignored`,
		);
	}
	const valid: Array<{ name: string; pattern: string; description: string }> =
		[];
	for (const [index, entry] of value.slice(0, MAX_CUSTOM_PATTERNS).entries()) {
		if (!isPlainObject(entry)) {
			throw new SettingsError(
				`settings: "${dotted}[${index}]" must be an object`,
			);
		}
		const name = entry.name;
		const pattern = entry.pattern;
		const description = entry.description;
		if (typeof name !== "string" || name.trim() === "") {
			throw new SettingsError(
				`settings: "${dotted}[${index}].name" must be a non-empty string`,
			);
		}
		if (typeof pattern !== "string" || pattern.trim() === "") {
			throw new SettingsError(
				`settings: "${dotted}[${index}].pattern" must be a non-empty string`,
			);
		}
		if (typeof description !== "string" || description.trim() === "") {
			throw new SettingsError(
				`settings: "${dotted}[${index}].description" must be a non-empty string`,
			);
		}
		const extra = Object.keys(entry).filter(
			(key) => !["name", "pattern", "description"].includes(key),
		);
		if (extra.length > 0) {
			warnings.push(
				`settings: "${dotted}[${index}]" ignores unsupported key(s) ${extra.join(", ")}; custom patterns always block`,
			);
		}
		if (pattern.length > MAX_CUSTOM_PATTERN_CHARS) {
			warnings.push(
				`settings: "${dotted}[${index}].pattern" is longer than ${MAX_CUSTOM_PATTERN_CHARS} characters and was ignored`,
			);
			continue;
		}
		try {
			new RegExp(pattern, "gu");
		} catch {
			warnings.push(
				`settings: "${dotted}[${index}].pattern" is an invalid regular expression and was ignored`,
			);
			continue;
		}
		valid.push({ name: name.trim(), pattern, description: description.trim() });
	}
	return valid;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
