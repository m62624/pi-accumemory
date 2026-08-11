import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	COMMON_DB,
	extensionLayout,
	projectAppendDir,
	projectDbName,
} from "../src/layout.ts";

const posix = path.posix;

describe("extensionLayout", () => {
	const layout = extensionLayout("/home/m/.pi/agent", posix);

	it("roots everything under the extension's own directory", () => {
		expect(layout.root).toBe("/home/m/.pi/agent/extensions/pi-accumemory");
	});

	it("puts the plugmem workspace and its config together", () => {
		// The workspace config carries `[engine].dim`, and a database refuses to
		// open under a different dim. One config per workspace is what keeps
		// every database in it openable by the same handle.
		expect(layout.memoryDir).toBe(
			"/home/m/.pi/agent/extensions/pi-accumemory/memory",
		);
		expect(layout.configToml).toBe(
			"/home/m/.pi/agent/extensions/pi-accumemory/memory/config.toml",
		);
	});

	it("separates common notes from project notes", () => {
		expect(layout.commonNotesDir).toBe(
			"/home/m/.pi/agent/extensions/pi-accumemory/notes/common",
		);
		expect(layout.projectNotesDir("a1b2c3")).toBe(
			"/home/m/.pi/agent/extensions/pi-accumemory/notes/projects/a1b2c3",
		);
	});

	it("keeps bundled instruction defaults apart from the user's append", () => {
		// They are never merged into one directory: defaults are overwritten on
		// upgrade, append never is, and mixing them loses the user's text.
		expect(layout.instructionsDefaultsDir).toBe(
			"/home/m/.pi/agent/extensions/pi-accumemory/instructions/defaults",
		);
		expect(layout.instructionsAppendDir).toBe(
			"/home/m/.pi/agent/extensions/pi-accumemory/instructions/append",
		);
	});

	it("names the state and settings files", () => {
		expect(layout.consolidationStateFile).toBe(
			"/home/m/.pi/agent/extensions/pi-accumemory/state/consolidation.json",
		);
		expect(layout.settingsFile).toBe(
			"/home/m/.pi/agent/extensions/pi-accumemory/settings.json",
		);
	});

	it("uses native separators on windows", () => {
		const win = extensionLayout("C:\\Users\\m\\.pi\\agent", path.win32);
		expect(win.memoryDir).toBe(
			"C:\\Users\\m\\.pi\\agent\\extensions\\pi-accumemory\\memory",
		);
	});
});

describe("projectDbName", () => {
	it("prefixes project databases so they cannot collide with the common one", () => {
		expect(projectDbName("a1b2c3")).toBe("p_a1b2c3");
		expect(projectDbName("a1b2c3")).not.toBe(COMMON_DB);
	});

	it("refuses an id that is not a bare identifier", () => {
		// A database name reaching the filesystem as a path fragment is the one
		// way a project id could escape its directory.
		expect(() => projectDbName("../evil")).toThrow(/project id/i);
		expect(() => projectDbName("a/b")).toThrow(/project id/i);
		expect(() => projectDbName("")).toThrow(/project id/i);
	});
});

describe("projectAppendDir", () => {
	it("lives inside the project, so it can be committed with it", () => {
		expect(projectAppendDir("/home/m/app", posix)).toBe(
			"/home/m/app/.pi/pi-accumemory/instructions/append",
		);
	});
});
