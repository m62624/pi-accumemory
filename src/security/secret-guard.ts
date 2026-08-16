import { scanString } from "@visulima/secret-scanner";
import type { CustomSecretPattern } from "../settings/defaults.ts";

/** The small part of a scanner finding that the policy needs. */
export interface SecretFinding {
	ruleId: string;
	description: string;
	startLine: number;
	endLine: number;
	startColumn: number;
	endColumn: number;
	source?: string;
}

export interface SecretScanOptions {
	redact?: boolean;
	config?: { validate?: boolean };
}

export type SecretScanner = (
	content: string,
	file: string,
	options?: SecretScanOptions,
) => Promise<readonly SecretFinding[]>;

export interface SecretWritePart {
	label: string;
	text: string;
}

export interface SecretCheck {
	blocked: boolean;
	message?: string;
}

export interface SecretGuard {
	check(parts: readonly SecretWritePart[]): Promise<SecretCheck>;
}

const MAX_CUSTOM_PATTERN_CHARS = 500;

const SECRET_CONTEXT =
	/\b(?:api[ _-]?key|api[ _-]?token|access[ _-]?key|access[ _-]?token|auth(?:orization)?|bearer|basic[ _-]?auth|client[ _-]?secret|connection[ _-]?string|cookie|credential|database[ _-]?url|jwt|oauth|password|passwd|private[ _-]?key|refresh[ _-]?token|secret|session[ _-]?id|signing[ _-]?key|ssh[ _-]?key|token|webhook)\b/i;
const SECRET_VALUE_HINT =
	/(?:gh[pousr]_|github_pat_|sk[-_](?:live|test|ant)[-_]|AKIA|ASIA|AIza|xox[baprs]-|npm_|hf_|SG\.|sq0|eyJ|-----BEGIN|(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/|\b(?:password|passwd|secret|token|api[ _-]?key)\s*(?:is|[:=])\s*\S{4,}|\b[A-Za-z0-9_-]{32,}\b)/i;

/**
 * Scanner descriptions are broader than the memory policy. This keeps
 * provider credentials, passwords, keys and authenticated connection material
 * blocked, while not turning every opaque identifier or hash into a refusal.
 */
function blocksFinding(finding: SecretFinding, line: string): boolean {
	return (
		SECRET_CONTEXT.test(`${finding.ruleId} ${finding.description}`) ||
		SECRET_CONTEXT.test(line)
	);
}

function safeLine(
	content: string,
	lineNumber: number,
	findings: readonly SecretFinding[],
): string {
	const lines = content.split(/\r?\n/);
	const line = lines[lineNumber - 1] as string;
	const ranges = findings
		.filter(
			(finding) =>
				finding.startLine <= lineNumber && finding.endLine >= lineNumber,
		)
		.map((finding) => ({
			start:
				finding.startLine === lineNumber
					? Math.max(0, finding.startColumn - 1)
					: 0,
			end:
				finding.endLine === lineNumber
					? Math.max(0, finding.endColumn - 1)
					: line.length,
		}))
		.sort((left, right) => left.start - right.start)
		.reduce<Array<{ start: number; end: number }>>((merged, range) => {
			const previous = merged.at(-1);
			if (previous !== undefined && range.start <= previous.end) {
				previous.end = Math.max(previous.end, range.end);
			} else {
				merged.push({ ...range });
			}
			return merged;
		}, [])
		.sort((left, right) => right.start - left.start);
	let masked = line;
	for (const range of ranges) {
		masked = `${masked.slice(0, range.start)}[redacted]${masked.slice(range.end)}`;
	}
	const anchor = ranges.reduce((earliest, range) =>
		range.start < earliest.start ? range : earliest,
	);
	const contextStart = Math.max(0, anchor.start - 40);
	const contextEnd = Math.min(masked.length, anchor.end + 40);
	return (
		(contextStart > 0 ? "..." : "") +
		masked.slice(contextStart, contextEnd) +
		(contextEnd < masked.length ? "..." : "")
	);
}

const LOCAL_PATTERNS: ReadonlyArray<{
	pattern: RegExp;
	description: string;
}> = [
	{
		pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/g,
		description: "private key material",
	},
	{
		pattern:
			/(?:^|[^\w])(?:export\s+)?(?:[A-Z0-9]+[_-])*(?:API[_-]?KEY|API[_-]?TOKEN|ACCESS[_-]?(?:KEY|TOKEN)|AUTH(?:ORIZATION)?|BEARER|CLIENT[_-]?SECRET|COOKIE|DATABASE[_-]?URL|DB[_-]?(?:PASSWORD|URL)|PASSWORD|PASSWD|PRIVATE[_-]?KEY|SECRET|SESSION[_-]?ID|SIGNING[_-]?KEY|TOKEN|WEBHOOK)(?:[_-](?:VALUE|TEXT|STRING|MATERIAL))?\s*[:=]\s*(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[^\s#]{8,})/gim,
		description: "secret-bearing environment variable",
	},
	{
		pattern: /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+\S+/gi,
		description: "authorization credential",
	},
	{
		pattern:
			/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi,
		description: "authenticated database connection string",
	},
	{
		pattern:
			/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
		description: "JSON web token",
	},
];

function localFindings(content: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	for (const { pattern, description } of LOCAL_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of content.matchAll(pattern)) {
			const start = match.index;
			const matchText = match[0];
			const valueStart =
				description === "secret-bearing environment variable"
					? matchText.search(/[:=]\s*/) +
						(matchText.match(/[:=]\s*/u) as RegExpMatchArray)[0].length
					: description === "authorization credential"
						? matchText.search(/\s+(?:Bearer|Basic)\s+/i) +
							(
								matchText.match(/\s+(?:Bearer|Basic)\s+/i) as RegExpMatchArray
							)[0].length
						: 0;
			const before = content.slice(0, start);
			const lineStart = before.lastIndexOf("\n") + 1;
			const startLine = before.split("\n").length;
			findings.push({
				ruleId: `local-${description.replaceAll(" ", "-")}`,
				description,
				startLine,
				endLine: startLine,
				startColumn: start - lineStart + valueStart + 1,
				endColumn: start - lineStart + matchText.length + 1,
			});
		}
	}
	return findings;
}

function customFindings(
	content: string,
	patterns: readonly CustomSecretPattern[],
): SecretFinding[] {
	const findings: SecretFinding[] = [];
	for (const custom of patterns) {
		if (custom.pattern.length > MAX_CUSTOM_PATTERN_CHARS) continue;
		let regex: RegExp;
		try {
			regex = new RegExp(custom.pattern, "gu");
		} catch {
			continue;
		}
		for (const match of content.matchAll(regex)) {
			const matchText = match[0];
			if (matchText.length === 0) continue;
			const start = match.index ?? 0;
			const before = content.slice(0, start);
			const lineStart = before.lastIndexOf("\n") + 1;
			const startLine = before.split("\n").length;
			findings.push({
				ruleId: `custom-${custom.name}`,
				description: custom.description,
				startLine,
				endLine: startLine,
				startColumn: start - lineStart + 1,
				endColumn: start - lineStart + matchText.length + 1,
			});
		}
	}
	return findings;
}

function blockedMessage(
	content: string,
	findings: readonly SecretFinding[],
): string {
	const finding = findings[0] as SecretFinding;
	const line = safeLine(content, finding.startLine, findings);
	const description = finding.description;
	return (
		"Not stored: this memory entry contains sensitive credential material. " +
		`Detected ${description} on line ${finding.startLine}: ${line}. ` +
		"The credential value was redacted. Choose one: if the durable context " +
		"matters, retry with a sanitized generalization that keeps only its type or " +
		"location (for example, that a service uses an environment variable); if it " +
		"does not matter, do not retry. Never repeat the credential value or the " +
		"trigger line."
	);
}

export function createSecretGuard(
	scanner: SecretScanner = scanString,
	customPatterns: readonly CustomSecretPattern[] = [],
): SecretGuard {
	return {
		async check(parts): Promise<SecretCheck> {
			const included = parts.filter((part) => part.text.trim() !== "");
			if (included.length === 0) return { blocked: false };
			const content = included
				.map((part) => `=== ${part.label} ===\n${part.text}`)
				.join("\n");
			const local = localFindings(content);
			const localBlocking = local.filter((finding) => {
				const line = content.split(/\r?\n/)[finding.startLine - 1] as string;
				return blocksFinding(finding, line);
			});
			if (localBlocking.length > 0) {
				return {
					blocked: true,
					message: blockedMessage(content, localBlocking),
				};
			}
			const custom = customFindings(content, customPatterns);
			if (custom.length > 0) {
				return { blocked: true, message: blockedMessage(content, custom) };
			}
			const needsBroadScan = included.some((part) =>
				SECRET_VALUE_HINT.test(part.text),
			);
			if (!needsBroadScan) return { blocked: false };
			let findings: readonly SecretFinding[];
			try {
				findings = await scanner(content, "memory-write.env", {
					redact: true,
					// A memory write must never call a provider with the candidate text.
					config: { validate: false },
				});
			} catch {
				// A security check that failed is not permission to persist.
				return {
					blocked: true,
					message:
						"Not stored: the memory guard could not complete safely. " +
						"Retry after the local secret scanner is available.",
				};
			}

			const allFindings = [...findings, ...local];
			const blocking = allFindings.filter((finding) => {
				const line = content.split(/\r?\n/)[finding.startLine - 1] as string;
				return blocksFinding(finding, line);
			});
			if (blocking.length === 0) return { blocked: false };
			return { blocked: true, message: blockedMessage(content, blocking) };
		},
	};
}

export const defaultSecretGuard = createSecretGuard();
