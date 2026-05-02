# Coding Conventions

**Analysis Date:** 2026-05-01

## File Headers (Project-Mandated)

**Five-line file-purpose header.** Every new source file must start with a five-line comment block describing purpose, scope, and primary responsibilities. This rule comes from the user's global `CLAUDE.md` and is load-bearing: the "read first five lines to identify purpose" workflow depends on it.

**Examples in the codebase:**
- `src/sync/hash.ts` lines 1-3 — explains *why* Web Crypto, not `node:crypto` (mobile WebView constraint)
- `src/types.ts` lines 1-2 — flags that the file is transcribed from the API contract and must be regenerated when the schema is published
- `tests/security/no-token-vault-write.test.ts` lines 12-17 — documents the build-time invariant being asserted
- `tests/security/vault-token-scan.test.ts` lines 1-5 — describes regression context (pre-sign-in heuristic)
- `__mocks__/obsidian.ts` lines 1-3 — names the upstream pattern (`addozhang/obsidian-image-upload-toolkit`)

**Header content rule.** Headers must explain *why* the file exists or *what context* it preserves, not restate what the code does. The `simplify` skill's "remove WHAT-comments" guidance applies to inline comments, never to file-purpose headers. If a header has gone stale, update it — never delete it.

## Naming Patterns

**Files:**
- Source: kebab-case `.ts` — `pull-worker.ts`, `vault-token-scan.ts`, `manifest-fetch-policy.ts`, `self-write-tracker.ts`
- Tests: same name as the file under test plus `.test.ts` — `tests/sync/reconcile.test.ts` mirrors `src/sync/reconcile.ts`
- Mocks: directory under `__mocks__/` matching the import name — `__mocks__/obsidian.ts` aliased via `vitest.config.ts`
- UI modules: noun-phrases — `audit-log-modal.ts`, `mobile-status-modal.ts`, `status-bar.ts`, `settings-tab.ts`

**Functions:**
- camelCase, verb-led — `parseFile`, `stringifyFile`, `withHumaUuid`, `readHumaUuid`, `scanVault`, `emitConflict`, `conflictPathFor`, `runPullWorker`, `runDevicePollLoop`, `pushAudit`, `classifyErrorForUser`, `isExcludedPath`, `normalizeExcludedFolders`
- Predicates start with `is`/`has`/`looks` — `isAccessTokenExpired`, `isExcludedPath`, `looksLikeToken`, `hasPath`, `anyMatchesKnownToken`, `isUnrecoverableAuthError`, `isMarkdownTFile`
- Async producers use `run`/`fetch`/`scan` — `runPullWorker`, `runDevicePollLoop`, `scanVaultForTokens`

**Variables:**
- camelCase — `serverManifest`, `localManifest`, `lastSyncedAt`, `cyclesSinceFullFetch`
- API-contract fields snake_case — `access_token`, `refresh_token`, `expires_in`, `huma_uuid`, `previous_path`, `base_version`, `client_mtime`, `deleted_at`, `next_cursor`, `server_time` (these are wire format; never camelCased on the wire)
- Constants UPPER_SNAKE — `HUMA_UUID_KEY`, `CONFLICT_SUFFIX`, `PULL_BATCH_SIZE`, `FULL_FETCH_EVERY`, `PLUGIN_USER_AGENT`, `REVOKE_PATH`, `VAULT_DEBOUNCE_MS`

**Types/Interfaces:**
- PascalCase — `ManifestEntry`, `ManifestRecord`, `ScannedFile`, `PullFile`, `PullResponse`, `PushResponse`, `AuditEntry`, `HumaPluginData`, `StoredTokens`, `EngineState`
- Discriminated unions on `kind` — reconcile actions are `{ kind: "pull", ... } | { kind: "push", ... } | { kind: "rename-local", ... } | { kind: "stale-local-delete", ... } | { kind: "server-deleted", ... } | { kind: "add", ... }`
- Wire enums: `PushResponse.action` is `"accept" | "merge_clean" | "merge_dirty"`
- `AuditEvent` is a string-literal union: `"push_accept" | "push_reject" | "merge_clean" | "merge_dirty" | "path_change" | "pull_apply" | "pull_drop" | "server_deleted" | "duplicate_uuid" | "token_scan_warning" | "auth_error"`

## Code Style

**Formatter:** None configured (no `.prettierrc`, no `biome.json`). The repo relies on `.editorconfig`:
- `indent_style = tab`
- `tab_width = 4`
- `end_of_line = lf`
- `charset = utf-8`
- `insert_final_newline = true`

**Linter:** `eslint.config.mts` (flat config, ESM `.mts`). Run via `npm run lint` (`eslint .`).

**Active rule sets:**
- `typescript-eslint` recommended via `tseslint.config(...)` with `projectService` enabled (`eslint.config.mts:13`). `allowDefaultProject` whitelists `eslint.config.js`, `manifest.json`, `vitest.config.ts`.
- `eslint-plugin-obsidianmd` recommended (`obsidianmd.configs.recommended`) — enforces Obsidian plugin guidelines (no `fetch`, use `requestUrl`; no direct `vault.modify` for body writes; etc.).
- Browser globals everywhere except `tests/**/*.ts` and `vitest.config.ts`, where Node globals are allowed and `import/no-nodejs-modules`/`no-undef` are turned off (`eslint.config.mts:30-39`). The justification is in a header comment: tests run under Node, the obsidianmd rules assume plugin-runtime sandboxing.
- `globalIgnores`: `node_modules`, `dist`, `esbuild.config.mjs`, `eslint.config.js`, `version-bump.mjs`, `versions.json`, `main.js`, `__mocks__`, `tests/fixtures`.

**TypeScript strictness (`tsconfig.json`):**
- `strict: true` plus explicit `noImplicitAny`, `noImplicitThis`, `noImplicitReturns`, `noUncheckedIndexedAccess`, `strictNullChecks`, `strictBindCallApply`, `useUnknownInCatchVariables`
- `target: es2018`, `module: ESNext`, `moduleResolution: node`, `isolatedModules: true`
- `baseUrl: src`, `inlineSourceMap`, `inlineSources`
- `lib: DOM, ES5, ES6, ES7, ES2018`, `types: node, vitest/globals`
- `include`: `src/**/*.ts`, `tests/**/*.ts`, `__mocks__/**/*.ts`

**Build invariant:** `npm run build` runs `tsc -noEmit -skipLibCheck` before esbuild — type errors block production builds even though the actual bundle is produced by esbuild.

## Obsidian-Specific Conventions

These are non-negotiable. They map directly to the `eslint-plugin-obsidianmd` recommended rules and to the Obsidian plugin guidelines.

**HTTP: `requestUrl`, never `fetch`.** All network calls go through `obsidian.requestUrl` (see `src/client/http.ts:1` and `src/client/http.ts:39-65`). `requestUrl` uses Electron `net` on desktop and native HTTP on mobile, so it bypasses CORS preflight and works without `node:fetch`. The `FetchHttpClient` class name is historical — the implementation calls `requestUrl`.

**Body writes: `Vault.process`.** Atomic body replacement is `app.vault.process(file, fn)`, never `vault.modify`. The wrapper `replaceFileBody(app, file, text)` lives in `src/sync/frontmatter.ts:62-68` and is the only way plugin code writes a markdown body. The mock at `__mocks__/obsidian.ts:71-82` mirrors the same semantics so tests cannot accidentally diverge.

**Frontmatter writes: `FileManager.processFrontMatter`.** Frontmatter is mutated through `app.fileManager.processFrontMatter(file, fn)` so user keys and ordering survive. The mock at `__mocks__/obsidian.ts:141-154` uses `gray-matter` (the same prod dep) so the mock's parse/emit semantics match production round-trips.

**Path normalization: `normalizePath`.** Every server-supplied path is run through `obsidian.normalizePath` before any vault op (`src/sync/conflict.ts:38`, `src/sync/pull-worker.ts:1`). The mock at `__mocks__/obsidian.ts:282-290` collapses slashes, strips leading/trailing slashes, replaces non-breaking spaces, and NFC-normalizes — enough behaviour to exercise traversal-defence tests (`tests/sync/conflict.test.ts:32-36`).

**Hashing: Web Crypto, not `node:crypto`.** `src/sync/hash.ts` uses `crypto.subtle.digest("SHA-256", ...)` because Obsidian's iOS/Android targets are Capacitor WebViews where `node:crypto` is not exposed. Never reach for `node:crypto` in `src/`.

**The parsed-back-body hash invariant.** This is load-bearing. SHA-256 must always be computed over `parseFile(stringifyFile(body, fm)).body` — never over the raw `body` returned by the server. Background:

- `gray-matter` round-trip is not byte-identical: empty body becomes `"\n"`, multi-line bodies may pick up a trailing newline, etc.
- If the pull worker hashes the raw server body but on-disk content is the round-tripped form, the next scan computes a different hash, reconcile flags the file as locally-edited, and the plugin push-loops every cycle.
- The fix (commit `0685a8b`) is to hash what was actually written: `await sha256Hex(parseFile(text).body)` after `text = stringifyFile(body, fm)`.
- Sites enforcing this: `src/sync/conflict.ts:48-51` (pre-write conflict emission), `src/sync/pull-worker.ts` (per-pull writes).
- The invariant is locked down by `tests/sync/frontmatter.test.ts:70-81` ("hash of parsed-back body is stable across stringify round-trip even when body is empty") and reinforced by `tests/sync/scan.test.ts:70-76` ("hash stays stable across two scan passes of the same content").

**Write-self-tracking.** Plugin-initiated writes are recorded by hash+path on `SelfWriteTracker` (`src/sync/self-write-tracker.ts`) so the modify-event handler can ignore them. Path × body-hash, 30 s TTL, periodic prune — this is how the plugin avoids inducing a sync loop on its own writes. Hashes recorded in the tracker MUST match the on-disk hash, which means they MUST also follow the parsed-back-body invariant.

**No tokens to vault, ever.** The build-time invariant in `tests/security/no-token-vault-write.test.ts` greps every function body in `src/` for the adjacency of a vault-write API call (`vault.modify`, `vault.create`, `vault.createFolder`, `vault.append`) and a token reference (`access_token`, `refresh_token`, `storedToken`/`storedTokens`, `bearer`). Adjacency = same function body. Override with the line comment `// SAFE-TOKEN-WRITE: <reason>` only when the false positive is unambiguous.

**`huma_*` frontmatter is namespaced.** The plugin reads/writes `huma_uuid` only. User keys are preserved untouched. `withHumaUuid` (`src/sync/frontmatter.ts:47-58`) returns a new object that places `huma_uuid` last while preserving every other key in original order — this is what `tests/sync/frontmatter.test.ts:34-47` locks down.

**`stringifyFile` skips empty YAML.** `gray-matter.stringify({}, body)` emits a noisy empty `---\n---\n` block. The wrapper at `src/sync/frontmatter.ts:26-36` returns the body verbatim when frontmatter is `{}`. Test: `tests/sync/frontmatter.test.ts:29-32`.

## Import Organization

**Order observed:**
1. External packages (alphabetical) — `gray-matter`, `obsidian`, `diff-match-patch`
2. Type-only imports from `obsidian` are inlined with `import type` or `type` qualifiers (e.g. `import { normalizePath, type App, type TFile } from "obsidian";` — `src/sync/conflict.ts:1`)
3. Relative imports from `../` then `./` — settings/types first, then sibling modules

**Path aliases:** None. `tsconfig.json` sets `baseUrl: src` but nothing imports via that base — every source file uses relative paths (`./frontmatter`, `../client/http`).

**Test imports:**
- Vitest API: `import { describe, expect, it } from "vitest";` (sometimes `vi`, `beforeEach`, `afterEach`)
- Source under test: `from "../../src/sync/X"` (two-level relative)
- Obsidian mock: `from "../../__mocks__/obsidian"` for utilities (`createMockApp`, `MockVault`, `MockApp`, `TFile`)
- Source modules that import `from "obsidian"` resolve to the mock automatically via the `vitest.config.ts` alias

## Error Handling

**Strategy:** typed errors plus `useUnknownInCatchVariables`. `HttpError` (`src/client/http.ts:4-18`) carries `status`, `body`, and `apiError` (typed `ApiError | null`). Callers narrow on instanceof and on `apiError.error` string codes.

**User-facing classification:** `classifyErrorForUser` (re-exported from `src/main.ts`) maps:
- HTTP 401 → "sign in again"
- `apiError.error` ∈ {`invalid_token`, `refresh_token_reused`, `invalid_grant`} → "sign in again"
- HTTP 5xx → "server error"
- `TypeError` whose message contains `fetch` → "server unreachable"
- Fallback → `Huma sync failed: <message>`

Tests at `tests/main-error-classifier.test.ts` lock these mappings.

**Pull-worker not_found peeling:** `404 { error: "not_found", id }` is not a generic error. The worker drops the named id from the local manifest and retries the rest of the batch; bounded at `batch.length + 1` retries. A `not_found` whose id is *not* in the batch falls through to generic error handling (`tests/sync/pull-worker.test.ts:101-126`).

**Auth-poll outcomes:** `runDevicePollLoop` returns `{ kind }` discriminated unions: `tokens`, `slow_down`, `denied`, `expired`, `aborted`, `pending`. `slow_down` adds 5 s to the next sleep (`tests/client/auth.test.ts:74-93`). Abort-signal honoured.

## Logging

**No logger framework.** Diagnostics route through:
- `Notice` (Obsidian's built-in toast, mocked at `__mocks__/obsidian.ts:254-256`) for user-visible messages
- The 200-entry audit ring (`src/audit/ring.ts`) for sync events — `pushAudit(ring, entry, capacity?)` and `pushAuditMany(ring, entries, capacity?)`. Default capacity 200; oldest evicted (`tests/audit/ring.test.ts:30-35`)

`console.*` calls in source are sparse and typically tagged for diagnostic-only paths — do not add general logging.

## Comments

**When comments are required:**
- Five-line file-purpose header (above) — mandatory for new files
- *Why* a non-obvious approach was chosen: e.g. the `gray-matter` round-trip note in `__mocks__/obsidian.ts:133-135`, the `node:crypto` rationale in `src/sync/hash.ts:1-3`, the `requestUrl` justification in `src/client/http.ts:39-41`
- Regression context: live-repro narrative tied to a CHANGELOG entry — see `tests/sync/reconcile.test.ts:231-236` ("Live repro: AnotherTest.md was created+pushed...")
- Cross-references to spec rows: `tests/sync/reconcile.test.ts` uses "master row #N" headings keyed to the conflict matrix in `docs/CONFLICT-MATRIX.md`

**When comments are NOT required:**
- Inline WHAT-comments inside function bodies (the `simplify` skill removes these)
- JSDoc/TSDoc for exported APIs — TypeScript signatures carry the contract; an explanatory line comment above the function is preferred when motivation matters

## Function Design

**Size:** Functions stay focused. The longest production function is the engine cycle in `src/sync/engine.ts`; reconcile passes are split out (`reconcile.ts` returns a deterministic action list).

**Parameters:**
- Named-options objects when there are 3+ args or boolean flags. See `runDevicePollLoop({ sessionId, intervalSeconds, expiresInSeconds, sleep, poll, signal? })` in `src/client/auth.ts`.
- Positional args when there are 2-3 unambiguous required values: `pushAudit(ring, entry, capacity?)`, `sha256Hex(text)`, `isExcludedPath(path, excludedFolders)`.

**Return values:**
- Discriminated unions for multi-outcome operations — `DevicePollOutcome`, `PushResponse`, reconcile actions
- Result records (`PullResult`, `PushResult`) bundle multiple per-batch outputs (`updatedManifest`, `written`, `errors`, `dropped`, `audit`)
- `null` for "absent" sentinel (`readHumaUuid` returns `string | null`); never `undefined` for absence in domain code

**Determinism:** Reconcile is deterministic — same inputs produce identical action ids across runs (`tests/sync/reconcile.test.ts:377-386`). Action ids encode `<kind>:<id-or-path>` so a crashed cycle resumes cleanly.

## Module Design

**Exports:**
- Named exports only. No default exports except `src/main.ts` (`export default class HumaVaultSyncPlugin extends Plugin` — required by Obsidian).
- Constants exported alongside their consumers (`HUMA_UUID_KEY`, `CONFLICT_SUFFIX`, `PULL_BATCH_SIZE`, `FULL_FETCH_EVERY`).

**Barrel files:** None. Every import targets a specific file.

**Re-exports:** Sparse — `src/sync/token-manager.ts` exports `isUnrecoverableAuthError` directly; `src/main.ts` imports it explicitly.

## Test-Driven Patterns

- Tests assert behaviour at the boundary types (`reconcile.ts` accepts `serverManifest`, `localManifest`, `scanned` — see `tests/sync/reconcile.test.ts:7-39` for the canonical builder helpers).
- Local fixture builders (`serverEntry`, `localRecord`, `scanned`, `pullFile`, `manifestRow`, `entry`) live inline in each test file. Each helper takes `Partial<T>` and spreads sensible defaults. This is the standard pattern; new tests should follow it rather than introducing a shared factory.

---

*Convention analysis: 2026-05-01*
