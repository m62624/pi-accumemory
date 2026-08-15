import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Turn } from "../../src/memory/transcript-view.ts";
import { NoteStore } from "../../src/notes/store.ts";
import { ProjectRouter } from "../../src/router/router.ts";
import {
	ALWAYS_TAG,
	INSTRUCTION_TAG,
	MemoryController,
} from "../../src/session/controller.ts";
import {
	DEFAULT_SETTINGS,
	type Settings,
} from "../../src/settings/defaults.ts";
import { FakeFs } from "../helpers/fake-fs.ts";
import { FakeMemory } from "../helpers/fake-memory.ts";

function settingsWith(patch: (draft: Settings) => void): Settings {
	const draft = structuredClone(DEFAULT_SETTINGS);
	patch(draft);
	return draft;
}

function build(options: { withProject?: boolean; settings?: Settings } = {}) {
	const common = new FakeMemory();
	const project = options.withProject === false ? undefined : new FakeMemory();
	const fs = new FakeFs();
	const controller = new MemoryController({
		settings: options.settings ?? DEFAULT_SETTINGS,
		common,
		...(project === undefined ? {} : { project }),
		projectName: "app",
		notesCommon: new NoteStore(common, {
			fs,
			dir: "/notes/common",
			flavour: path.posix,
		}),
		...(project === undefined
			? {}
			: {
					notesProject: new NoteStore(project, {
						fs,
						dir: "/notes/p1",
						flavour: path.posix,
					}),
				}),
		router: new ProjectRouter(common),
		now: () => new Date("2026-08-11T12:00:00Z"),
	});
	return { controller, common, project, fs };
}

const userTurn = (text: string): Turn => ({ role: "user", text });

describe("MemoryController.tail", () => {
	it("adds nothing when memory is switched off", async () => {
		const { controller } = build({
			settings: settingsWith((draft) => {
				draft.memory.enabled = false;
			}),
		});
		expect(await controller.tail([userTurn("hello")])).toBe("");
	});

	it("carries the clock even before anything is remembered", async () => {
		// Without a current time nothing downstream can tell a passed date from
		// a future one, and stale facts are never retired.
		const { controller } = build();
		expect(await controller.tail([userTurn("hello")])).toContain("[Now:");
	});

	it("shows what the memory holds for the user's question", async () => {
		const { controller, project } = build();
		await project?.remember({
			text: "the cache is off because of a warmup race",
		});
		const tail = await controller.tail([userTurn("why is the cache off")]);
		expect(tail).toContain("warmup race");
	});

	it("does not repeat a fact the transcript already shows", async () => {
		const { controller, project } = build();
		await project?.remember({
			text: "the cache is off because of a warmup race",
		});
		const tail = await controller.tail([
			userTurn("why is the cache off"),
			{ role: "tool", text: "the cache is off because of a warmup race" },
		]);
		expect(tail).not.toContain("warmup race");
	});

	it("holds the block steady between refresh events", async () => {
		// This is the property the prefix cache depends on: no new bytes in the
		// tail on the steps in between.
		const { controller, project } = build();
		await project?.remember({
			text: "the cache is off because of a warmup race",
		});
		// Burn the one-shot manifest first, so the comparison is about the
		// block and not about that.
		await controller.tail([userTurn("why is the cache off")]);

		const first = await controller.tail([userTurn("why is the cache off")]);
		controller.noteToolCall("read");
		const second = await controller.tail([
			userTurn("why is the cache off"),
			{ role: "tool", text: "unrelated output" },
		]);
		expect(second).toBe(first);
		expect(first).toContain("warmup race");
	});

	it("recomputes when the user says something new", async () => {
		const { controller, project } = build();
		await project?.remember({
			text: "the cache is off because of a warmup race",
		});
		await project?.remember({
			text: "biome is the formatter used in this repo",
		});
		await controller.tail([userTurn("why is the cache off")]);
		controller.noteUserMessage();
		const second = await controller.tail([
			userTurn("why is the cache off"),
			{ role: "assistant", text: "because of the warmup" },
			userTurn("which formatter does this repo use"),
		]);
		expect(second).toContain("biome");
	});

	it("shows the manifest once, and only once", async () => {
		// It exists so the model knows there is something to ask about; repeated
		// every turn it would be a standing tax for one sentence of news.
		const { controller, project } = build();
		await project?.remember({ text: "a decision", tags: ["decision"] });
		const first = await controller.tail([userTurn("hello")]);
		expect(first).toContain("decision(1)");
		controller.noteUserMessage();
		expect(await controller.tail([userTurn("hello again")])).not.toContain(
			"decision(1)",
		);
	});

	it("injects an always-tagged rule unconditionally", async () => {
		// Bypasses retrieval on purpose: this is the model's own standing rule,
		// and it must hold whatever the current question happens to be about.
		const { controller, project } = build();
		await project?.remember({
			text: "always run biome before committing",
			tags: [INSTRUCTION_TAG, ALWAYS_TAG],
		});
		expect(await controller.tail([userTurn("unrelated question")])).toContain(
			"always run biome",
		);
	});

	it("leaves an instruction without the always tag to retrieval", async () => {
		const { controller, project } = build();
		await project?.remember({
			text: "always run biome before committing",
			tags: [INSTRUCTION_TAG],
		});
		expect(
			await controller.tail([userTurn("unrelated question")]),
		).not.toContain("always run biome");
	});

	it("reminds about writing after a long stretch with nothing saved", async () => {
		const { controller } = build({
			settings: settingsWith((draft) => {
				draft.memory.nudge.afterMessages = 2;
			}),
		});
		controller.noteUserMessage();
		controller.noteUserMessage();
		expect(await controller.tail([userTurn("hello")])).toContain(
			"longterm_remember",
		);
	});

	it("clears the write reminder when consolidation starts", async () => {
		const { controller } = build({
			settings: settingsWith((draft) => {
				draft.memory.nudge.afterMessages = 2;
			}),
		});
		controller.noteUserMessage();
		controller.noteUserMessage();
		controller.noteBackgroundPassStart();
		expect(await controller.tail([userTurn("hello")])).not.toContain(
			"longterm_remember",
		);
	});

	it("hints at asking after answering twice without touching anything", async () => {
		const { controller } = build();
		controller.noteTurnEnd(false);
		controller.noteTurnEnd(false);
		expect(await controller.tail([userTurn("another question")])).toContain(
			"longterm_ask",
		);
	});
});

describe("MemoryController.ask", () => {
	it("answers from the project memory by default", async () => {
		const { controller, project } = build();
		await project?.remember({
			text: "the cache is off because of a warmup race",
		});
		expect(
			await controller.ask({ question: "why is the cache off" }),
		).toContain("warmup");
	});

	it("keeps the two memories as separate labelled sections", async () => {
		// Never one fused ranking. plugmem measured routing well ahead of
		// merging, and a merged list hides which memory an answer came from.
		const { controller, common, project } = build();
		await project?.remember({
			text: "the cache is off because of a warmup race",
		});
		await common.remember({
			text: "prefers Rust for systems work",
			entity: "user",
		});
		const answer = await controller.ask({
			question: "cache Rust",
			scope: "both",
		});
		expect(answer).toContain("this project (app)");
		expect(answer).toContain("your memory about the user");
	});

	it("says plainly that it knows nothing, rather than erroring", async () => {
		// An empty answer is an answer. A model told otherwise rephrases the
		// same question until something stops it.
		const { controller } = build();
		expect(await controller.ask({ question: "anything at all" })).toMatch(
			/nothing on this/i,
		);
	});

	it("marks a repeated question instead of pretending it is new", async () => {
		const { controller, project } = build();
		await project?.remember({
			text: "the cache is off because of a warmup race",
		});
		await controller.ask({ question: "why is the cache off" });
		expect(await controller.ask({ question: "why is the cache off" })).toMatch(
			/already asked/i,
		);
	});

	it("forgets the repeat once the user speaks again", async () => {
		const { controller, project } = build();
		await project?.remember({
			text: "the cache is off because of a warmup race",
		});
		await controller.ask({ question: "why is the cache off" });
		controller.noteUserMessage();
		expect(
			await controller.ask({ question: "why is the cache off" }),
		).not.toMatch(/already asked/i);
	});

	it("explains itself when this folder has no memory of its own", async () => {
		// Naming the consequence, not the condition: "not a project" says
		// nothing the model can act on, while "it follows the user everywhere"
		// is the cost, and the command that fixes it is one line.
		const { controller } = build({ withProject: false });
		const answer = await controller.ask({
			question: "anything",
			scope: "project",
		});
		expect(answer).toMatch(/no memory of its own/i);
		expect(answer).toContain('scope: "user"');
		expect(answer).toContain("/longterm-new");
	});
});

describe("MemoryController.remember", () => {
	it("stores into the project by default", async () => {
		// The default is the cheap mistake. A wrong fact in a project memory
		// never surfaces elsewhere; a wrong one in the shared memory is read at
		// the start of every session of every project, forever.
		const { controller, project, common } = build();
		await controller.remember({ text: "tests run under vitest here" });
		expect(project?.live()).toHaveLength(1);
		expect(common.live()).toHaveLength(0);
	});

	it("stores into the shared memory when the scope says so", async () => {
		const { controller, project, common } = build();
		await controller.remember({
			text: "prefers Rust for systems work",
			scope: "user",
		});
		expect(common.live()).toHaveLength(1);
		expect(project?.live()).toHaveLength(0);
	});

	it("reports the id it stored under", async () => {
		const { controller } = build();
		expect(await controller.remember({ text: "a durable fact" })).toMatch(
			/\[f\d+\]/,
		);
	});

	it("refuses a near-duplicate and points at what it already holds", async () => {
		const { controller } = build();
		const text = "formatting in this repository is done with biome";
		await controller.remember({ text });
		const second = await controller.remember({ text });
		expect(second).toMatch(/not stored/i);
		expect(second).toContain("longterm_revise");
	});

	it("flags a tag close to an existing one without changing it", async () => {
		const { controller } = build();
		await controller.remember({
			text: "a first fact about the build",
			tags: ["bug"],
		});
		const second = await controller.remember({
			text: "a completely different statement about deploys",
			tags: ["bugfix"],
		});
		expect(second).toContain("bugfix");
		expect(second).toMatch(/same meaning/i);
		expect(second).toMatch(/stored as written/i);
	});

	it("clears the write reminder once something is stored", async () => {
		const { controller } = build({
			settings: settingsWith((draft) => {
				draft.memory.nudge.afterMessages = 2;
			}),
		});
		controller.noteUserMessage();
		controller.noteUserMessage();
		await controller.remember({ text: "a durable fact" });
		expect(await controller.tail([userTurn("hello")])).not.toContain(
			"longterm_remember",
		);
	});
});

describe("MemoryController.askProject", () => {
	it("names the projects it does know when given one it does not", async () => {
		const { controller, common } = build();
		const router = new ProjectRouter(common);
		await router.resolve("/home/m/Projects/api");
		const answer = await controller.askProject("ghost", "how did I do auth");
		expect(answer).toMatch(/no project named "ghost"/i);
		expect(answer).toContain("api");
	});

	it("reads another project's memory without holding its writer", async () => {
		const { controller, common } = build();
		const other = new FakeMemory();
		await other.remember({ text: "auth here uses a signed cookie, not a JWT" });
		const router = new ProjectRouter(common);
		const registered = await router.resolve("/home/m/Projects/api");

		const withReader = new MemoryController({
			settings: DEFAULT_SETTINGS,
			common,
			router,
			notesCommon: new NoteStore(common, {
				fs: new FakeFs(),
				dir: "/notes/common",
				flavour: path.posix,
			}),
			openProjectReader: async (projectId) => {
				expect(projectId).toBe(registered.projectId);
				return { memory: other, close: () => {} };
			},
		});
		expect(await withReader.askProject("api", "how is auth done")).toContain(
			"signed cookie",
		);
		expect(controller).toBeDefined();
	});

	it("stays quiet when cross-project questions are switched off", async () => {
		const { controller } = build({
			settings: settingsWith((draft) => {
				draft.memory.crossProject.enabled = false;
			}),
		});
		expect(await controller.askProject("api", "anything")).toMatch(
			/switched off/i,
		);
	});
});

describe("an embedding service that is not answering", () => {
	/** The project memory, as a value rather than an optional one. */
	function projectMemory(): {
		controller: MemoryController;
		memory: FakeMemory;
	} {
		const { controller, project } = build();
		if (project === undefined) throw new Error("the fixture opens a project");
		return { controller, memory: project };
	}

	/** What plugmem throws under `on_error = "fail"`. */
	function embedderDown(): Error {
		return Object.assign(
			new Error(
				"embedder: error sending request for url (http://localhost:11434)",
			),
			{ code: "PLUGMEM_ENGINE" },
		);
	}

	it("explains a failed lookup instead of handing over the engine's error", async () => {
		// Raw, "PLUGMEM_ENGINE: embedder: error sending request" reaches the
		// model as a tool error and it concludes the memory itself is broken.
		const { controller, memory } = projectMemory();
		memory.failEveryRecall = embedderDown();
		const answer = await controller.ask({ question: "why is the cache off" });
		expect(answer).toMatch(/embedding service is not answering/i);
		expect(answer).toMatch(/nothing is damaged/i);
		expect(answer).not.toContain("PLUGMEM_ENGINE");
	});

	it("tells the model to stop retrying and to pass the setting on", async () => {
		// There is nothing here it can fix by calling again, and the one thing
		// that would have avoided it belongs to the person, not the model.
		const { controller, memory } = projectMemory();
		memory.failEveryRecall = embedderDown();
		const answer = await controller.ask({ question: "anything" });
		expect(answer).toMatch(/do not retry/i);
		expect(answer).toContain('on_error = "degrade"');
	});

	it("says plainly that nothing was stored", async () => {
		const { controller, memory } = projectMemory();
		memory.failNextWrite = embedderDown();
		const answer = await controller.remember({ text: "a durable fact" });
		expect(answer).toMatch(/^not stored/i);
		expect(answer).toMatch(/embedding service is not answering/i);
	});

	it("still lets every other failure through", async () => {
		// Only the embedder is turned into prose. A locked database, a full
		// disk or a bug must not be answered with a sentence about outages.
		const { controller, memory } = projectMemory();
		memory.failEveryRecall = Object.assign(new Error("disk on fire"), {
			code: "PLUGMEM_ENGINE",
		});
		await expect(controller.ask({ question: "anything" })).rejects.toThrow(
			/disk on fire/,
		);
	});
});
