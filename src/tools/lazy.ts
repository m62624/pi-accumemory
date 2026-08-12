/**
 * The controller façade the tools are registered against.
 *
 * The tools are registered before the databases finish opening, because the
 * tool list belongs to the prompt head and must not change mid-session. This
 * bridges the gap: every call goes through whatever the controller is by then,
 * and a call that arrives before startup finished gets a sentence rather than a
 * crash.
 *
 * It lives here, apart from the extension shell, for one reason: it used to be
 * written inline and cast to the controller type with `as unknown as`, which is
 * the one cast the compiler cannot check. A member left out of it - `readAbout`
 * was - is then `undefined` at runtime, and the tool that needs it throws on
 * every call. Typed as `ToolController` with no cast, the same omission is a
 * build error; kept in a file with no SDK imports, it is also testable, which
 * the shell is not.
 */

import type { ToolController } from "./definitions.ts";

/** What every call answers with before the memory has opened. */
export const MEMORY_UNAVAILABLE =
	"Long-term memory is not available in this session.";

/** The controller, or the sentence above if there is not one yet. */
export function lazyController(
	get: () => { controller: ToolController } | undefined,
): ToolController {
	return {
		ask: async (input) => get()?.controller.ask(input) ?? MEMORY_UNAVAILABLE,
		askProject: async (project, question) =>
			get()?.controller.askProject(project, question) ?? MEMORY_UNAVAILABLE,
		projects: async () => get()?.controller.projects() ?? MEMORY_UNAVAILABLE,
		remember: async (input) =>
			get()?.controller.remember(input) ?? MEMORY_UNAVAILABLE,
		revise: async (...args) =>
			get()?.controller.revise(...args) ?? MEMORY_UNAVAILABLE,
		forget: async (...args) =>
			get()?.controller.forget(...args) ?? MEMORY_UNAVAILABLE,
		listTags: async (...args) =>
			get()?.controller.listTags(...args) ?? MEMORY_UNAVAILABLE,
		link: async (...args) =>
			get()?.controller.link(...args) ?? MEMORY_UNAVAILABLE,
		unlink: async (...args) =>
			get()?.controller.unlink(...args) ?? MEMORY_UNAVAILABLE,
		notes: (...args) => get()?.controller.notes(...args),
		readAbout: (topic) =>
			get()?.controller.readAbout(topic) ?? MEMORY_UNAVAILABLE,
	};
}
