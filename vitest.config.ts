import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
	test: {
		environment: "node",
		globals: false,
		include: ["tests/**/*.test.ts"],
	},
	resolve: {
		alias: {
			obsidian: resolve(__dirname, "__mocks__/obsidian.ts"),
		},
	},
});
