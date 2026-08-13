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
import { ReviewCursorStore } from "./consolidation/review-cursor.ts";
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
import { StumbleLog } from "./session/stumbles.ts";
import { clockLine } from "./session/tail.ts";
import type { Settings } from "./settings/defaults.ts";
import { CheckpointingStore } from "./storage/checkpointing-store.ts";
import {
	CommonMemoryBusyError,
	CommonStore,
	type LeasedWriter,
} from "./storage/common-store.ts";
import { ensurePlugmemConfig } from "./storage/config-file.ts";
import { embedderWasConfigured } from "./storage/config-toml.ts";
import { syncVectorSpace } from "./storage/embedder-sync.ts";
import { isLocked } from "./storage/errors.ts";
import {
	openReadable,
	PlugmemReader,
	PlugmemStore,
} from "./storage/plugmem-store.ts";
import type { EmbedderState } from "./storage/port.ts";
import { defined } from "./tools/args.ts";
import { longtermTools } from "./tools/definitions.ts";
import type { ProgressStep } from "./ui/reembed-progress.ts";

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
	/**
	 * The user's home directory, which is never itself a project.
	 *
	 * Injected rather than read from the environment so the rule is testable on
	 * both path flavours. See `project/detect.ts` for why it is needed at all.
	 */
	home?: string;
}

export interface StartedSession {
	controller: MemoryController;
	/** The parsed settings, for the entry point's rendering decisions. */
	settings: Settings;
	instructions: InstructionManager;
	/**
	 * The standing instructions, composed once for the head of every context.
	 *
	 * Held as a string rather than recomposed per call so the head of the prompt
	 * is byte-identical all session - see `session/head.ts`.
	 */
	headInstructions: string;
	cursors: CursorStore;
	/** Mistakes counted across sessions; read by `/longterm-status`. */
	stumbles: StumbleLog;
	projectId?: string;
	projectRoot?: string;
	/** Absent outside a project: there is no per-project transcript to curate. */
	consolidation?: ConsolidationRunner;
	/** `0` when consolidation is off, which is what disables the idle timer. */
	consolidationQuietMs: number;
	/**
	 * Rebuilds every vector in the workspace after an embedder change.
	 *
	 * `onProgress` is called with the same array each time a database starts
	 * and finishes, so a caller can render it; the result carries the final
	 * states, or `blocked` when the rebuild could not even begin.
	 */
	reembed(onProgress?: (steps: readonly ProgressStep[]) => void): Promise<{
		steps: ProgressStep[];
		blocked?: string;
	}>;
	/** Everything worth telling the user once, in plain sentences. */
	notices: string[];
	/** plugmem's config file, as it was actually resolved. */
	configFile: string;
	/**
	 * The embedder as it stands right now.
	 *
	 * A function rather than a value: it starts `active` and becomes
	 * `suspended` the moment a provider stops answering, so anything that
	 * reports it to a person has to ask at the time of asking.
	 */
	embedderState(): EmbedderState;
	close(): void;
}

export async function startSession(
	options: StartupOptions,
): Promise<StartedSession> {
	const { settings, layout, fs, pathModule, cwd } = options;
	const notices: string[] = [];
	const closers: (() => void)[] = [];

	await fs.mkdir(layout.memoryDir);
	// plugmem's own file, and the user's. We put one there when there is none -
	// carrying over the old `memory.embedder` settings if this installation
	// still has them - and never touch it again.
	const legacy = settings.memory.embedder;
	const configFile = await ensurePlugmemConfig({
		fs,
		flavour: pathModule,
		root: layout.root,
		defaultPath: layout.configToml,
		configured: settings.memory.plugmemConfig,
		...defined({ home: options.home }),
		...(embedderWasConfigured(legacy) ? { legacy } : {}),
	});
	if (configFile.notice !== "") notices.push(configFile.notice);
	const openOptions = { config: configFile.path };
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

	// Bring the stored vectors in step with the configured embedder BEFORE
	// anything asks the memory a question. A changed model makes every text
	// lookup and every text write fail, and without this the first the user
	// hears of it is a failed tool call in the middle of their work.
	//
	// Whether there is an embedder at all is the engine's answer, not ours: it
	// read the config file, and it is the one that would have refused a broken
	// `[embedder]` section. A read-only handle has its own, so this is also the
	// handle that will answer this session's questions.
	const embedderPresent = commonReader.embedderState() !== "absent";
	const syncOptions = { autoReembed: settings.memory.autoReembed };
	if (embedderPresent) {
		await common.withWriteLease(async (writer) => {
			const result = await syncVectorSpace(writer as unknown as PlugmemStore, {
				...syncOptions,
				label: "the shared memory about you",
			});
			if (result.notice !== "") notices.push(result.notice);
		});
	}

	const router = new ProjectRouter(common);
	const projectRoot = await detectProjectRoot(cwd, {
		fs,
		flavour: pathModule,
		...defined({ home: options.home }),
	});

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
			if (embedderPresent) {
				const result = await syncVectorSpace(projectWriter, {
					...syncOptions,
					label: "this project's memory",
				});
				if (result.notice !== "") notices.push(result.notice);
			}
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

	if (!embedderPresent) {
		notices.push(
			"The embedder is off, so memory answers only match wording that overlaps what " +
				`was stored. Switch it on in ${configFile.path}.`,
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

	// Composed ONCE, here, and reused for every call of the session. Reading the
	// files per call would spend I/O to produce the same bytes, and any drift
	// between two reads would move the head of the prompt - which is the one
	// place a change costs the entire cached prefix.
	//
	// `consolidation` is left out on purpose: it describes the background pass,
	// which has its own context and its own copy. Telling a live session how the
	// idle pass works is prompt spent on something it will never do.
	const headInstructions = await instructions.compose([
		"reading",
		"memory",
		"placement",
		"tags",
		"notes",
	]);

	const notesCommon = new NoteStore(common, {
		fs,
		dir: layout.commonNotesDir,
		flavour: pathModule,
	});

	// Counted across sessions, so it needs an id that is unique per process and
	// never reused: the whole signal is "a different session made the same
	// mistake", and two sessions sharing an id would read as one.
	const stumbles = new StumbleLog({
		fs,
		file: layout.stumbleStateFile,
		flavour: pathModule,
		sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
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
		// Resolved here, where they were computed, so the model never describes
		// a path it worked out from a convention.
		paths: {
			settingsFile: layout.settingsFile,
			memoryDir: layout.memoryDir,
		},
		// The engine's own view, for the same reason: what the embedder is
		// doing right now is not derivable from anything this extension holds.
		engine: {
			configFile: configFile.path,
			embedderState: () => (projectWriter ?? commonReader).embedderState(),
		},
		stumbles,
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
		// A project nobody has opened since the embedder changed still holds
		// vectors from the old space, and a read-only handle cannot rebuild
		// them. This takes the writer lock for exactly as long as the repair,
		// and reports plainly when somebody else is holding it.
		repairProject: async (id: string) => {
			if (!embedderPresent) {
				return "there is no embedder configured to rebuild its vectors with";
			}
			let writer: PlugmemStore;
			try {
				writer = await PlugmemStore.open(
					dbPath(projectDbName(id)),
					openOptions,
				);
			} catch (error) {
				return isLocked(error)
					? "a session is open in it right now, so its vectors cannot be rebuilt"
					: `it could not be opened: ${String(error)}`;
			}
			try {
				const result = await syncVectorSpace(writer, {
					autoReembed: true,
					label: "it",
				});
				// "suspended" is reported like a failure on purpose: the caller
				// asked for a repair and did not get one, and the reason - a
				// provider that is not answering - is the user's to act on.
				return result.action === "failed" || result.action === "suspended"
					? result.notice
					: undefined;
			} finally {
				writer.close();
			}
		},
	});

	const cursors = new CursorStore(
		fs,
		layout.consolidationStateFile,
		pathModule,
	);
	const reviewCursor = new ReviewCursorStore(
		fs,
		layout.reviewStateFile,
		pathModule,
	);
	// A pass runs outside a project too, and the reasoning that used to stop it
	// was simply wrong: pi keys the transcript directory by WORKING DIRECTORY,
	// not by project, so there is always something to resume from. What a
	// non-project directory lacks is a project memory - so the pass curates the
	// shared memory about the user and nothing else, which is the correct answer
	// rather than a degraded one. There is no codebase there to have facts about.
	const label =
		projectRoot === undefined
			? "a directory that is not a project, so only the shared memory about the user is open here"
			: `this project (${basename(projectRoot)})`;

	const consolidation = !settings.memory.consolidation.enabled
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
				// Outside a project the working directory is the key, because
				// that is exactly what pi files the transcript under.
				cursorKey: projectId ?? cwd,
				label,
				stumbles,
				alwaysLimits: settings.memory.instructions,
				reviewCursor,
				scopeLabel: (scope) =>
					scope === "user"
						? "your memory about the user"
						: projectRoot === undefined
							? "this directory"
							: `this project (${basename(projectRoot)})`,
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
		settings,
		instructions,
		headInstructions,
		cursors,
		stumbles,
		...(consolidation === undefined ? {} : { consolidation }),
		consolidationQuietMs:
			consolidation === undefined ? 0 : settings.memory.consolidation.quietMs,
		reembed: async (onProgress) => {
			// Recomputing vectors needs a provider to compute them with. Saying
			// so beats the engine's own error, which arrives after the command
			// has already announced that it started.
			if (!embedderPresent) {
				return {
					steps: [],
					blocked:
						"There is no embedder configured, so there are no vectors to rebuild. " +
						`Switch one on in ${configFile.path}, then run this again.`,
				};
			}
			// Every database in the workspace, because a partial reembed leaves
			// half the memory answering in one vector space and half in another.
			const names = [COMMON_DB, ...(await listDbNames(fs, pathModule, layout))];
			// File names are not names. `p_dd21d9ddb1fa` identifies a database
			// to the engine and nothing at all to the person watching a rebuild
			// or reading which one was skipped.
			const known = await router.list();
			const labelOf = (name: string): string => {
				if (name === COMMON_DB) return "shared memory about you";
				const id = name.slice("p_".length);
				return known.find((project) => project.projectId === id)?.name ?? name;
			};
			const steps: ProgressStep[] = names.map((name) => ({
				label: labelOf(name),
				state: "waiting",
			}));
			// This session already holds the writer for its own project, and a
			// second writer on the same file is refused by the engine - it would
			// report the session as "locked by another process" when the other
			// process is itself. So that one database is rebuilt through the
			// handle we have rather than through a new one.
			const ownName =
				projectId === undefined ? undefined : projectDbName(projectId);
			for (const [index, name] of names.entries()) {
				const step = steps[index];
				if (step === undefined) continue;
				step.state = "running";
				onProgress?.(steps);
				try {
					if (name === COMMON_DB) {
						// Through the lease, not a bare writer: the lease publishes
						// and then refreshes our read-only handle. Skipping that
						// leaves this session reading the pre-rebuild snapshot -
						// old vectors, new embedder, mismatch on the next question.
						await common.withWriteLease((writer) =>
							(writer as unknown as PlugmemStore).reembed(),
						);
					} else if (name === ownName && projectWriter !== undefined) {
						await projectWriter.reembed();
						await projectWriter.checkpoint();
					} else {
						const writer = await PlugmemStore.open(dbPath(name), openOptions);
						try {
							await writer.reembed();
							await writer.checkpoint();
						} finally {
							writer.close();
						}
					}
					step.state = "done";
				} catch (error) {
					// One database held by another session must not cost the user
					// the rebuild of all the others; it must also not pass in
					// silence, because a half-rebuilt workspace answers from two
					// vector spaces at once.
					if (!isLocked(error) && !(error instanceof CommonMemoryBusyError)) {
						throw error;
					}
					step.state = "skipped";
				}
				onProgress?.(steps);
			}
			return { steps };
		},
		...(projectId === undefined ? {} : { projectId }),
		...(projectRoot === undefined ? {} : { projectRoot }),
		notices,
		configFile: configFile.path,
		// Through the writer when this session has one: it is the handle that
		// embeds what gets stored, so it is the one whose suspension changes
		// what the memory can do. The reader answers when there is no writer.
		embedderState: () => (projectWriter ?? commonReader).embedderState(),
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
