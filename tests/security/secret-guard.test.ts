import { describe, expect, it, vi } from "vitest";
import {
	createSecretGuard,
	defaultSecretGuard,
	type SecretFinding,
} from "../../src/security/secret-guard.ts";

function finding(overrides: Partial<SecretFinding> = {}): SecretFinding {
	return {
		ruleId: "synthetic-rule",
		description: "synthetic credential",
		startLine: 2,
		endLine: 2,
		startColumn: 20,
		endColumn: 34,
		...overrides,
	};
}

describe("secret guard", () => {
	it("does not start the native scanner for an empty candidate", async () => {
		const scanner = vi.fn(async (): Promise<readonly SecretFinding[]> => []);
		const result = await createSecretGuard(scanner).check([]);

		expect(result).toEqual({ blocked: false });
		expect(scanner).not.toHaveBeenCalled();
	});

	it("uses the bundled scanner for a provider token", async () => {
		const result = await defaultSecretGuard.check([
			{
				label: "fact",
				text: "ghp_123456789012345678901234567890123456",
			},
		]);

		expect(result.blocked).toBe(true);
		expect(result.message).toMatch(/not stored/i);
		expect(result.message).toContain("[redacted]");
		expect(result.message).not.toContain(
			"123456789012345678901234567890123456",
		);
	});

	it("covers local environment, connection, JWT and key formats", async () => {
		for (const text of [
			"API_TOKEN=synthetic-value-12345678",
			"Authorization: Bearer synthetic-authorization-value",
			"DATABASE_URL=postgres://user:synthetic-pass@db.invalid/app",
			"eyJsyntheticHeader.eyJsyntheticPayload.syntheticSignature",
			"-----BEGIN PRIVATE KEY-----",
		]) {
			await expect(
				defaultSecretGuard.check([{ label: "fact", text }]),
			).resolves.toMatchObject({ blocked: true });
		}
	});

	it("does not block an ordinary identifier finding", async () => {
		const scanner = async (): Promise<readonly SecretFinding[]> => [
			finding({ description: "opaque identifier" }),
		];
		const guard = createSecretGuard(scanner);

		await expect(
			guard.check([{ label: "fact", text: "build id 7f4d2a" }]),
		).resolves.toEqual({ blocked: false });
	});

	it("keeps an opaque long identifier allowed when context is absent", async () => {
		const scanner = async (): Promise<readonly SecretFinding[]> => [
			finding({ description: "opaque identifier" }),
		];
		const result = await createSecretGuard(scanner).check([
			{ label: "fact", text: "opaqueidentifier012345678901234567890" },
		]);

		expect(result).toEqual({ blocked: false });
	});

	it("keeps only a short masked window for a long matching line", async () => {
		const line = `${"safe context ".repeat(8)}github_pat_synthetic${" middle ".repeat(4)}tokenB${" trailing ".repeat(8)}`;
		const first = line.indexOf("github_pat_synthetic");
		const second = line.indexOf("tokenB");
		const scanner = async (): Promise<readonly SecretFinding[]> => [
			finding({
				description: "provider API token",
				startColumn: first + 1,
				endColumn: first + "github_pat_synthetic".length + 1,
			}),
			finding({
				description: "provider API token",
				startColumn: first + 1,
				endColumn: first + "github_pat_synthetic".length + 1,
			}),
			finding({
				description: "provider API token",
				startColumn: second + 1,
				endColumn: second + "tokenB".length + 1,
			}),
		];
		const result = await createSecretGuard(scanner).check([
			{ label: "fact", text: line },
		]);

		expect(result.blocked).toBe(true);
		expect(result.message).toContain("[redacted]");
		expect(result.message?.length).toBeLessThan(700);
		expect(result.message).not.toContain("safe context ".repeat(8));
	});

	it("masks findings that span multiple lines", async () => {
		const scanner = async (): Promise<readonly SecretFinding[]> => [
			finding({ startLine: 2, endLine: 3 }),
			finding({ startLine: 1, endLine: 2 }),
		];
		const result = await createSecretGuard(scanner).check([
			{ label: "fact", text: "first line\nAPI token is synthetic\nlast line" },
		]);

		expect(result.blocked).toBe(true);
		expect(result.message).toContain("[redacted]");
	});

	it("blocks a finding whose surrounding line names a credential", async () => {
		const scanner = async (
			content: string,
		): Promise<readonly SecretFinding[]> => {
			const line = content.split("\n")[1] ?? "";
			return [
				finding({
					startColumn: line.indexOf("synthetic") + 1,
					endColumn: line.indexOf("synthetic") + "synthetic".length + 1,
				}),
			];
		};
		const guard = createSecretGuard(scanner);
		const result = await guard.check([
			{ label: "fact", text: "the API token is synthetic" },
		]);

		expect(result.blocked).toBe(true);
		expect(result.message).toContain("the API token is [redacted]");
	});

	it("fails closed when the scanner is unavailable", async () => {
		const guard = createSecretGuard(async () => {
			throw new Error("synthetic scanner failure");
		});
		const result = await guard.check([
			{ label: "fact", text: "the API token is ordinary fact" },
		]);

		expect(result).toEqual({
			blocked: true,
			message: expect.stringMatching(/could not complete safely/i),
		});
	});
});
