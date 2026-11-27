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
	let shutdown = () => {};
	let panel: Awaited<ReturnType<PanelFactory>>;
	const complete = vi.fn<(...args: Parameters<Completion>) => Promise<unknown>>(
		async () => reply,
	);
	const notify = vi.fn();
	const context = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: session,
		model: { id: "test-model" },
		modelRegistry: { complete },
		ui: {
			notify,
			custom: (factory: PanelFactory) =>
				new Promise((resolve, reject) => {
					const tui = { terminal: { rows: 28 }, requestRender: () => {} };
					const theme = {
						bold: (text: string) => text,
						fg: (_role: string, text: string) => text,
					};
					Promise.resolve(
						factory(
							tui as never,
							theme as never,
							undefined as never,
							(value) => {
								panel.dispose?.();
								resolve(value);
							},
						),
					).then((component) => {
						panel = component;
					}, reject);
				}),
		},
	};
	registerPrivateChat({
		registerCommand: (name: string, command: Command) =>
			commands.set(name, command),
		on: (_event: string, handler: () => void) => {
			shutdown = handler;
		},
	} as unknown as ExtensionAPI);
	return {
		context,
		complete,
		notify,
		command: (name: string, args = "") =>
			commands
				.get(name)
				?.handler(args, context as unknown as ExtensionCommandContext),
		press: (key: string) => panel.handleInput?.(key),
		submit: (message: string) => {
			for (const char of message) panel.handleInput?.(char);
			panel.handleInput?.("\r");
		},
		render: () => panel.render(80).join("\n"),
		shutdown: () => shutdown(),
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
			const pending = ui.command("longterm-btw");
			await Promise.resolve();
			expect(ui.render()).toContain("Private question");
			ui.submit("single private question");
			await vi.waitFor(() => expect(ui.render()).toContain("private reply"));
			ui.submit("ignored second question");
			expect(ui.complete).toHaveBeenCalledTimes(1);
			const [, context, options] = ui.complete.mock.calls[0] ?? [];
			expect(context?.systemPrompt).toContain("main chat marker");
			expect(context?.tools).toBeUndefined();
			expect(options?.cacheRetention).toBe("none");
			ui.press("\x1b");
			await pending;
			expect(await readFile(file)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
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
		ui.shutdown();
		await second;
		expect(ui.complete.mock.calls[2]?.[2]?.signal?.aborted).toBe(true);
	});

	it("discards a failed request and ignores a completion after closing mid-request", async () => {
		const ui = harness();
		ui.complete.mockResolvedValueOnce({ ...reply, stopReason: "error" });
		const pending = ui.command("longterm-incognito", "on");
		await Promise.resolve();
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

	it("rejects inline BTW text, non-interactive calls, busy sessions and missing models", async () => {
		const ui = harness();
		await ui.command("longterm-btw", "inline question");
		expect(ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("panel"),
			"warning",
		);
		ui.context.hasUI = false;
		await ui.command("longterm-btw");
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
		await ui.command("longterm-btw");
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
