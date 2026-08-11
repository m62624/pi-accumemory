/**
 * The CI files themselves.
 *
 * A workflow is only checked by pushing it, and a broken one fails at the worst
 * possible moment — usually mid-release. These are the cheap invariants that
 * catch the mistakes actually made when editing them: invalid YAML, a step
 * calling an npm script that no longer exists, and the release flow losing the
 * bits that make it safe.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOWS = new URL("../.github/workflows/", import.meta.url).pathname;

async function workflowFiles(): Promise<string[]> {
	return (await readdir(WORKFLOWS))
		.filter((name) => name.endsWith(".yml"))
		.sort();
}

async function load(name: string): Promise<Record<string, unknown>> {
	const text = await readFile(path.join(WORKFLOWS, name), "utf8");
	return parse(text) as Record<string, unknown>;
}

describe("GitHub workflows", () => {
	it("are all valid YAML with a name and jobs", async () => {
		for (const file of await workflowFiles()) {
			const doc = await load(file);
			expect(doc.name, `${file} has no name`).toBeTypeOf("string");
			expect(doc.jobs, `${file} has no jobs`).toBeTypeOf("object");
		}
	});

	it("only call npm scripts that exist", async () => {
		// The failure this prevents: renaming a script and finding out from a
		// red release run.
		const scripts = Object.keys(
			(
				JSON.parse(
					await readFile(new URL("../package.json", import.meta.url), "utf8"),
				) as { scripts: Record<string, string> }
			).scripts,
		);
		for (const file of await workflowFiles()) {
			const text = await readFile(path.join(WORKFLOWS, file), "utf8");
			for (const [, script] of text.matchAll(/npm run ([a-z:-]+)/g)) {
				expect(scripts, `${file} runs missing script "${script}"`).toContain(
					script,
				);
			}
		}
	});
});

describe("the CI workflow", () => {
	it("runs lint, typecheck, tests and the packaging check", async () => {
		const text = await readFile(path.join(WORKFLOWS, "ci.yml"), "utf8");
		expect(text).toContain("npm run check");
		expect(text).toContain("npm run build");
		expect(text).toContain("npm pack --dry-run");
	});

	it("runs the tests through coverage, so the threshold is a gate", async () => {
		// A coverage threshold only the author ever looks at is not a threshold.
		const text = await readFile(path.join(WORKFLOWS, "ci.yml"), "utf8");
		expect(text).toContain("npm run coverage");
	});

	it("exposes exactly one aggregating gate for branch protection", async () => {
		const doc = await load("ci.yml");
		const jobs = doc.jobs as Record<string, { needs?: string[]; if?: string }>;
		expect(Object.keys(jobs)).toContain("ci-pass");
		expect(jobs["ci-pass"]?.needs).toContain("build");
		// `always()` is what lets the gate turn a failed dependency into a red
		// required check instead of never reporting at all.
		expect(jobs["ci-pass"]?.if).toBe("always()");
	});

	it("is callable from the release workflow", async () => {
		const doc = await load("ci.yml");
		expect((doc.on as Record<string, unknown>).workflow_call).toBeDefined();
	});
});

describe("the release workflow", () => {
	it("publishes only after the tests it calls have passed", async () => {
		const doc = await load("release.yml");
		const jobs = doc.jobs as Record<string, { needs?: string[] }>;
		expect(jobs.publish?.needs).toContain("tests");
		expect(jobs.release?.needs).toContain("publish");
	});

	it("asks for provenance and the identity token that signs it", async () => {
		// Provenance is what lets someone verify the tarball was built from this
		// repository. It is signed with the workflow's OIDC identity, so it
		// works with a token today and keeps working after the switch to
		// trusted publishing.
		const text = await readFile(path.join(WORKFLOWS, "release.yml"), "utf8");
		expect(text).toContain("--provenance");
		expect(text).toContain("id-token: write");
	});

	it("fails loudly when the publish token is missing", async () => {
		// Without this the npm CLI fails somewhere deeper with a less obvious
		// message, halfway through a release.
		const text = await readFile(path.join(WORKFLOWS, "release.yml"), "utf8");
		expect(text).toContain("NPM_TOKEN");
		expect(text).toMatch(/Secret NPM_TOKEN is not set/);
	});

	it("does not republish a version that is already on npm", async () => {
		const text = await readFile(path.join(WORKFLOWS, "release.yml"), "utf8");
		expect(text).toMatch(/already published on npm/);
	});

	it("names this package, not the one it was copied from", async () => {
		const text = await readFile(path.join(WORKFLOWS, "release.yml"), "utf8");
		expect(text).toContain("pi-accumemory");
		expect(text).not.toContain("pi-telegram-manager");
	});
});

describe("every workflow", () => {
	it("mentions no other project's name", async () => {
		// These files were adapted from a sibling repository; a leftover name
		// silently mirrors or publishes the wrong thing.
		for (const file of await workflowFiles()) {
			const text = await readFile(path.join(WORKFLOWS, file), "utf8");
			expect(text, `${file} still mentions pi-telegram-manager`).not.toContain(
				"pi-telegram-manager",
			);
		}
	});
});
