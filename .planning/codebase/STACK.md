# Technology Stack

**Analysis Date:** 2026-05-01

## Languages

**Primary:**
- TypeScript ^5.8.3 — All plugin source under `src/**/*.ts`, tests under `tests/**/*.ts`, and the Obsidian mock at `__mocks__/obsidian.ts`. Strict mode enabled (`tsconfig.json:8-21`: `strict`, `noImplicitAny`, `noImplicitThis`, `noImplicitReturns`, `noUncheckedIndexedAccess`, `strictNullChecks`, `useUnknownInCatchVariables`).

**Secondary:**
- JavaScript (ESM) — Build tooling only: `esbuild.config.mjs`, `version-bump.mjs`. Not used in the runtime bundle.

## Runtime

**Environment:**
- Obsidian Plugin API (Electron renderer on desktop, native WebView on iOS/Android via Capacitor). `manifest.json:5` pins `minAppVersion: 1.4.16`. `manifest.json:9` sets `isDesktopOnly: false` — mobile parity is a v1 requirement.
- Bundle target: `es2018` (`esbuild.config.mjs:37`, `tsconfig.json:7`). CommonJS output (`format: "cjs"` at `esbuild.config.mjs:36`) per Obsidian plugin loader convention.
- Node 20 type definitions used at build/test time (`@types/node ^20.11.0` in `package.json:26`); no Node runtime APIs reach the bundle (esbuild marks all `builtinModules` external — `esbuild.config.mjs:34`).

**Package Manager:**
- npm (no `pnpm-lock.yaml` / `yarn.lock` present).
- Lockfile: `package-lock.json` present at repo root (~208 KB).
- `.npmrc` sets `tag-version-prefix=""` so `npm version` produces unprefixed tags (e.g. `0.1.0`, not `v0.1.0`) to match `versions.json` keys.

## Frameworks

**Core:**
- `obsidian` (latest, dev-only) — Plugin host. Imported as an `external` at bundle time (`esbuild.config.mjs:21`); the actual runtime is provided by the user's Obsidian install. Used for `Plugin`, `Notice`, `Platform`, `TFile`, `Modal`, `PluginSettingTab`, `Setting`, `setIcon`, `requestUrl`, `normalizePath`, `Vault.process`, `FileManager.processFrontMatter` (see `src/main.ts:1`, `src/client/http.ts:1`, `src/sync/frontmatter.ts:2`).
- CodeMirror 6 (`@codemirror/*`, `@lezer/*`) — Listed as externals in `esbuild.config.mjs:22-33` because Obsidian ships them. Not directly imported by this plugin.

**Testing:**
- Vitest ^2.1.8 (`package.json:35`) — Test runner. Config at `vitest.config.ts`: `environment: "node"`, `globals: false` (suite imports `describe`/`it`/`expect` explicitly), discovers `tests/**/*.test.ts`. Aliases `obsidian` → `__mocks__/obsidian.ts` so unit tests don't need a real Obsidian runtime.
- `vitest/globals` types injected via `tsconfig.json:30-32` for autocomplete inside tests.

**Build/Dev:**
- esbuild 0.25.5 — Bundler (`esbuild.config.mjs`). Single entry `src/main.ts` → `main.js` at repo root (Obsidian's required layout, see `README.md:65`). Watch mode via `npm run dev`; production via `npm run build` which runs `tsc -noEmit -skipLibCheck` first then `node esbuild.config.mjs production` (minify on, sourcemap off).
- TypeScript compiler ^5.8.3 — Type-check only; never emits. esbuild handles transpile.
- ESLint 9 (`@eslint/js 9.30.1`, `typescript-eslint 8.35.1`, `eslint-plugin-obsidianmd 0.1.9`) — Flat config at `eslint.config.mts`. Uses `obsidianmd.configs.recommended` for plugin-specific rules; relaxes `import/no-nodejs-modules` and `no-undef` for the test tree.
- `globals 14.0.0`, `jiti 2.6.1`, `tslib 2.4.0` — ESLint/runtime helper deps.

## Key Dependencies

**Critical (runtime):**
- `gray-matter ^4.0.3` — YAML frontmatter parser. Used in `src/sync/frontmatter.ts` for `parseFile` / `stringifyFile`. The body returned by `matter()` is what the plugin hashes for content equality (so frontmatter-only changes like `huma_uuid` injection don't invalidate hashes — see `src/sync/frontmatter.ts:11-21`).

**Declared but not currently imported:**
- `diff-match-patch ^1.0.5` (+ `@types/diff-match-patch ^1.0.36` in devDependencies) — Listed in `package.json:38` but no `import` of it exists anywhere under `src/` (verified by grep). Three-way merge is performed server-side (`merge_clean` / `merge_dirty` outcomes in `src/types.ts:88-103`); no client-side diff is run today. Either prune the dep or remove if confirmed unused — flag in CONCERNS.md.

**Critical (devDependencies — see `package.json:23-36`):**
- `obsidian` (latest) — Plugin API typings + runtime injection point.
- `esbuild 0.25.5` — Bundler.
- `vitest ^2.1.8` — Test runner.
- `typescript ^5.8.3` — Type checker.
- `typescript-eslint 8.35.1` + `@eslint/js 9.30.1` + `eslint-plugin-obsidianmd 0.1.9` — Lint stack.

**Web platform APIs used directly (no SDK):**
- `crypto.subtle.digest("SHA-256", …)` — `src/sync/hash.ts:7`. Web Crypto is chosen over `node:crypto` because Obsidian's iOS/Android targets are Capacitor WebViews where `node:crypto` is not exposed (comment at `src/sync/hash.ts:1-3`).
- `TextEncoder` — `src/sync/hash.ts:5`.
- `URLSearchParams` — `src/client/vault-api.ts:33`.
- `structuredClone` — `src/main.ts:31`, `src/main.ts:538`.
- `window.setInterval` / `window.clearInterval` — `src/main.ts:84,351,360`.

## Configuration

**Environment:**
- No environment variables. The plugin runs inside Obsidian's process; there is no `.env` file in scope (the `.env` and `.env.*` patterns appear in `.gitignore:24-25` defensively). Verified: no `process.env.*` references under `src/`.
- User-tunable settings persist to Obsidian's per-plugin data store at `<vault>/.obsidian/plugins/huma-vault-sync/data.json` via `Plugin.loadData()` / `Plugin.saveData()` (`src/main.ts:94-101`). Schema in `src/settings.ts:10-18` (`HumaPluginData`). Defaults at `src/settings.ts:40-55`:
  - `serverBaseUrl`: `https://huma.energy`
  - `syncIntervalSeconds`: `30` (clamped 10–300, see `SYNC_INTERVAL_MIN_SECONDS` / `SYNC_INTERVAL_MAX_SECONDS`)
  - `excludedFolders`: `[]`

**Build:**
- `esbuild.config.mjs` — Bundle config. Inline sourcemaps in dev, none in prod. Banner injected.
- `tsconfig.json` — Strict TS settings. `baseUrl: "src"`, but no path aliases are defined; imports use relative paths throughout (`src/main.ts:2-25`).
- `eslint.config.mts` — Flat config; uses `tseslint.config(...)` factory.
- `vitest.config.ts` — Aliases `obsidian` to the in-repo mock.

**Versioning:**
- `manifest.json` (`version`, `minAppVersion`) and `versions.json` (history map) are kept in sync by `version-bump.mjs`, run via `npm version` (declared in `package.json:10`).
- Current version: `0.1.0` (manifest, package.json, versions.json all agree).

## Platform Requirements

**Development:**
- Node + npm (any modern version compatible with esbuild 0.25, Vitest 2; declared `@types/node ^20.11.0` implies Node 20 is the target).
- An Obsidian install ≥ 1.4.16 for manual end-to-end testing. The repo can be symlinked into `<vault>/.obsidian/plugins/huma-vault-sync/` for live reload (`README.md:65`).

**Production (end-user):**
- Obsidian ≥ 1.4.16 on macOS desktop, Linux desktop, iOS, or Android (`manifest.json:5`, `manifest.json:9`).
- Distribution: GitHub releases, sideloaded via BRAT (`README.md:9-18`). Not in the official Obsidian community plugin registry yet.
- Build artefact: `main.js` (single bundled CJS file, ~91 KB at last build) plus `manifest.json` and `styles.css`. `main.js` is gitignored (`.gitignore:12`) and uploaded to GitHub releases instead.

---

*Stack analysis: 2026-05-01*
