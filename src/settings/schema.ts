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
	| { kind: "section"; fields: Record<string, FieldSpec> };

const COUNT: FieldSpec = { kind: "count" };
const BOOL: FieldSpec = { kind: "boolean" };

const SCHEMA: Record<string, FieldSpec> = {
	timezone: { kind: "string", nullable: true },
	memory: {
		kind: "section",
		fields: {
			enabled: BOOL,
			writeOutput: { kind: "choice", of: ["short", "full", "hidden"] },
			recallTokenBudget: COUNT,
			recallK: COUNT,
			graphDepth: { kind: "count", nullable: true },
			manifest: BOOL,
			queryMaxChars: COUNT,
			refresh: {
				kind: "section",
				fields: {
					afterToolCalls: COUNT,
					onCompact: BOOL,
					askHintAfterIdleInferences: COUNT,
				},
			},
			embedder: {
				kind: "section",
				fields: {
					enabled: BOOL,
					url: { kind: "string" },
					model: { kind: "string" },
					apiKeyEnv: { kind: "string", nullable: true },
					spaceId: { kind: "string", nullable: true },
					autoReembed: BOOL,
					dim: COUNT,
				},
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
			consolidation: {
				kind: "section",
				fields: {
					enabled: BOOL,
					quietMs: COUNT,
					maxSteps: COUNT,
					maxNudges: COUNT,
					maxTranscriptChars: COUNT,
					promoteToCommon: BOOL,
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
		target[key] = checkScalar(dotted, value, spec);
	}
}

function checkScalar(dotted: string, value: unknown, spec: FieldSpec): unknown {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
