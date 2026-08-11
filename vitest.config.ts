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
			exclude: ["tests/helpers/**", "src/index.ts"],
			thresholds: {
				lines: 80,
				functions: 80,
				branches: 80,
				statements: 80,
			},
		},
	},
});
