import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"eslint.config.js",
						"manifest.json",
						"vitest.config.ts",
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Tests and Vitest config run under Node — Node builtins and globals
		// are intentionally available; the obsidianmd recommendations (which
		// assume plugin-runtime sandboxing) don't apply here.
		files: ["tests/**/*.ts", "vitest.config.ts"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			"import/no-nodejs-modules": "off",
			"no-undef": "off",
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		"__mocks__",
		"tests/fixtures",
		// Sibling worktrees the GSD orchestrator creates live under
		// .claude/worktrees and contain duplicate (often stale) copies of the
		// source tree. They are out of scope for the in-tree lint pass.
		".claude",
	]),
);
