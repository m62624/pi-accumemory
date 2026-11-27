import { stripVTControlCharacters } from "node:util";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export function plainPrivateText(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/\r\n?/gu, "\n")
		.replace(/\p{Cc}/gu, (char) =>
			char === "\n" ? char : char === "\t" ? "    " : "",
		);
}

export async function openPrivatePanel(
	ui: ExtensionUIContext,
	lifetime: AbortController,
	ask: (question: string) => Promise<string>,
): Promise<void> {
	await ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const editor = new Editor(tui, {
				borderColor: (line) => theme.fg("border", line),
				selectList: {
					selectedPrefix: theme.bold,
					selectedText: theme.bold,
					description: (text) => theme.fg("dim", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("dim", text),
				},
			});
			const transcript: string[] = [];
			let busy = false;
			let scroll = 0;
			let pageSize = 1;
			let status = "";
			const { signal } = lifetime;

			const dispose = () => {
				signal.removeEventListener("abort", close);
				lifetime.abort();
				editor.setText("");
				transcript.length = 0;
			};
			const close = () => {
				dispose();
				done();
			};
			signal.addEventListener("abort", close, { once: true });
			if (signal.aborted) close();

			editor.onSubmit = (input) => {
				const question = input.trim();
				if (question === "/longterm-incognito off") {
					close();
					return;
				}
				if (signal.aborted || question === "") return;
				if (busy) {
					editor.setText(input);
					return;
				}
				busy = true;
				scroll = 0;
				status = "Waiting for the model…";
				transcript.push(`You: ${plainPrivateText(question)}`);
				tui.requestRender();

				void ask(question)
					.then((answer) => {
						if (!signal.aborted) {
							transcript.push(`Assistant: ${plainPrivateText(answer)}`);
							status = "";
						}
					})
					.catch(() => {
						if (!signal.aborted) status = "No answer received from the model.";
					})
					.finally(() => {
						busy = false;
						if (!signal.aborted) tui.requestRender();
					});
			};

			return {
				get focused() {
					return editor.focused;
				},
				set focused(focused: boolean) {
					editor.focused = focused;
				},
				handleInput(data) {
					if (matchesKey(data, "escape")) {
						close();
					} else if (matchesKey(data, "pageUp")) {
						scroll += pageSize;
					} else if (matchesKey(data, "pageDown")) {
						scroll = Math.max(0, scroll - pageSize);
					} else {
						editor.handleInput(data);
					}
					if (!signal.aborted) tui.requestRender();
				},
				render(width) {
					const lines = transcript.flatMap((turn) => [
						...wrapTextWithAnsi(turn, width),
						"",
					]);
					const input = editor.render(width);
					const footer =
						"Esc or /longterm-incognito off closes · PgUp/PgDn scroll";
					pageSize = Math.max(1, tui.terminal.rows - input.length - 5);
					scroll = Math.min(scroll, Math.max(0, lines.length - pageSize));
					const end = lines.length - scroll;
					return [
						theme.bold(truncateToWidth("Incognito chat", width)),
						...lines.slice(Math.max(0, end - pageSize), end),
						...(status === "" ? [] : [truncateToWidth(status, width)]),
						...input,
						theme.fg("dim", truncateToWidth(footer, width)),
					];
				},
				invalidate() {
					editor.invalidate();
				},
				dispose,
			};
		},
		{ overlay: true, overlayOptions: { width: "90%", anchor: "center" } },
	);
}
