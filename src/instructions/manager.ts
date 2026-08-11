/**
 * The instruction files: what the extension tells the model about using its
 * own memory, and how a person extends that without forking anything.
 *
 * Three layers, the first two lifted from pi-planner because they are already
 * right:
 *
 * 1. `defaults/<key>.md` - ours. Rewritten whenever it differs from the
 *    bundled text, so an upgrade actually applies. Editing one is not a
 *    supported way to change behaviour; it is a change that disappears.
 * 2. `append/<key>.md` - the user's. Never written, never overwritten, never
 *    read for anything but appending.
 * 3. Facts tagged `instruction` - what the model writes to itself. Those are
 *    not files and are not handled here; they arrive through recall like any
 *    other fact.
 *
 * The pi-planner rule comes across with its trap intact: a project append
 * REPLACES the global one for the same key rather than merging with it. Worth
 * stating loudly in the docs, because the failure mode is silent - somebody
 * adds a project file and their global text simply stops applying.
 */

import { createHash } from "node:crypto";
import type { FileOps } from "../fs-ops.ts";

export const INSTRUCTION_KEYS = [
	"reading",
	"memory",
	"placement",
	"consolidation",
	"review",
	"notes",
	"tags",
	"secrets",
] as const;

export type InstructionKey = (typeof INSTRUCTION_KEYS)[number];

/**
 * The one key that is not optional and not reorderable.
 *
 * It is composed last, below everything a user added, because a model acts on
 * the last instruction it read. Additions to it are supported - the list of
 * what must never be stored is exactly the kind of thing a team needs to
 * extend - but they are composed above the rule, so an append can only make it
 * stricter, never weaker.
 */
const SECRETS: InstructionKey = "secrets";

export interface PathFlavour {
	join(...parts: string[]): string;
}

export interface InstructionOptions {
	fs: FileOps;
	flavour: PathFlavour;
	defaultsDir: string;
	globalAppendDir: string;
	/** Inside the project; wins outright over the global one, per key. */
	projectAppendDir?: string;
	bundled: Record<string, string>;
}

export interface SyncReport {
	created: string[];
	updated: string[];
	unchanged: string[];
}

export class InstructionManager {
	constructor(private readonly options: InstructionOptions) {}

	/** Brings `defaults/` in line with the bundled text. */
	async sync(): Promise<SyncReport> {
		const { fs, bundled } = this.options;
		const report: SyncReport = { created: [], updated: [], unchanged: [] };
		await fs.mkdir(this.options.defaultsDir);

		for (const key of INSTRUCTION_KEYS) {
			const wanted = bundled[key];
			if (wanted === undefined) continue;
			const file = this.options.flavour.join(
				this.options.defaultsDir,
				`${key}.md`,
			);
			const current = await fs.readFile(file);
			if (current === undefined) {
				await fs.writeFile(file, wanted);
				report.created.push(key);
			} else if (sha256(current) !== sha256(wanted)) {
				await fs.writeFile(file, wanted);
				report.updated.push(key);
			} else {
				report.unchanged.push(key);
			}
		}
		return report;
	}

	/** The effective text for one key: the default, then the selected append. */
	async read(key: InstructionKey): Promise<string> {
		const base =
			(await this.readDefault(key)) ?? this.options.bundled[key] ?? "";
		const extra = await this.readSelectedAppend(key);
		return extra === undefined ? base : `${base}\n\n${extra}`;
	}

	/**
	 * Several keys joined, with the secrets rule forced into last place.
	 *
	 * Callers do not get to leave it out, and do not get to put it anywhere
	 * else. See {@link SECRETS}.
	 */
	async compose(keys: readonly InstructionKey[]): Promise<string> {
		const ordered = keys.filter((key) => key !== SECRETS);
		const sections: string[] = [];
		for (const key of ordered) {
			const text = (await this.read(key)).trim();
			if (text !== "") sections.push(text);
		}
		const secrets = (await this.read(SECRETS)).trim();
		if (secrets !== "") sections.push(secrets);
		return sections.join("\n\n");
	}

	private async readDefault(key: InstructionKey): Promise<string | undefined> {
		return this.options.fs.readFile(
			this.options.flavour.join(this.options.defaultsDir, `${key}.md`),
		);
	}

	/**
	 * The project append if it exists, otherwise the global one.
	 *
	 * Exclusive, not merged. Merging looks friendlier and is worse: two files
	 * both half-applying is harder to reason about than one file winning, and
	 * a project that wants the global text can paste it in.
	 */
	private async readSelectedAppend(
		key: InstructionKey,
	): Promise<string | undefined> {
		const { fs, flavour, projectAppendDir, globalAppendDir } = this.options;
		if (projectAppendDir !== undefined) {
			const projectText = await fs.readFile(
				flavour.join(projectAppendDir, `${key}.md`),
			);
			if (nonEmpty(projectText)) return projectText.trim();
		}
		const globalText = await fs.readFile(
			flavour.join(globalAppendDir, `${key}.md`),
		);
		return nonEmpty(globalText) ? globalText.trim() : undefined;
	}
}

function nonEmpty(text: string | undefined): text is string {
	return text !== undefined && text.trim() !== "";
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
