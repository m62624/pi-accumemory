import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			// Fakes and harnesses live only under tests/helpers; measuring them
			// would inflate the number without covering a line of the extension.
			include: ["src/**/*.ts"],
			// Two files are pure wiring to somebody else's runtime: the pi
			// extension entry and the background agent driver. Neither holds a
			// decision - every one of those lives in a module below them, which
			// is measured - and covering them would mean booting a real model.
			exclude: [
				"tests/helpers/**",
				"src/index.ts",
				"src/consolidation/pi-agent.ts",
			],
			// 90 across the board. Anything the tests do not reach is either
			// dead or a case nobody thought about, and both are worth knowing.
			thresholds: {
				lines: 90,
				functions: 90,
				branches: 90,
				statements: 90,
			},
		},
	},
});
