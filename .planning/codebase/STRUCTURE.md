# Codebase Structure

**Analysis Date:** 2026-05-01

## Directory Layout

```
huma-obsidian-upload/
├── src/                         # All TypeScript source
│   ├── main.ts                  # Plugin entry — extends obsidian Plugin
│   ├── settings.ts              # Persisted-data shape, defaults, type definitions
│   ├── types.ts                 # API wire-format types (manifest/pull/push/auth)
│   ├── audit/                   # Bounded audit ring buffer
│   │   └── ring.ts
│   ├── client/                  # HTTP transport + auth + Vault API wrapper
│   │   ├── http.ts              # FetchHttpClient (wraps obsidian requestUrl), HttpError
│   │   ├── auth.ts              # AuthClient, runDevicePollLoop, isAccessTokenExpired
│   │   └── vault-api.ts         # VaultApiClient (manifest/pull/push)
│   ├── security/                # Startup vault token-leak invariant
│   │   ├── token-shape.ts       # Heuristic regex + exact-match comparator
│   │   └── vault-token-scan.ts  # Walks vault, classifies hits as blocking/suspicious
│   ├── sync/                    # Sync subsystem — engine + reconcile + workers + helpers
│   │   ├── engine.ts            # SyncEngine (orchestrator)
│   │   ├── reconcile.ts         # Pure three-view diff → SyncAction[]
│   │   ├── scan.ts              # Vault walk + frontmatter parse + body hash
│   │   ├── pull-worker.ts       # Batched pull + write + manifest merge
│   │   ├── push-worker.ts       # Serial push + retry + apply (accept/merge_clean/merge_dirty)
│   │   ├── rename-local.ts      # Server→local file move via app.fileManager.renameFile
│   │   ├── conflict.ts          # .conflict.md sibling emission, conflict-file listing
│   │   ├── manifest-fetch-policy.ts  # Cold-start full + every-N re-baseline rule
│   │   ├── self-write-tracker.ts     # Suppresses plugin's own modify events
│   │   ├── exclusion.ts         # Folder-prefix exclusion shared by scan + reconcile
│   │   ├── frontmatter.ts       # gray-matter parse/stringify + huma_uuid helpers
│   │   ├── hash.ts              # Web Crypto SHA-256 hex
│   │   └── token-manager.ts     # OAuth access-token cache + refresh + AuthSource impl
│   └── ui/                      # Settings tab, status bar, modals
│       ├── settings-tab.ts      # PluginSettingTab
│       ├── status-bar.ts        # Desktop status bar item (icon + label per state)
│       ├── audit-log-modal.ts   # Filterable sync log modal
│       └── mobile-status-modal.ts  # Mobile equivalent of the status bar
├── tests/                       # Vitest unit/integration tests
│   ├── audit/
│   │   └── ring.test.ts
│   ├── client/
│   │   └── auth.test.ts
│   ├── security/
│   │   ├── no-token-vault-write.test.ts
│   │   ├── token-shape.test.ts
│   │   └── vault-token-scan.test.ts
│   ├── sync/
│   │   ├── conflict.test.ts
│   │   ├── exclusion.test.ts
│   │   ├── frontmatter.test.ts
│   │   ├── manifest-fetch-policy.test.ts
│   │   ├── pull-worker.test.ts
│   │   ├── reconcile.test.ts
│   │   ├── scan.test.ts
│   │   └── self-write-tracker.test.ts
│   ├── fixtures/
│   │   └── vault/               # Fixture markdown files (e.g. 13-nested/ tree)
│   └── main-error-classifier.test.ts
├── __mocks__/
│   └── obsidian.ts              # Vitest mock of the obsidian module API
├── docs/
│   ├── CONFLICT-MATRIX.md       # Spec: master matrix, sub-matrix, action handlers, edge cases
│   └── MOBILE-QA.md             # Mobile-specific manual QA checklist
├── .planning/
│   └── codebase/                # GSD codebase maps (this directory)
├── manifest.json                # Obsidian plugin manifest (id, name, minAppVersion)
├── package.json                 # npm scripts (dev/build/lint/test), deps
├── tsconfig.json                # TypeScript compiler config
├── vitest.config.ts             # Vitest config (uses __mocks__/obsidian.ts)
├── eslint.config.mts            # ESLint flat config (typescript-eslint + obsidianmd)
├── esbuild.config.mjs           # Bundler config (produces main.js)
├── version-bump.mjs             # Updates manifest.json + versions.json on `npm version`
├── styles.css                   # Plugin CSS (status bar variants, modal styles)
├── main.js                      # Bundler output (committed; what Obsidian loads)
├── README.md
├── CHANGELOG.md
├── SECURITY.md
├── LICENSE
├── manifest.json
└── versions.json                # Min-app-version compatibility map
```

## Directory Purposes

**`src/`:**
- Purpose: All TypeScript source. Bundled into `main.js` by esbuild.
- Contains: One `.ts` file per concern, grouped into subsystems.
- Key files: `main.ts` (plugin entry), `settings.ts` (persisted-data shape), `types.ts` (API wire types).

**`src/sync/`:**
- Purpose: The sync subsystem — engine, reconcile core, pull/push workers, and every helper they need (frontmatter, hashing, exclusion, self-write tracking, conflict emission, rename application, manifest fetch policy, token management).
- Contains: Pure modules (`reconcile`, `exclusion`, `frontmatter`, `hash`, `manifest-fetch-policy`) AND I/O modules (`engine`, `scan`, `pull-worker`, `push-worker`, `rename-local`, `conflict`, `self-write-tracker`, `token-manager`).
- Key files: `engine.ts` (orchestrator), `reconcile.ts` (pure three-view diff), `pull-worker.ts`, `push-worker.ts`, `scan.ts`.

**`src/client/`:**
- Purpose: Network layer. HTTP transport, OAuth auth, typed Vault API.
- Contains: One file per role: `http.ts` (transport), `auth.ts` (device flow), `vault-api.ts` (typed endpoint wrappers).
- Key files: `vault-api.ts` (the only thing the engine talks to).

**`src/ui/`:**
- Purpose: Obsidian UI surfaces. No business logic — every UI module accepts callbacks/state and renders.
- Contains: Settings tab, status bar (desktop), mobile status modal, audit log modal.
- Key files: `settings-tab.ts` (the longest UI module), `status-bar.ts`.

**`src/security/`:**
- Purpose: Startup invariant — refuse to load if a stored token has leaked into the vault.
- Contains: Heuristic and exact-match string detection, vault scan.
- Key files: `vault-token-scan.ts` (scan + classify), `token-shape.ts` (regex + exact-match).

**`src/audit/`:**
- Purpose: Bounded ring-buffer ops. Tiny (~25 LOC).
- Contains: One file: `ring.ts`.

**`tests/`:**
- Purpose: Vitest unit/integration tests. Mirrors `src/` layout.
- Contains: One `.test.ts` per source module that has logic to test (pure modules and workers).
- Note: `__mocks__/obsidian.ts` provides the Obsidian API surface tests need (Vault, App, TFile, etc.).

**`docs/`:**
- Purpose: Reference documentation kept in-tree.
- Key files: `CONFLICT-MATRIX.md` is the authoritative spec for reconcile semantics — keep in sync when reconcile changes. `MOBILE-QA.md` is the manual QA checklist for mobile builds.

**`.planning/codebase/`:**
- Purpose: GSD codebase maps (this directory). Generated/refreshed by `/gsd-map-codebase`.

## Key File Locations

**Entry Points:**
- `src/main.ts`: Plugin entry (`export default class HumaVaultSyncPlugin extends Plugin`).
- `manifest.json`: Obsidian discovers the plugin via this manifest (`id: huma-vault-sync`).

**Configuration:**
- `tsconfig.json`: TypeScript compiler config.
- `vitest.config.ts`: Vitest config — 4 lines of relevant config; uses `__mocks__/obsidian.ts`.
- `esbuild.config.mjs`: Bundler config for `main.js`.
- `eslint.config.mts`: ESLint flat config including `eslint-plugin-obsidianmd`.
- `package.json`: npm scripts (`dev`, `build`, `lint`, `test`, `test:watch`).

**Persisted state:**
- Stored in `data.json` inside the user's `.obsidian/plugins/huma-vault-sync/` directory at runtime. Schema defined in `src/settings.ts:10` (`HumaPluginData`).

**Core sync logic:**
- `src/sync/engine.ts`: One-cycle orchestrator (`SyncEngine.runOnce`).
- `src/sync/reconcile.ts`: Pure three-pass diff. The single most-load-bearing module — see `docs/CONFLICT-MATRIX.md` for the spec.
- `src/sync/pull-worker.ts`, `src/sync/push-worker.ts`: I/O workers.

**API wire types:**
- `src/types.ts`: Manifest entry, push/pull request/response, push response variants (`accept` / `merge_clean` / `merge_dirty`), auth grants, `AuditEvent` union.

**Testing:**
- `tests/sync/reconcile.test.ts` is the verification harness for every row in `docs/CONFLICT-MATRIX.md`. The matrix doc cross-references the test names.

## Naming Conventions

**Files:**
- All TypeScript files use `kebab-case.ts`. Examples: `pull-worker.ts`, `manifest-fetch-policy.ts`, `self-write-tracker.ts`, `audit-log-modal.ts`.
- Test files mirror source paths with `.test.ts` suffix: `tests/sync/reconcile.test.ts` ↔ `src/sync/reconcile.ts`.
- No `index.ts` barrel files — every import names the module directly.

**Directories:**
- All lowercase. Single-word where possible (`audit`, `client`, `security`, `sync`, `ui`).
- No deep nesting; max depth is `src/sync/*.ts` (one level under `src/`).

**Symbols:**
- Classes: `PascalCase` (`SyncEngine`, `VaultApiClient`, `TokenManager`, `SelfWriteTracker`, `HttpError`).
- Functions: `camelCase` (`reconcile`, `runPullWorker`, `runPushWorker`, `scanVault`, `emitConflict`, `processRenameLocal`, `applyRenameToManifest`).
- Constants: `SCREAMING_SNAKE_CASE` (`PULL_BATCH_SIZE`, `PUSH_MAX_RETRIES`, `FULL_FETCH_EVERY`, `HUMA_UUID_KEY`, `CONFLICT_SUFFIX`, `AUDIT_RING_CAPACITY`, `VAULT_DEBOUNCE_MS`).
- Types/Interfaces: `PascalCase`, no `I` prefix (`SyncAction`, `ManifestRecord`, `ManifestEntry`, `ScannedFile`, `EngineState`, `PushOutcome`).
- Tagged unions discriminated on `kind: "literal"` (`SyncAction`, `EngineState`, `PushOutcome.result`, `PullResult` errors). API responses discriminate on `action` (`PushResponse`).

**Field conventions:**
- Wire-format types use `snake_case` field names matching the API contract (`base_version`, `previous_path`, `client_mtime`, `server_body`, `next_cursor`, `server_time`).
- Local types use `camelCase` (`lastSyncedAt`, `lastSince`, `serverBaseUrl`, `excludedFolders`).
- The `huma_uuid` frontmatter key is the only namespaced public-facing identifier; `huma_*` is reserved.

## Where to Add New Code

**New sync action:**
- Add to `SyncAction` union in `src/sync/reconcile.ts`.
- Emit from the appropriate pass (Pass 1 server-known, Pass 2 unknown-uuid, Pass 3 no-uuid) — see ARCHITECTURE.md "Reconcile pipeline".
- Bucket the action in `SyncEngine.runOnce` (`src/sync/engine.ts:122-146`).
- Add a worker (or extend an existing one) to handle it.
- Add a row to `docs/CONFLICT-MATRIX.md`.
- Add a test to `tests/sync/reconcile.test.ts`.

**New API endpoint:**
- Add request/response types to `src/types.ts`.
- Add wrapper method to `VaultApiClient` (`src/client/vault-api.ts`).
- Endpoints currently registered: `MANIFEST_PATH`, `PULL_PATH`, `PUSH_PATH` constants at top of `vault-api.ts`; auth uses `DEVICE_AUTH_PATH`, `TOKEN_PATH` in `client/auth.ts`.

**New audit event:**
- Add to `AuditEvent` union in `src/types.ts:105`.
- Update severity classification in `src/ui/audit-log-modal.ts` so the new event filters correctly.
- Append entries via `pushAudit`/`pushAuditMany` from `src/audit/ring.ts`.

**New engine state variant:**
- Add to `EngineState` union in `src/sync/engine.ts:28`.
- Add the matching `StatusBarState` variant in `src/ui/status-bar.ts:9`.
- Add the corresponding render branch in `HumaVaultSyncPlugin.renderStatusBar` (`src/main.ts:144`).
- Add the mobile equivalent in `src/ui/mobile-status-modal.ts`.

**New setting:**
- Add to `HumaSettings` interface in `src/settings.ts:20` and to `DEFAULT_SETTINGS`.
- Update `mergeData` in `src/main.ts:537` if the migration path needs it (currently spread-merge handles new optional fields).
- Add a `Setting(...)` row to `HumaSettingsTab` in `src/ui/settings-tab.ts`.

**New command:**
- Add to `registerCommands()` in `src/main.ts:417`.
- Command IDs MUST NOT include the plugin id prefix — Obsidian prepends it automatically (final id is `huma-vault-sync:<id>`). UI text uses sentence case.

**New vault op:**
- Use `replaceFileBody` (`src/sync/frontmatter.ts:62`) for atomic body replacement (wraps `vault.process`).
- Use `app.fileManager.renameFile` for moves (so internal links update); see `src/sync/rename-local.ts:40`.
- Always normalize server-supplied paths via `obsidian.normalizePath` before any vault op.
- Always record the post-write hash in `SelfWriteTracker` before initiating the write, to suppress the resulting modify event.

**Shared utilities:**
- Pure helpers go under `src/sync/` if they're sync-related, or stay file-local otherwise. Avoid creating a generic `src/utils/` directory; there isn't one and modules currently keep helpers private.

**Tests:**
- One file per source module: `src/sync/foo.ts` ↔ `tests/sync/foo.test.ts`.
- Use `__mocks__/obsidian.ts` for Obsidian API mocks (tests run under Vitest with `vi.mock("obsidian")` resolving to the manual mock).
- Fixtures live in `tests/fixtures/vault/`.

## Special Directories

**`__mocks__/`:**
- Purpose: Vitest manual mocks. Currently contains `obsidian.ts` mocking the Obsidian plugin API (Vault, App, TFile, requestUrl, normalizePath, etc.).
- Generated: No.
- Committed: Yes.

**`main.js`:**
- Purpose: esbuild bundler output — the file Obsidian actually loads.
- Generated: Yes (`npm run build` or `npm run dev`).
- Committed: Yes (Obsidian plugins ship the bundled artifact).

**`versions.json`:**
- Purpose: Plugin version → minimum Obsidian app version map. Updated automatically by `version-bump.mjs` on `npm version`.
- Generated: Yes (by `version-bump.mjs`).
- Committed: Yes.

**`tests/fixtures/vault/`:**
- Purpose: Fixture markdown files for scan/reconcile tests. `13-nested/` exercises subfolder traversal.
- Generated: No.
- Committed: Yes.

**`.planning/codebase/`:**
- Purpose: GSD codebase maps. Refreshed by `/gsd-map-codebase`.
- Generated: Yes (by mapper agent).
- Committed: Project-dependent.

---

*Structure analysis: 2026-05-01*
