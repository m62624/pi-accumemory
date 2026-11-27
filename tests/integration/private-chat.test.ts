import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionUIContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { registerPrivateChat } from "../../src/private-chat.ts";

type Completion = ExtensionContext["modelRegistry"]["complete"];
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type PanelFactory = Parameters<ExtensionUIContext["custom"]>[0];
type TerminalInput = Parameters<ExtensionUIContext["onTerminalInput"]>[0];
type WidgetFactory = Exclude<
	Parameters<ExtensionUIContext["setWidget"]>[1],
	string[] | undefined
>;

const reply = {
	role: "assistant",
	content: [
		{ type: "text", text: "private reply" },
		{ type: "thinking", thinking: "private reasoning" },
		{
			type: "toolCall",
			id: "call_1",
			name: "longterm_remember",
			arguments: { text: "private fact" },
		},
	],
	stopReason: "toolUse",
	timestamp: 1,
} as const;

function harness(session = SessionManager.inMemory()) {
	const commands = new Map<string, Command>();
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	setKeybindings(keybindings);
	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let terminalInput: TerminalInput | undefined;
	let widget: ReturnType<WidgetFactory> | undefined;
	let panel: Awaited<ReturnType<PanelFactory>>;
	const complete = vi.fn<(...args: Parameters<Completion>) => Promise<unknown>>(
		async () => reply,
	);
	const notify = vi.fn();
	const theme = {
		bold: (text: string) => text,
		fg: (_role: string, text: string) => text,
	};
	const custom = vi.fn(
		(factory: PanelFactory) =>
			new Promise((resolve, reject) => {
				const tui = { terminal: { rows: 28 }, requestRender: () => {} };
				Promise.resolve(
					factory(tui as never, theme as never, undefined as never, (value) => {
						panel.dispose?.();
						resolve(value);
					}),
				).then((component) => {
					panel = component;
				}, reject);
			}),
	);
	const context = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: session,
		model: { id: "test-model" },
		modelRegistry: { complete },
		ui: {
			notify,
			custom,
			setWidget: (_key: string, factory?: WidgetFactory) => {
				widget = factory?.(undefined as never, theme as never);
			},
			onTerminalInput: (handler: TerminalInput) => {
				terminalInput = handler;
				return () => {
					terminalInput = undefined;
				};
			},
		},
	};
	registerPrivateChat({
		registerCommand: (name: string, command: Command) =>
			commands.set(name, command),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			events.set(event, handler),
	} as unknown as ExtensionAPI);
	const emit = (event: string, data: unknown = {}) =>
		events.get(event)?.(data, context);
	return {
		context,
		complete,
		custom,
		notify,
		command: (name: string, args = "") =>
			commands
				.get(name)
				?.handler(args, context as unknown as ExtensionCommandContext),
		press: (key: string) => panel.handleInput?.(key),
		terminal: (key: string) => terminalInput?.(key),
		submit: (message: string) => {
			for (const char of message) panel.handleInput?.(char);
			panel.handleInput?.("\r");
		},
		render: () => panel.render(80).join("\n"),
		widget: () => widget?.render(80).join("\n"),
		emit,
	};
}

describe("private chat commands", () => {
	it("uses recent main-chat text for exactly one request without modifying the transcript", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "accumemory-btw-"));
		try {
			const real = SessionManager.create(dir, dir);
			real.appendMessage({
				role: "user",
				content: "main chat marker",
				timestamp: 0,
			});
			real.appendMessage({
				...reply,
				stopReason: "stop",
				content: [{ type: "text", text: "public answer" }],
			} as unknown as Awaited<ReturnType<Completion>>);
			const file = real.getSessionFile();
			if (file === undefined)
				throw new Error("Expected a persistent main session.");
			const before = await readFile(file);
			const ui = harness(real);
			await ui.command(
				"longterm-btw",
				"   single  private question\nsecond line",
			);
			expect(ui.widget()).toContain("private reply");
			expect(ui.custom).not.toHaveBeenCalled();
			expect(ui.complete).toHaveBeenCalledTimes(1);
			const [, context, options] = ui.complete.mock.calls[0] ?? [];
			expect(context?.systemPrompt).toContain("main chat marker");
			expect(context?.messages).toMatchObject([
				{ role: "user", content: "single  private question\nsecond line" },
			]);
			expect(context?.tools).toBeUndefined();
			expect(options?.cacheRetention).toBe("none");
			ui.emit("before_agent_start");
			expect(ui.widget()).toBeUndefined();
			expect(await readFile(file)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("handles BTW as the first input without starting the main agent", async () => {
		const ui = harness();
		expect(
			await ui.emit("input", { text: "/longterm-btw\tfirst private question" }),
		).toEqual({
			action: "handled",
		});
		expect(ui.complete).toHaveBeenCalledOnce();
		expect(ui.complete.mock.calls[0]?.[1]).toEqual({
			systemPrompt: "Answer the question directly.",
			messages: [
				expect.objectContaining({
					role: "user",
					content: "first private question",
				}),
			],
		});
		expect(ui.widget()).toContain("private reply");
		expect(ui.context.sessionManager.getBranch()).toEqual([]);
		expect(ui.context.sessionManager.getSessionFile()).toBeUndefined();
		expect(
			await ui.emit("input", { text: "normal next turn" }),
		).toBeUndefined();
	});

	it("reports provider failures without printing the request and allows a new BTW", async () => {
		const ui = harness();
		ui.complete.mockResolvedValueOnce({
			...reply,
			stopReason: "error",
			errorMessage: "503 response contains private question",
		});
		await ui.command("longterm-btw", "private question");
		expect(ui.widget()).toContain("HTTP 503");
		expect(ui.widget()).not.toContain("private question");
		await ui.command("longterm-btw", "retry");
		expect(ui.widget()).toContain("private reply");
	});

	it.each([
		{
			run: async () => {
				throw new Error("Connection error.");
			},
			status: "Could not connect to the selected model.",
		},
		{
			run: async () => {
				throw "private prompt in non-Error rejection";
			},
			status: "The selected model could not complete the request.",
		},
		{
			run: async () => ({ ...reply, stopReason: "aborted" }),
			status: "The selected model could not complete the request.",
		},
		{
			run: async () => ({
				...reply,
				stopReason: "stop",
				content: [reply.content[1]],
			}),
			status: "The model returned reasoning without a text answer.",
		},
		{
			run: async () => ({ ...reply, stopReason: "stop", content: [] }),
			status: "The model returned no text answer.",
		},
	])(
		"reports $status when the first BTW yields no answer",
		async ({ run, status }) => {
			const ui = harness();
			ui.complete.mockImplementationOnce(run);
			await ui.command("longterm-btw", "private prompt");
			expect(ui.widget()).toContain(status);
			expect(ui.widget()).not.toContain("private prompt");
			expect(ui.context.sessionManager.getBranch()).toEqual([]);
		},
	);

	it("can cancel an inline request and drops a late reply", async () => {
		const ui = harness();
		let finish = (_answer: unknown) => {};
		ui.complete.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = ui.command("longterm-btw", "private question");
		expect(ui.widget()).toContain("Waiting");
		expect(ui.terminal("x")).toBeUndefined();
		await ui.command("longterm-btw", "second question");
		expect(ui.complete).toHaveBeenCalledOnce();
		expect(ui.terminal("\x1b")).toEqual({ consume: true });
		finish(reply);
		await pending;
		expect(ui.widget()).toBeUndefined();
		expect(ui.complete.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
	});

	it("renders BTW as plain terminal text and clears it on shutdown", async () => {
		const ui = harness();
		ui.complete.mockResolvedValueOnce({
			...reply,
			content: [{ type: "text", text: "private\tanswer\x00\r\nsecond line" }],
		});
		await ui.command("longterm-btw", "private question");
		expect(ui.widget()).toContain("private    answer");
		expect(ui.widget()).toContain("second line");
		expect(ui.widget()).not.toContain("\x00");
		ui.emit("session_shutdown");
		expect(ui.widget()).toBeUndefined();
	});

	it("recovers when the incognito panel fails to open", async () => {
		const ui = harness();
		ui.custom.mockRejectedValueOnce(new Error("panel unavailable"));
		await ui.command("longterm-incognito", "on");
		expect(ui.notify).toHaveBeenLastCalledWith("Private chat failed.", "error");
		await ui.command("longterm-btw", "new private question");
		expect(ui.widget()).toContain("private reply");
	});

	it("carries only private text between incognito turns and starts fresh on reopen", async () => {
		const ui = harness();
		ui.context.sessionManager.appendMessage({
			role: "user",
			content: "main chat marker",
			timestamp: 0,
		});
		const first = ui.command("longterm-incognito", "on");
		await Promise.resolve();
		ui.submit("private turn one");
		await vi.waitFor(() => expect(ui.render()).toContain("private reply"));
		ui.submit("private turn two");
		await vi.waitFor(() => expect(ui.complete).toHaveBeenCalledTimes(2));
		const context = ui.complete.mock.calls[1]?.[1];
		expect(context?.tools).toBeUndefined();
		expect(JSON.stringify(context)).not.toContain("main chat marker");
		expect(context?.messages.map(({ role }) => role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		expect(context?.messages[1]?.content).toEqual([
			{ type: "text", text: "private reply" },
		]);
		ui.press("\x1b[5~");
		ui.render();
		ui.press("\x1b[6~");
		ui.submit("/longterm-incognito off");
		await first;
		expect(ui.complete).toHaveBeenCalledTimes(2);

		const second = ui.command("longterm-incognito", "on");
		await Promise.resolve();
		ui.submit("new private conversation");
		expect(ui.complete.mock.calls[2]?.[1].messages).toMatchObject([
			{ role: "user", content: "new private conversation" },
		]);
		ui.emit("session_shutdown");
		await second;
		expect(ui.complete.mock.calls[2]?.[2]?.signal?.aborted).toBe(true);
	});

	it("discards a failed request and ignores a completion after closing mid-request", async () => {
		const ui = harness();
		ui.complete.mockResolvedValueOnce({ ...reply, stopReason: "error" });
		const pending = ui.command("longterm-incognito", "on");
		await Promise.resolve();
		ui.submit("");
		expect(ui.complete).not.toHaveBeenCalled();
		ui.submit("failed private question");
		await vi.waitFor(() => expect(ui.render()).toContain("No answer"));
		let finish = (_answer: unknown) => {};
		ui.complete.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		ui.submit("cancelled private question");
		ui.submit("draft while the reply is pending");
		expect(ui.complete).toHaveBeenCalledTimes(2);
		expect(ui.render()).toContain("draft while the reply is pending");
		expect(ui.complete.mock.calls[1]?.[1].messages).toMatchObject([
			{ role: "user", content: "cancelled private question" },
		]);
		await ui.command("longterm-incognito", "off");
		await pending;
		expect(ui.complete.mock.calls[1]?.[2]?.signal?.aborted).toBe(true);
		finish(reply);
		await Promise.resolve();
		expect(ui.render()).not.toContain("private reply");
	});

	it("requires a BTW question, an interactive idle session, and a selected model", async () => {
		const ui = harness();
		await ui.command("longterm-btw");
		expect(ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("<question>"),
			"info",
		);
		ui.context.hasUI = false;
		await ui.command("longterm-btw", "test");
		expect(ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("terminal UI"),
			"warning",
		);
		ui.context.hasUI = true;
		ui.context.isIdle = () => false;
		await ui.command("longterm-incognito", "on");
		expect(ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("idle"),
			"warning",
		);
		ui.context.isIdle = () => true;
		Object.assign(ui.context, { model: undefined });
		await ui.command("longterm-btw", "test");
		expect(ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("model"),
			"warning",
		);
		await ui.command("longterm-incognito");
		expect(ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("on or off"),
			"info",
		);
		expect(ui.complete).not.toHaveBeenCalled();
	});
});
