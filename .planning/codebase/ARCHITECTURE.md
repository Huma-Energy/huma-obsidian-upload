<!-- refreshed: 2026-05-01 -->
# Architecture

**Analysis Date:** 2026-05-01

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────┐
│                       Obsidian Plugin Host                            │
│  Vault events │ Workspace │ Status bar │ Ribbon │ Command palette   │
└──────────┬───────────────────────────────────────────────┬──────────┘
           │ vault.on('modify'/'create'/'delete'/'rename') │ commands
           ▼                                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        Plugin shell — `src/main.ts`                   │
│  - Wires clients, engine, UI                                          │
│  - Owns `HumaPluginData` (settings, tokens, manifest, lastSince,      │
│    auditRing) persisted via Obsidian `loadData`/`saveData`            │
│  - Debounced vault-event sync trigger + interval poll (desktop only)  │
│  - Startup invariant: vault token scan refuses load on stored leak    │
└──┬────────────┬──────────────────────────────────────────┬──────────┘
   │            │                                          │
   ▼            ▼                                          ▼
┌──────────┐  ┌─────────────────────────┐  ┌───────────────────────────┐
│   UI     │  │     Sync subsystem       │  │   HTTP / Auth clients     │
│ `src/ui/`│  │     `src/sync/`          │  │   `src/client/`           │
│          │  │                          │  │                           │
│ status-  │  │  SyncEngine ──┐          │  │  FetchHttpClient          │
│  bar     │  │   ├─ scanVault│          │  │   (wraps obsidian         │
│ settings-│  │   ├─ reconcile│          │  │    `requestUrl`)          │
│  tab     │  │   ├─ rename-  │          │  │                           │
│ audit-   │  │   │   local   │          │  │  AuthClient (device flow) │
│  log     │  │   ├─ pull-    │          │  │                           │
│  modal   │  │   │   worker  ├──────────┼──▶ VaultApiClient            │
│ mobile-  │  │   └─ push-    │          │  │   (manifest/pull/push)    │
│  status  │  │       worker  │          │  │                           │
└──────────┘  │  manifest-fetch-policy   │  │  TokenManager             │
              │  conflict / frontmatter  │  │   (refresh, AuthSource)   │
              │  hash / exclusion        │  └─────────────┬─────────────┘
              │  self-write-tracker      │                │
              └────────┬─────────────────┘                │
                       │                                  ▼
                       ▼                       ┌──────────────────────┐
              ┌──────────────────┐             │  Huma Vault API      │
              │ Obsidian Vault   │             │  /api/vault/auth/*   │
              │ (markdown files, │             │  /api/vault/manifest │
              │  frontmatter,    │             │  /api/vault/pull     │
              │  data.json)      │             │  /api/vault/push     │
              └──────────────────┘             └──────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| `HumaVaultSyncPlugin` | Plugin lifecycle, vault event wiring, command registration, persisted-data accessor, startup token-leak invariant, polling | `src/main.ts` |
| `SyncEngine` | One-cycle orchestrator: full-or-delta manifest fetch, scan, reconcile, dispatch to workers, audit + manifest persistence, state callbacks | `src/sync/engine.ts` |
| `reconcile` | Pure function: three-view diff (server × local manifest × scan) → ordered `SyncAction[]` + duplicate-uuid set | `src/sync/reconcile.ts` |
| `scanVault` | Walks markdown files, parses frontmatter, hashes body, returns `ScannedFile[]` (excludes `.conflict.md` and excluded folders) | `src/sync/scan.ts` |
| `runPullWorker` | Batched pull (50/req), writes files, drops `not_found` ids, incremental manifest flush per batch | `src/sync/pull-worker.ts` |
| `runPushWorker` | Serial push with retry+backoff, applies `accept`/`merge_clean`/`merge_dirty`, manifest flush every 25 outcomes | `src/sync/push-worker.ts` |
| `processRenameLocal` / `applyRenameToManifest` | Server→local file moves via `app.fileManager.renameFile`, manifest path update | `src/sync/rename-local.ts` |
| `manifest-fetch-policy` | Cold-start full fetch + every-N re-baseline (delta-sync drift guard) | `src/sync/manifest-fetch-policy.ts` |
| `emitConflict` / `listConflictFiles` / `conflictPathFor` | Sibling `.conflict.md` writer with git-style markers | `src/sync/conflict.ts` |
| `SelfWriteTracker` | Suppresses vault `modify` events caused by the plugin's own writes (path × body-hash, 30s TTL) | `src/sync/self-write-tracker.ts` |
| `parseFile` / `stringifyFile` / `withHumaUuid` / `replaceFileBody` | gray-matter-based frontmatter split / merge, atomic body replace via `Vault.process` | `src/sync/frontmatter.ts` |
| `sha256Hex` | Web Crypto SHA-256 (works on desktop + mobile WebView) | `src/sync/hash.ts` |
| `isExcludedPath` / `normalizeExcludedFolders` | Folder-prefix exclusion shared by scan and reconcile | `src/sync/exclusion.ts` |
| `TokenManager` | OAuth access-token cache + refresh; clears tokens on unrecoverable refresh failure; implements `AuthSource` for `VaultApiClient` | `src/sync/token-manager.ts` |
| `FetchHttpClient` / `HttpError` | JSON HTTP wrapper around obsidian `requestUrl`; typed `ApiError` extraction | `src/client/http.ts` |
| `AuthClient` / `runDevicePollLoop` | OAuth device-code flow + polling with `slow_down` backoff | `src/client/auth.ts` |
| `VaultApiClient` | Typed wrappers for `/api/vault/manifest|pull|push` endpoints | `src/client/vault-api.ts` |
| `scanVaultForTokens` / `findTokenShapedStrings` | Startup invariant: blocks load if a stored token appears in any vault file; non-blocking warning for token-shaped strings | `src/security/vault-token-scan.ts`, `src/security/token-shape.ts` |
| `pushAudit` / `pushAuditMany` | Append-with-eviction ring buffer, capacity 200 | `src/audit/ring.ts` |
| Status bar / settings tab / audit log modal / mobile modal | UI surfaces for engine state, sign-in, settings, audit ring | `src/ui/*.ts` |

## Pattern Overview

**Overall:** Layered, single-cycle orchestration. Pure-function diff + side-effect workers, with the engine as the only mutable coordinator.

**Key Characteristics:**
- **Pure reconcile core.** `reconcile()` is a pure function over three immutable inputs (server manifest, local manifest, vault scan). All side effects (network, vault writes, manifest persistence, audit appends) happen above it in `SyncEngine`.
- **Three-view convergence.** Every cycle reconciles three views per UUID: server manifest entry, local manifest record, and on-disk scanned file. The action list is a deterministic function of the view tuple.
- **Server is authoritative for path and version; local is authoritative for body edits.** Three-way merge happens server-side and is communicated back via the `merge_clean` / `merge_dirty` push-response variants.
- **Delta-mode safety net via synthetic server entries** (see "Reconcile pipeline" below). A locally-tracked UUID that the delta `?since=` query omits is synthesised back into reconcile's effective server view from the local manifest's last-known state — preserves Pass 1 semantics for unchanged-on-server-but-changed-locally files.
- **Self-write event suppression.** Every plugin-initiated vault write is recorded in `SelfWriteTracker` (path × post-write body hash) so the resulting `vault.on('modify')` doesn't trigger another sync cycle.
- **Incremental persistence inside a cycle.** `pullWorker` flushes the manifest after each batch; `pushWorker` flushes every 25 outcomes plus end-of-run. A mid-cycle crash preserves work already done.
- **Coalesced runs.** `SyncEngine.runSync` returns the inflight promise on re-entry, so concurrent triggers (interval + vault event) collapse to one cycle. Per-action atomicity is required, not per-cycle isolation.
- **Append-with-eviction audit log** in `data.json` (capacity 200), surfaced via the audit modal — the only user-visible debugging trail.

## Layers

**Plugin shell (`src/main.ts`):**
- Purpose: Obsidian lifecycle adapter — owns the persisted blob, instantiates clients/engine, registers commands and vault hooks, drives status bar.
- Depends on: every other layer.
- Used by: Obsidian.

**UI (`src/ui/*.ts`):**
- Purpose: Settings tab, status bar, audit log modal, mobile status modal.
- Depends on: settings types, EngineState, audit types.
- Used by: Plugin shell only.

**Sync subsystem (`src/sync/*.ts`):**
- Purpose: Engine, reconcile core, workers, conflict/rename/scan/exclusion/hash/frontmatter helpers, manifest fetch policy, token manager, self-write tracker.
- Depends on: client layer, settings/types.
- Used by: Plugin shell.

**Client layer (`src/client/*.ts`):**
- Purpose: HTTP transport, OAuth device flow, typed Vault API wrapper.
- Depends on: types only.
- Used by: Sync subsystem (`SyncEngine`, `TokenManager`).

**Security (`src/security/*.ts`):**
- Purpose: Vault token-leak scan invariant, token-shape heuristic.
- Depends on: nothing inside the project.
- Used by: Plugin shell startup only.

**Audit (`src/audit/ring.ts`):**
- Purpose: Bounded ring buffer ops on the persisted audit array.
- Depends on: types only.
- Used by: Plugin shell, sync engine.

## Data Flow

### Reconcile pipeline (the canonical sync cycle)

End-to-end, one cycle of `SyncEngine.runSync`:

1. **State callback** — `callbacks.onState({ kind: "syncing", pending: 0 })` (`engine.ts:101`).

2. **Manifest fetch policy decides full-vs-delta** (`engine.ts:109-111`).
   - `shouldFullFetch(state)` returns true if `firstCycle` (cold start since plugin load) OR `cyclesSinceFullFetch >= FULL_FETCH_EVERY` (re-baseline every 20 cycles, ~10 min at 30s interval). See `manifest-fetch-policy.ts:28`.
   - Full fetch ⇒ `since = null`. Delta fetch ⇒ `since = data.lastSince`.

3. **Fetch the entire server manifest** (`engine.ts:306-323`): paginated GET `/api/vault/manifest?since=&cursor=`, accumulating until `next_cursor` is null. Records `serverTime` for the next `lastSince`.

4. **Vault scan** (`scan.ts:34`): `app.vault.getMarkdownFiles()` → filter `.conflict.md` and excluded folders → for each, `cachedRead` + `parseFile` + `sha256Hex(body)` → `ScannedFile[]`.

5. **Reconcile** (`reconcile.ts:101`) is the heart of the cycle. It executes three sequential passes after a duplicate-UUID detection step:

   **Step A — exclusion filtering.** All three views (`serverManifest`, `localManifest`, `scanned`) are filtered through `isExcludedPath` so reconcile never sees excluded files (`reconcile.ts:108-116`).

   **Step B — duplicate huma_uuid detection.** Scanned files are bucketed by UUID. A UUID with >1 scanned file is a corruption case (e.g. user copy-pasted a synced note). Both/all files for that UUID are removed from the by-UUID lookup and surfaced in `duplicateUuids[]`. Reconcile refuses to push, pull, or rename for these UUIDs — pushing the "winner" would tell the server to rename the original (still on disk) and the next pull could clobber content the user still has locally (`reconcile.ts:129-153`).

   **Step C — synthetic-server-entry promotion (recent change).** Build `serverByIdEffective`: start from the delta-mode `serverById`, then for every locally-tracked UUID the delta omitted, synthesise a `ManifestEntry` from the local manifest's last-known state with `deleted_at: null` (`reconcile.ts:172-184`). Rationale documented inline:
   > The omission means the server hasn't changed that row since `lastSince`, so its last-known state is exactly what local manifest stores. Without this, a file the user has edited or renamed since the last sync would never reconcile when delta mode hides its server row — Pass 1 would skip it (not in delta) and Pass 2 would skip it (locally-known UUID per the dedupe protection). The synthetic entry routes those cases through Pass 1's existing rename / edit / stale-delete branches.

   **Pass 1 — iterate every server-known UUID** (`serverByIdEffective.values()`, `reconcile.ts:187-315`). For each `serverEntry`:
   - Skip non-tombstoned entries whose UUID is in `duplicateUuidSet` (tombstones still drop normally).
   - If `deleted_at !== null` → emit `server-deleted` (drops manifest row at end-of-cycle; vault file untouched).
   - Else if no scanned file with this UUID:
     - If local manifest has it → emit `stale-local-delete` (informational; v1.1 will push a delete).
     - Else → emit `pull` (server has it, plugin has never seen it).
   - Else compute three booleans: `localHashMatchesManifest`, `localEdited`, `serverNewer`. Detect server-side rename (`serverEntry.path !== local.path && scanned.path === local.path`) → emit `rename-local` (and use server's path as the logical path for any subsequent action this iteration).
   - Branches:
     - `serverNewer && !localEdited` → clean `pull`.
     - `serverNewer && localEdited` → `push` (server-side three-way merge will resolve), `conflictCount++`.
     - `localEdited` only → `push`.
     - No edits, no `serverRenamed`, but `local.path !== scanned.path` → plugin-side rename `push` with `previousPath = local.path`.
     - Otherwise → in-sync, no action.

   **Pass 2 — scanned files with a huma_uuid the server doesn't know AND the local manifest doesn't know** (`reconcile.ts:329-339`). True first-push-with-UUID cases: bulk-import wrote the UUID before the server registered it, or stale UUID frontmatter from a deleted-then-recreated file. Emit `push` with `serverId: null` so the server allocates or recognises.
   - **CRITICAL guard** on this pass: skip UUIDs in `localById` (not just `serverById`). Without this guard, every cycle in delta mode would re-push every previously-synced file as a "first push" because delta omits unchanged rows.

   **Pass 3 — scanned files with no UUID at all** (`reconcile.ts:342-348`). Emit `add` (push with `serverId: null`); server mints a UUID.

   **Action ordering** (`reconcile.ts:352-359`):
   ```
   server-deletes → rename-local → pulls → pushes → adds → stale-local-deletes
   ```
   Rename-local runs ahead of pulls so a same-cycle pull writes the body at the post-rename path. Pulls run ahead of pushes so the local manifest is up-to-date before any push uses `base_version`. Pushes run ahead of adds so existing-file edits propagate before brand-new files compete for the same path.

6. **State callback** with action count (`engine.ts:120`).

7. **Engine bucketing** (`engine.ts:122-146`). Walks `actions[]` once and routes into:
   - `renameLocals: RenameLocalAction[]`
   - `pullIds: string[]`
   - `pushInputs: PushAttemptInput[]` — joined with `scannedByPath` and `localById` lookups so the worker has all three views per action.

8. **Process renames-local first** (`engine.ts:154-170`). Sequential `processRenameLocal` calls invoke `app.fileManager.renameFile` (which updates internal `[[wikilinks]]`/`![[embeds]]` across the vault). On success, `applyRenameToManifest` mutates the working manifest snapshot in place, and a `path_change` audit entry is recorded. Manifest is flushed once after the rename batch.

9. **Pull worker** (`engine.ts:172-184` → `pull-worker.ts:61`). Batches of 50 ids per `POST /api/vault/pull`. Per batch:
   - Per-batch retry loop: server returns 404 `not_found` with the offending id when any one id is unknown. Worker drops that id from the manifest, records a `PullDropEntry`, and re-issues with the survivors. Loop capped at `batch.length + 1` so a misbehaving server can't spin forever.
   - For each returned `PullFile`: `writePulledFile` normalizes path, merges `huma_uuid` into frontmatter, computes hash on the parsed-back body (NOT raw `file.body` — gray-matter empty-body roundtrip emits a trailing `\n` that would otherwise drift), records the post-write hash in `SelfWriteTracker`, replaces (or creates) the file via `Vault.process`/`vault.create`, and updates the manifest.
   - `onManifestUpdate` flush after every batch.

10. **Push worker** (`engine.ts:186-199` → `push-worker.ts:62`). Serial. For each `PushAttemptInput`:
    - `pushOne`: try up to `PUSH_MAX_RETRIES = 3` with exponential backoff (500ms, 1s) on transient errors before marking `deferred` (deferred actions appear on the next cycle).
    - On success, `applyResponse` switches on `response.action`:
      - `accept` → `ensureUuidInVault` (atomic frontmatter write of `huma_uuid` if needed, body untouched), then update manifest record with returned version + body hash.
      - `merge_clean` → write server-merged body via `replaceFileBody`, hash on parsed-back body, manifest gets server's `version`.
      - `merge_dirty` → `emitConflict` writes `<basename>.conflict.md` sibling with git-style markers AND replaces the original with server's body (both writes recorded in `SelfWriteTracker`); manifest gets `server_version`.
    - Manifest flush every `PUSH_MANIFEST_FLUSH_EVERY = 25` outcomes plus end-of-run.

11. **Tombstone drop** (`engine.ts:204-223`). After workers, drop manifest rows whose server entry has `deleted_at !== null`; emit `server_deleted` audit per dropped row.

12. **Audit + manifest + lastSince persistence** (`engine.ts:255-264`). One final `saveManifest`, append all collected audit entries, save `serverManifest.serverTime` as the new `lastSince`. **Only on full success**, advance `fetchPolicyState` (`firstCycle: false`, increment-or-reset `cyclesSinceFullFetch`) — errors thrown above skip this advance, so a retry preserves the cold-start full-fetch guarantee.

13. **State callback** — `idle` if no conflicts/stale/duplicates; `conflict` (with counts) otherwise (`engine.ts:266-282`).

### Sign-in path

1. User runs "Sign in" command (`main.ts:427`) → `signIn()` (`main.ts:234`).
2. `AuthClient.startDeviceFlow` → `POST /api/vault/auth/device` → `verification_uri_complete` opened in browser, user code shown in Notice.
3. `runDevicePollLoop` polls `POST /api/vault/auth/token` every `interval` seconds with `slow_down` backoff and absolute `expires_in` deadline (`auth.ts:128-153`).
4. On `tokens` outcome → store in `data.tokens` → `runFullSync()` → `startPolling()`.

### Token refresh path (mid-sync)

1. `VaultApiClient` calls `await this.auth.getAccessToken()` before each request.
2. `TokenManager.ensureFresh`: returns cached token if not expired; otherwise calls `auth.refresh(refresh_token)` and replaces both tokens atomically (rotation per API contract).
3. Concurrent callers share one inflight refresh promise.
4. On unrecoverable error codes (`refresh_token_reused`, `token_reused`, `invalid_grant`, `invalid_token`), `setTokens(null)` clears storage. Plugin shell catches via `isUnrecoverableAuthError`, logs `auth_error` audit, stops polling, renders signed-out.

### Vault event → debounced sync

1. Vault `modify`/`create`/`delete`/`rename` event fires (`main.ts:370-393`).
2. For `modify` only: `handleModifyEvent` checks `selfWriteTracker.hasPath(f.path)` cheaply; if a write is pending, hashes the file and tries `tracker.consume(path, hash)` — match ⇒ swallow the event (it's our own write).
3. Otherwise call `engine.scheduleDebouncedSync(VAULT_DEBOUNCE_MS = 5000)`. Subsequent events within the window collapse to a single cycle.
4. Mobile uses `active-leaf-change` (foreground resume) instead of an interval poll.

**State Management:**
- All persisted state lives in `data.json` via `loadData`/`saveData`: settings, tokens, manifest (array of `ManifestRecord`), audit ring, `lastSince`.
- In-memory only: `SyncEngine.fetchPolicyState`, `SyncEngine.inflight`, `SelfWriteTracker.entries`, plugin's `currentState` and `lastSyncedAt`.
- Plugin reload always resets `fetchPolicyState` to `firstCycle: true`, which is the recovery path: a stale `lastSince` persisted across sign-out cannot mask backfilled rows on the next session because the first cycle always full-fetches.

## Key Abstractions

**`SyncAction` (`src/sync/reconcile.ts:6`):**
- Tagged union: `add | pull | push | rename-local | stale-local-delete | server-deleted`.
- Each carries a stable `id` (`actionId(kind, key)`) so replaying reconcile after a partial-failure crash produces the same ids for the same residual work.
- Engine and workers exclusively consume this type; reconcile is the sole producer.

**`ManifestRecord` (`src/settings.ts:32`) vs `ManifestEntry` (`src/types.ts:48`):**
- `ManifestRecord` is the local-side row in `data.json`: `{id, path, version, hash, lastSyncedAt}`.
- `ManifestEntry` is the wire-format row from `/api/vault/manifest`: `{id, path, version, hash, deleted_at}`.
- Reconcile compares them; engine writes only `ManifestRecord`s.

**`ScannedFile` (`src/sync/scan.ts:7`):**
- `{uuid: string | null, path, hash, body, frontmatter, mtime}`. Read once per cycle, passed by reference into reconcile and the push worker.

**`PushOutcome.result` (`src/sync/push-worker.ts:32`):**
- Tagged union over the four real push outcomes: `accept | merge_clean | merge_dirty | deferred`. The first three carry the new manifest record; `deferred` carries an error string for retry on the next cycle.

**`EngineState` (`src/sync/engine.ts:28`):**
- Tagged union over states the UI cares about: `idle | syncing | error | conflict`. Plugin shell maps this to status-bar render variants.

**`AuditEvent` (`src/types.ts:105`):**
- Closed enum of every event the audit ring records. New event kinds require both this union and `audit-log-modal.ts` filter classification updates.

**`SelfWriteTracker` (`src/sync/self-write-tracker.ts:14`):**
- Path-keyed multimap of expected `(hash, expiresAt)` pairs. Each `record()` is consumed at most once. 30s TTL with periodic prune (registered in `main.ts:84`).

## Entry Points

**Plugin lifecycle (`onload` / `onunload`):**
- Location: `src/main.ts:44-92`.
- Triggers: Obsidian.
- Responsibilities: load data, build clients, attach status bar (desktop) or ribbon (mobile), register settings tab, register commands, register vault hooks (deferred to `onLayoutReady`), schedule self-write-tracker prune interval, run startup invariant.

**Vault event hooks (`registerVaultEventHooks`):**
- Location: `src/main.ts:370-393`.
- Triggers: `vault.on('modify'|'create'|'delete'|'rename')`, plus `workspace.on('active-leaf-change')` on mobile for foreground-resume.
- Responsibilities: debounce-schedule a sync cycle, with self-write filtering on `modify`.

**Commands (`registerCommands`):**
- Location: `src/main.ts:417-472`.
- Command IDs (Obsidian prepends `huma-vault-sync:`): `sync-now`, `sign-in`, `sign-out`, `resolve-conflicts`, `show-sync-log`, `reset-local-state`.

**Interval poll:**
- Location: `src/main.ts:344-356`.
- Triggers: `window.setInterval(syncIntervalSeconds * 1000)` after a successful sign-in. Disabled on mobile.

## Architectural Constraints

- **Single-threaded JS event loop.** All sync work runs on the renderer thread. No worker threads, no transferables.
- **`SyncEngine.runSync` self-coalesces.** Re-entry returns the inflight promise; concurrent triggers (interval + vault event + manual command) collapse to one cycle.
- **`TokenManager` self-coalesces refreshes.** Concurrent `getAccessToken` callers during expiry share one inflight `auth.refresh` call.
- **Module-level singletons:** `HUMA_UUID_KEY = "huma_uuid"` (`frontmatter.ts:4`), `CONFLICT_SUFFIX = ".conflict.md"` (`conflict.ts:11`), `AUDIT_RING_CAPACITY = 200` (`ring.ts:3`), `FULL_FETCH_EVERY = 20` (`manifest-fetch-policy.ts:22`), `PULL_BATCH_SIZE = 50` (`pull-worker.ts:15`), `PUSH_MAX_RETRIES = 3`, `PUSH_INITIAL_BACKOFF_MS = 500`, `PUSH_MANIFEST_FLUSH_EVERY = 25` (`push-worker.ts:18-23`), `VAULT_DEBOUNCE_MS = 5_000` (`main.ts:28`), `DEFAULT_TTL_MS = 30_000` (`self-write-tracker.ts:7`).
- **No `node:crypto`.** `sync/hash.ts` uses Web Crypto `subtle.digest` because Obsidian mobile is a Capacitor WebView where Node primitives are unavailable.
- **No raw `fetch`.** All HTTP goes through `requestUrl` (`client/http.ts:57`) — required by Obsidian plugin guidelines to avoid CORS preflight and to work uniformly on desktop Electron + mobile WebView.
- **No `vault.modify` direct calls.** Body-replacement uses `app.vault.process` (atomic, race-safe) via `replaceFileBody` (`frontmatter.ts:62`).
- **No `vault.rename` for moves.** Server-side renames use `app.fileManager.renameFile` so internal links update across the vault (`rename-local.ts:40`).
- **Path normalization is mandatory** for every server-supplied path before any vault op (`pull-worker.ts:178`, `conflict.ts:38`).
- **Status bar items are desktop-only** per Obsidian docs; mobile uses a ribbon icon + state modal (`main.ts:49-66`).
- **Vault hooks register inside `onLayoutReady`** (`main.ts:75`) — registering earlier would falsely scheduled a sync per file because Obsidian fires `create` for every existing file at cold start.
- **No concurrent renames-to-different-paths handling.** Documented as out-of-scope/lossy in `docs/CONFLICT-MATRIX.md` "Out of scope".

## Anti-Patterns

### Re-pushing every locally-known file in delta mode

**What happens:** Pass 2 of reconcile (scanned files with a UUID neither side knows) without the `localById.has(uuid)` guard would emit a push for every locally-synced file every cycle, because the delta-mode server manifest only returns rows changed inside the `since` window — locally-known files the user hasn't touched fall outside the window and are therefore absent from `serverById`.
**Why it's wrong:** Wastes bandwidth, server CPU, and could cause spurious version churn on the server side.
**Do this instead:** Always check both `serverById.has(uuid)` AND `localById.has(uuid)` before treating a scanned UUID as a first-push (`reconcile.ts:330-331`). The "synthetic server entry" mechanism (Step C above) routes locally-known-but-server-unchanged files through Pass 1 instead.

### Hashing raw server body instead of parsed-back body

**What happens:** Storing `sha256Hex(file.body)` in the manifest after a pull, where `file.body` is the raw server-provided string.
**Why it's wrong:** gray-matter's empty-body roundtrip emits a trailing `\n` that the next `scanVault` parses back. Storing the raw-body hash makes the next scan falsely flag the file as locally-edited every cycle, producing an infinite push loop on backfilled empty-body docs.
**Do this instead:** Always hash `parseFile(stringifiedText).body` — the body that subsequent scans will actually see (`pull-worker.ts:184-187`, `push-worker.ts:184-188`, `conflict.ts:48-51`).

### Triggering on every vault `modify` event

**What happens:** Calling `engine.scheduleDebouncedSync()` on every modify event without filtering.
**Why it's wrong:** Plugin's own writes (pull, merge_clean, merge_dirty original-replace, conflict file write, frontmatter UUID injection) all fire `modify` events. Without filtering, every sync cycle would trigger another sync cycle.
**Do this instead:** Use `SelfWriteTracker.record(path, hash)` immediately before every plugin-initiated write, and check `tracker.consume(path, hash)` in the modify handler (`main.ts:395-415`). Only `modify` needs hash-checking; other events go straight to debounce.

### Skipping rename-local ordering

**What happens:** Emitting pulls and pushes before rename-local actions, or interleaving them.
**Why it's wrong:** A same-cycle pull on a server-renamed file would write the body at the OLD path; the rename-local would then move an empty file (or fail).
**Do this instead:** Order is fixed in reconcile output: `server-deletes → rename-local → pulls → pushes → adds → stale-local-deletes` (`reconcile.ts:352-359`). Engine processes renames first (`engine.ts:154-170`), then pulls, then pushes.

### Acting on duplicate huma_uuid

**What happens:** Two scanned files share the same `huma_uuid` (e.g. user copy-pasted a synced note); plugin emits a push for the UUID.
**Why it's wrong:** Server interprets the push as a rename of the original; the loser file remains on disk; the next pull may clobber the loser's content. Real data-loss path.
**Do this instead:** Detect the duplicate in reconcile Step B, surface via `duplicateUuids[]` and `duplicate_uuid` audit entries, refuse to push/pull/rename for the affected UUID until the user removes one of the frontmatter entries (`reconcile.ts:129-200`).

## Error Handling

**Strategy:** Layered classification. Workers absorb retryable errors; engine bubbles fatal errors to plugin shell; plugin shell maps to user-facing Notice via `classifyErrorForUser`.

**Patterns:**
- `HttpError` (`client/http.ts:4`) carries `status`, raw `body`, and parsed `apiError: ApiError | null`. Throws on any non-2xx.
- `TokenManager` distinguishes recoverable vs unrecoverable refresh failures via `isUnrecoverableAuthError` (closed set: `refresh_token_reused`, `token_reused`, `invalid_grant`, `invalid_token`); the latter clear stored tokens.
- Pull worker handles `404 not_found` specially: drops the named id from the manifest, retries the rest of the batch (capped at batch length).
- Push worker retries `PUSH_MAX_RETRIES = 3` times with exponential backoff (500ms, 1s) before deferring. Deferred actions reappear on the next cycle.
- Engine wraps the entire cycle in try/catch: any thrown error → `state: error` callback → re-throw to plugin shell. Plugin shell classifies via `classifyErrorForUser` (`main.ts:520`) and shows a Notice; if unrecoverable auth, also stops polling and renders signed-out.
- Audit ring captures `auth_error`, `push_reject`, `pull_drop`, `server_deleted`, `duplicate_uuid`, `token_scan_warning` for forensic trace.

## Cross-Cutting Concerns

**Logging:** No `console.*` outside of obvious diagnostics. User-visible log is the audit ring (capacity 200), shown via the audit log modal.

**Validation:** Server-supplied paths normalized via `obsidian.normalizePath` before any vault operation. Frontmatter is parsed defensively with `gray-matter` (no schema enforced beyond reading `huma_uuid`).

**Authentication:** OAuth 2.0 Device Authorization Grant via `/api/vault/auth/device` and `/api/vault/auth/token`. Refresh tokens rotate per response. Bearer token attached to every Vault API request via `TokenManager.getAccessToken()`.

**Security invariant:** Stored tokens MUST never appear under the vault root. Startup scan blocks plugin load if any vault file contains an exact-match stored token; non-blocking warning surfaces token-shaped strings for user review.

**Mobile parity:** Same engine, different UI scaffolding. No status bar (Obsidian mobile constraint); ribbon icon + status modal instead. No interval poll; foreground-resume trigger via `active-leaf-change`. Web Crypto used for hashing (no `node:crypto`). All HTTP via `requestUrl` (no `fetch`).

---

*Architecture analysis: 2026-05-01*
