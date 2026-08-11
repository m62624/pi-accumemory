/**
 * Bringing a session's memory up, and the philosophy of failing while doing it.
 *
 * It differs from pi-telegram-manager's on purpose. There, a memory that
 * quietly does not work means a bot answering strangers with confident amnesia
 * on its owner's behalf, so it fails loudly. Here, a memory that does not work
 * costs continuity - nothing else. The user is still writing code, and taking
 * the session down over a locked database would be the extension deciding its
 * own importance.
 *
 * So: degrade, say so once, never block. Every partial failure below leaves the
 * session usable with less memory rather than no session.
 */

import { CursorStore } from "./consolidation/cursor-store.ts";
import { piPassAgent } from "./consolidation/pi-agent.ts";
import { ConsolidationRunner } from "./consolidation/runner.ts";
import { readTranscriptTail } from "./consolidation/transcript.ts";
import type { FileOps } from "./fs-ops.ts";
import { BUNDLED_INSTRUCTIONS } from "./instructions/bundled.ts";
import { InstructionManager } from "./instructions/manager.ts";
import {
	COMMON_DB,
	type ExtensionLayout,
	projectAppendDir,
	projectDbName,
} from "./layout.ts";
import { NoteStore } from "./notes/store.ts";
import { toStoredPath } from "./paths/path-codec.ts";
import { detectProjectRoot } from "./project/detect.ts";
import { ProjectRouter } from "./router/router.ts";
import { MemoryController } from "./session/controller.ts";
import { clockLine } from "./session/tail.ts";
import type { Settings } from "./settings/defaults.ts";
import { CheckpointingStore } from "./storage/checkpointing-store.ts";
import { CommonStore, type LeasedWriter } from "./storage/common-store.ts";
import { buildPlugmemConfig, validateEmbedder } from "./storage/config-toml.ts";
import { isLocked } from "./storage/errors.ts";
import {
	openReadable,
	PlugmemReader,
	PlugmemStore,
} from "./storage/plugmem-store.ts";
import { longtermTools } from "./tools/definitions.ts";

/**
 * The `node:path` surface startup needs.
 *
 * Typed as the real module's shape rather than a hand-written subset: the
 * pieces below each take their own narrower slice of it, and describing it
 * loosely here only produces mismatches at every call site.
 */
export type PathModule = Pick<
	typeof import("node:path").posix,
	| "join"
	| "dirname"
	| "isAbsolute"
	| "normalize"
	| "relative"
	| "resolve"
	| "sep"
>;

export interface StartupOptions {
	settings: Settings;
	layout: ExtensionLayout;
	fs: FileOps;
	pathModule: PathModule;
	agentDir: string;
	cwd: string;
}

export interface StartedSession {
	controller: MemoryController;
	instructions: InstructionManager;
	cursors: CursorStore;
	projectId?: string;
	projectRoot?: string;
	/** Absent outside a project: there is no per-project transcript to curate. */
	consolidation?: ConsolidationRunner;
	/** `0` when consolidation is off, which is what disables the idle timer. */
	consolidationQuietMs: number;
	/** Rebuilds every vector in the workspace after an embedder change. */
	reembed(onProgress?: (name: string) => void): Promise<string>;
	/** Everything worth telling the user once, in plain sentences. */
	notices: string[];
	close(): void;
}

export async function startSession(
	options: StartupOptions,
): Promise<StartedSession> {
	const { settings, layout, fs, pathModule, cwd } = options;
	const notices: string[] = [];
	const closers: (() => void)[] = [];

	validateEmbedder(settings.memory.embedder);
	await fs.mkdir(layout.memoryDir);
	await fs.writeFile(
		layout.configToml,
		buildPlugmemConfig(settings.memory.embedder),
	);
	const openOptions = {
		dim: settings.memory.embedder.dim,
		config: layout.configToml,
	};
	const dbPath = (name: string) =>
		pathModule.join(layout.memoryDir, "db", `${name}.plugmem`);
	await fs.mkdir(pathModule.join(layout.memoryDir, "db"));

	// The common database first: it holds the router, so nothing else can be
	// resolved without it.
	const commonReader = await openReadable(dbPath(COMMON_DB), openOptions);
	closers.push(() => commonReader.close());
	const common = new CommonStore(commonReader, async () => {
		const writer = await PlugmemStore.open(dbPath(COMMON_DB), openOptions);
		return writer as unknown as LeasedWriter;
	});

	const router = new ProjectRouter(common);
	const projectRoot = await detectProjectRoot(cwd, { fs, flavour: pathModule });

	let projectId: string | undefined;
	let projectWriter: PlugmemStore | undefined;
	let project: CheckpointingStore | undefined;
	if (projectRoot !== undefined) {
		const resolved = await router.resolve(
			toStoredPath(projectRoot, pathModule),
		);
		projectId = resolved.projectId;
		try {
			projectWriter = await PlugmemStore.open(
				dbPath(projectDbName(projectId)),
				openOptions,
			);
			closers.push(() => projectWriter?.close());
			// Every write publishes. A project database that is written but
			// never checkpointed cannot be opened read-only from anywhere -
			// which is precisely what a cross-project question does.
			project = new CheckpointingStore(projectWriter);
			await projectWriter.checkpoint();
		} catch (error) {
			// Another session in the same project holds the writer. Saying so
			// once is honest; pretending the memory works is not.
			if (!isLocked(error)) throw error;
			notices.push(
				"Another session is already open in this project, so this one runs without " +
					"project memory. The shared memory about you still works.",
			);
		}
	} else {
		// No database for a home directory or a scratch folder: one per visited
		// directory turns the workspace into a junkyard of near-empty files.
		notices.push(
			"This directory is not a project, so only the shared memory about you is active.",
		);
	}

	if (!settings.memory.embedder.enabled) {
		notices.push(
			"The embedder is off, so memory answers only match wording that overlaps what " +
				"was stored. See SETTINGS.md to switch it on.",
		);
	}

	const instructions = new InstructionManager({
		fs,
		flavour: pathModule,
		defaultsDir: layout.instructionsDefaultsDir,
		globalAppendDir: layout.instructionsAppendDir,
		...(projectRoot === undefined
			? {}
			: { projectAppendDir: projectAppendDir(projectRoot, pathModule) }),
		bundled: BUNDLED_INSTRUCTIONS,
	});
	await instructions.sync();

	const notesCommon = new NoteStore(common, {
		fs,
		dir: layout.commonNotesDir,
		flavour: pathModule,
	});

	const controller = new MemoryController({
		settings,
		common,
		...(project === undefined ? {} : { project }),
		...(projectId === undefined ? {} : { projectId }),
		...(projectRoot === undefined
			? {}
			: { projectName: basename(projectRoot) }),
		notesCommon,
		...(project === undefined || projectId === undefined
			? {}
			: {
					notesProject: new NoteStore(project, {
						fs,
						dir: layout.projectNotesDir(projectId),
						flavour: pathModule,
					}),
				}),
		router,
		// Another project's memory, read-only. A shared lock coexists with the
		// writer a session in that project is holding, so the question is safe
		// to ask while somebody is working there.
		openProjectReader: async (id: string) => {
			const reader = await PlugmemReader.open(
				dbPath(projectDbName(id)),
				openOptions,
			);
			return { memory: reader, close: () => reader.close() };
		},
	});

	const cursors = new CursorStore(
		fs,
		layout.consolidationStateFile,
		pathModule,
	);
	const projectLabel =
		projectRoot === undefined
			? "this session"
			: `this project (${basename(projectRoot)})`;

	// No project, no pass: the transcript directory pi writes is keyed by
	// working directory, so outside a project there is nothing to resume from.
	const consolidation =
		projectId === undefined || !settings.memory.consolidation.enabled
			? undefined
			: new ConsolidationRunner({
					settings: settings.memory.consolidation,
					controller,
					cursors,
					instructions,
					agent: piPassAgent({
						cwd,
						agentDir: options.agentDir,
						tools: longtermTools(controller),
					}),
					projectId,
					projectLabel,
					clock: () => clockLine(new Date(), settings.timezone),
					readTail: (cursor) =>
						readTranscriptTail(fs, {
							flavour: pathModule,
							sessionsRoot: pathModule.join(options.agentDir, "sessions"),
							cwd,
							maxChars: settings.memory.consolidation.maxTranscriptChars,
							...(cursor === undefined ? {} : { cursor }),
						}),
				});

	return {
		controller,
		instructions,
		cursors,
		...(consolidation === undefined ? {} : { consolidation }),
		consolidationQuietMs:
			consolidation === undefined ? 0 : settings.memory.consolidation.quietMs,
		reembed: async (onProgress) => {
			// Recomputing vectors needs a provider to compute them with. Saying
			// so beats the engine's own error, which arrives after the command
			// has already announced that it started.
			if (!settings.memory.embedder.enabled) {
				return (
					"There is no embedder configured, so there are no vectors to rebuild. " +
					"See SETTINGS.md to switch one on, then run this again."
				);
			}
			// Every database in the workspace, because a partial reembed leaves
			// half the memory answering in one vector space and half in another.
			const names = [COMMON_DB, ...(await listDbNames(fs, pathModule, layout))];
			let done = 0;
			for (const name of names) {
				onProgress?.(name);
				const writer = await PlugmemStore.open(dbPath(name), openOptions);
				try {
					await writer.reembed();
					await writer.checkpoint();
					done += 1;
				} finally {
					writer.close();
				}
			}
			return `Re-embedded ${done} of ${names.length} memories.`;
		},
		...(projectId === undefined ? {} : { projectId }),
		...(projectRoot === undefined ? {} : { projectRoot }),
		notices,
		close: () => {
			for (const closer of closers.reverse()) {
				try {
					closer();
				} catch {
					// A handle that is already gone is the outcome we wanted.
				}
			}
		},
	};
}

/** Every project database on disk, by workspace name. */
async function listDbNames(
	fs: FileOps,
	pathModule: PathModule,
	layout: ExtensionLayout,
): Promise<string[]> {
	const files = await fs.listFiles(pathModule.join(layout.memoryDir, "db"));
	return files
		.filter((file) => file.endsWith(".plugmem"))
		.map((file) => file.slice(0, -".plugmem".length))
		.filter((name) => name !== COMMON_DB);
}

/** The folder name, whichever separator the host uses. */
function basename(dir: string): string {
	const parts = dir.split(/[/\\]/).filter((part) => part !== "");
	return parts.at(-1) ?? dir;
}
