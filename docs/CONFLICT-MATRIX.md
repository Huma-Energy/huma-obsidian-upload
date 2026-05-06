# Conflict matrix

Every local-vs-server divergence the plugin can encounter, the action it emits, and the worker that executes it. Cross-referenced to source symbols (decide branches, dispatch loop steps) — keep this doc in sync when reconcile changes.

## State model

Reconciliation joins three views per cycle:

1. **Server manifest** entry — `{id, path, version, hash, deleted_at}` from `GET /api/vault/manifest`. Authoritative for path and version. `deleted_at !== null` means tombstoned.
2. **Local manifest** record — `{id, path, version, hash, lastSyncedAt}` in `data.json`. The plugin's last-known state.
3. **Vault scan** — files on disk. Each scanned file has `{path, hash, uuid?, frontmatter, body}`. UUID is read from the file's frontmatter; absent means the file has never been pushed.

Three comparisons drive the action choice:

- **Path agreement**: `server.path` vs `local.path` vs `scanned.path`
- **Edit detection**: `scanned.hash` vs `local.hash` (different → user edited locally)
- **Version comparison**: `server.version` vs `local.version` (different → server changed)

Excluded folders are filtered out of all three views before reconcile.

## Master matrix — file existence

The 8 presence permutations of (server × local manifest × scan-by-UUID).

| # | Server | Local manifest | Scan-by-UUID | Action | Cite |
|---|---|---|---|---|---|
| 1 | absent | absent | present, **no UUID** | `add` (push with id=null) | `reconcile.ts` Step E — no-UUID adds loop |
| 2 | absent | absent | present, **has UUID** | `push` (id=null; server mints or recognises) | `reconcile.ts decide()` — server-absent, scan-with-UUID, local-absent branch |
| 3 | live | absent | absent | `pull` (first-time pull) | `reconcile.ts decide()` — server-live, scan-absent, local-absent branch |
| 4 | live | absent | present | `pull` (recover from wiped `data.json`) | `reconcile.ts decide()` — sub-matrix #6 cascade with `local === null` |
| 5 | live | present | absent | `stale-local-delete` (surfaced in status bar; no auto-action — delete sync is v1.1) | `reconcile.ts decide()` — server-live, scan-absent, local-present branch |
| 6 | live | present | present | sub-matrix below | `reconcile.ts decide()` — sub-matrix #6 cascade |
| 7 | tombstoned | absent | absent | no-op | `reconcile.ts decide()` — server-tombstone, no-side-state branch |
| 8 | tombstoned | present **or** scan present | — | `server-deleted` (drop manifest row, leave vault file alone) | `reconcile.ts decide()` — server-tombstone branch |

## Sub-matrix #6 — server live, local present, scan match-by-UUID

Within row #6 the action depends on three boolean conditions:

- `pathsAlign` ≡ `server.path === local.path === scanned.path`
- `serverNewer` ≡ `server.version > local.version`
- `localEdited` ≡ `scanned.hash !== local.hash`

| `server.path = local.path` | `scanned.path = local.path` | `serverNewer` | `localEdited` | Action | Notes |
|---|---|---|---|---|---|
| ✓ | ✓ | ✗ | ✗ | (no-op) | in sync |
| ✓ | ✓ | ✓ | ✗ | `pull` | clean server-update |
| ✓ | ✓ | ✗ | ✓ | `push` | clean local-edit |
| ✓ | ✓ | ✓ | ✓ | `push`, conflict++ | divergent edits → server-side three-way merge |
| ✓ | ✗ | – | ✗ | `push` with `previousPath` | plugin-side rename, no body change |
| ✓ | ✗ | – | ✓ | `push` with `previousPath` | plugin-side rename + local edit |
| ✗ | ✓ | – | – | `rename-local`, then pull/push as needed | server-side rename detected (commit `0685a8b`) |
| ✗ | ✗ | – | – | `push` at `scan.path` with `previousPath = local.path` | rare three-way mismatch. `serverRenamed` requires `scanned.path === local.path`, so this case bypasses rename-local entirely; client-side rename wins, server's competing rename is lost. Lossy by design — see § "Out of scope" |

Server-side rename detection lives in `reconcile.ts` dispatch loop (Step D — server-side rename branch). When `server.path !== local.path && scan.path === local.path`, dispatch emits `rename-local` directly and synthesizes `effectiveScan = { ...scan, path: server.path }` plus `effectiveLocal = { ...local, path: server.path }` so `decide()` produces any same-cycle pull/push at the post-rename path naturally. `rename-local` is bucketed **before** pulls and pushes in the final action assembly (`reconcile.ts` Step D — action ordering invariant). The engine moves the local file via `app.fileManager.renameFile` (`rename-local.ts` action handler), which also updates internal links across the vault.

## Action handlers

### `pull` — `pull-worker.ts:30`

- Batches of 50 ids per `POST /api/vault/pull` request.
- For each returned file: write via `replaceFileBody` (atomic `Vault.process`) if a markdown TFile already exists at `normalizePath(file.path)`; via `vault.create` if no file there; error if a non-markdown file occupies the path.
- Frontmatter: `withHumaUuid(file.frontmatter ?? {}, file.id)` — `huma_uuid` is always written; other server-provided keys are preserved verbatim.
- Manifest: appends `{id, path: normalizePath(file.path), version, hash: sha256(parseFile(stringifiedText).body), lastSyncedAt}`. Critically, hash is over the **parsed-back** body, not the raw server `body`, so empty-body backfills don't drift on the next scan (commit `0685a8b`).
- Audit: `pull_apply` per successful file.
- Self-write tracker records the path × parsed-body-hash before write so the resulting `vault.on('modify')` doesn't re-trigger sync.

### `push` (id present) — `push-worker.ts:60`

- Serial. Each action retries up to 3× with exponential backoff (500 ms, 1 s) before deferring.
- Server returns one of three outcomes:
  - `accept` — plugin updates manifest version. On first push (`scanned.frontmatter.huma_uuid !== response.id`), `ensureUuidInVault` injects `huma_uuid` via `app.fileManager.processFrontMatter` (atomic, body untouched).
  - `merge_clean` — plugin writes the server's merged body via `replaceFileBody`; updates manifest version. Hash computed on parsed-back body.
  - `merge_dirty` — plugin emits `<basename>.conflict.md` sibling via `emitConflict`, replaces original with server body, updates manifest with `server_version`.
- Manifest is flushed every 25 outcomes plus end-of-run, so a mid-cycle crash doesn't roll back the first 25-pushes-worth of progress.

### `push` (id null) — same handler as id-present

- Source: pass 2 (UUID set in frontmatter but unknown server-side) or pass 3 (no UUID at all — true new file).
- On `accept`, plugin writes the server-allocated UUID into frontmatter so the next push identifies the file by UUID.

### `rename-local` — `rename-local.ts:18`

- Calls `app.fileManager.renameFile(file, normalizedToPath)` — moves the file and updates internal `[[wikilinks]]` and `![[embeds]]` across the vault.
- Updates the local manifest row's `path` in-place via `applyRenameToManifest`.
- Audit: `path_change` with detail `renamed from <fromPath>`.
- The self-write tracker is not used for rename events (rename doesn't change body content).

### `server-deleted` — engine.ts (final tombstone filter)

- Drops the local manifest row at end-of-cycle.
- Vault file is left alone — the user chooses whether to delete locally.
- Audit: `server_deleted` event per dropped row (severity `warning`), with the row's last-known path.
- Resolution UI: the **Resolve server-deleted files** modal (`src/ui/server-deleted-resolution-modal.ts`) lists pending entries and exposes per-row **Delete locally** (system trash via `fileManager.trashFile`, respects the user's deletion preference) or **Keep locally** (strips `huma_uuid` from frontmatter via `processFrontMatter`, leaving an untracked local copy). Pending entries are persisted in `data.pendingServerDeletes` so the surface survives a session reload; the engine's reconcile re-emits the action every cycle the tombstone is in the `since`-window, deduped by id. Auto-cleared if the file no longer exists in the vault. The modal opens from the status bar when only server-deleted entries are outstanding, or by clicking a `server_deleted` row in the audit log. **Un-archive caveat:** the server's `lastSince`-filtered manifest does not surface un-archive events (`documents.archived_at = NULL` doesn't bump `vault_files.updated_at`); after either Delete or Keep, an admin un-archiving the file requires a manual re-pull (Delete) or yields a true zombie (Keep + edit re-pushes under a fresh UUID, original entry stays disconnected). Server-side fix: bump `updated_at` on un-archive.

### `stale-local-delete`

- Counted into `stats.staleLocalDelete` and surfaced via the status bar's `conflict` state with `staleCount`.
- Audit: `stale_local_delete` event per action, severity `warning`, with the missing file's last-known path and serverId so the user can trace which file produced the status-bar count.
- Resolution UI: the **Resolve stale deletions** modal (`src/ui/stale-resolution-modal.ts`) lists outstanding stale entries and exposes a per-row **Restore** action. Restore drops the local manifest row and triggers a sync — the next reconcile sees `(server live, local absent, scan absent)` (master row #3) and pulls the file back at the server's current path. The modal opens automatically when the user clicks the status bar in `conflict` state with `staleCount > 0` and no `.conflict.md` files outstanding; it can also be opened by clicking a `stale_local_delete` row in the audit log. Confirming a deletion (instead of restoring) requires deleting the file in the Huma web app — the plugin will pick up the tombstone on the next sync (master row #8 → `server-deleted` → manifest row drops). Direct local-delete-to-server propagation is the v1.1 delete-sync work.
- No automatic server-side action. Per plan, delete-sync is deferred to v1.1.

## Conflict-file emission — `conflict.ts:30`

Triggered by server's `merge_dirty` response.

1. Sibling path computed: `<basename>.conflict.md` next to original (or `<name>.conflict.md` if no extension).
2. Conflict body written with git-style markers (`<<<<<<< local` / `=======` / `>>>>>>> server`).
3. Original file replaced with server's body via `replaceFileBody`.
4. Both writes recorded in the self-write tracker so the resulting modify events don't trigger another sync.
5. The scanner's `.conflict.md` filter (`scan.ts:31`) excludes conflict files from subsequent reconciles — they never push or count as new files.

**Resolution flow**: user edits the original to taste, deletes the `.conflict.md` sibling, runs **Sync now** (or waits for the debounced cycle). Next push hits `accept`.

## Concurrent-divergence semantics

| Local change | Server change | Outcome |
|---|---|---|
| edit | none | `push` → server `accept` |
| none | edit | `pull` |
| edit | edit | `push` → server-side three-way merge → `accept` / `merge_clean` / `merge_dirty` |
| rename | none | `push` with `previousPath` → server updates path |
| none | rename | `rename-local` → plugin moves local file |
| edit | rename | `push` with `previousPath` and edited body → server resolves |
| rename | edit | `pull` after rename-local; user's local rename intent is at risk (see ambiguity below) |
| rename A→B | rename A→C | **lossy.** Plugin emits `rename-local A→B` because `scanned.path === local.path` is false; falls through to plugin-side rename branch (push from C). Server has B. Likely `path_conflict` error. **Out of scope for v1.** |
| edit | delete (tombstone) | `server-deleted` drops manifest row; user keeps the local file with their edits but it's now disconnected from the server |
| delete | edit | `stale-local-delete` flagged; no server-side delete pushed |
| delete | delete | `server-deleted` + scan absent → reconcile drops the manifest row, no further action |

## Edge cases and limits

| Scenario | Current behaviour | Status |
|---|---|---|
| Request body > 5 MB (Netlify body cap) | server returns size-cap error first; retries return generic 500. Plugin defers, retries on every cycle | Server-side limit; client-side pre-flight check queued |
| Token-shaped string in vault file matching a stored token | startup invariant blocks plugin load with 0-timeout Notice naming the file; `token_scan_warning` audit entry written | As designed |
| Token-shaped string heuristic match (not stored token) | non-blocking warning Notice at startup, including pre-sign-in (heuristic loop runs whether or not stored tokens exist) | As designed |
| Plugin self-write triggers `vault.on('modify')` | self-write tracker (path × body-hash, 30 s TTL, periodic prune) suppresses the matching event | As designed |
| `*.conflict.md` file gets pushed as new doc | scanner filter excludes by suffix | As designed |
| Empty body + frontmatter-only file (backfilled web doc) | hash uses parsed-back body, not raw `""`; no false locally-edited flag on the next cycle | Fixed in `0685a8b` |
| Excluded folder added with files already on server | server copies remain unchanged; plugin stops syncing them. Reconcile filters all three views | As designed |
| Folder rename in vault | Obsidian fires per-file rename events; reconcile emits push-rename per file | As designed |
| Mid-cycle plugin crash | manifest persisted incrementally (push every 25, pull per batch). Next start picks up from last persisted state | As designed |
| Server returns path with backslashes / leading slashes / non-NFC unicode | `normalizePath` cleans; the cleaned path is used everywhere thereafter | As designed |
| File with `huma_uuid` set but UUID unknown to server (stale frontmatter) | pass-2 emits push with id=null; server allocates new UUID and overwrites the frontmatter | As designed |
| Locally-synced file with `huma_uuid` known to local manifest but absent from a delta server manifest (`?since=lastSince` window misses unchanged files) | reconcile synthesises a server manifest entry for every locally-tracked UUID delta omitted (using the local manifest's last-known state — Step C: synthetic-entry promotion), then dispatches `decide()` over the UUID union. In-sync files no-op; locally-edited or renamed files emit push; locally-deleted files emit stale-local-delete. The `server: null + scan-with-UUID + local: null` branch in `decide()` handles only true first-push (id=null) cases | As designed (regression tests in `tests/sync/reconcile.test.ts`: "delta hides server entry, file edited locally → pushes via synthetic server entry", "delta hides server entry, file deleted locally → emits stale-local-delete", plus the property-fixture rows "synthetic-server-entry: pushes with serverId and previousPath when delta hides server row but scan diverges" and "synthetic-server-entry: emits stale-local-delete when delta hides row and scan is absent") |
| Server has rows whose `updated_at` is older than the persisted `lastSince` (e.g. backfilled web docs the user has never pulled, post-sign-out where manifest is preserved) | Engine cold-starts every plugin load with a full fetch and re-baselines every `FULL_FETCH_EVERY` cycles. Standard delta-sync recovery practice (RFC 6578, MS Graph deltas, CloudKit, Drive Changes API) | As designed (policy unit-tested in `tests/sync/manifest-fetch-policy.test.ts`) |
| Two local files share the same `huma_uuid` (corrupted import) | reconcile refuses to push, pull, or rename for the duplicate UUID and surfaces it via `result.duplicateUuids`. Engine emits a single `duplicate_uuid` audit per UUID (deduped via `auditedDuplicateIds`) and the status bar shows a `conflict` state. Resolution UI: the **Resolve duplicate files** modal (`src/ui/duplicate-uuid-resolution-modal.ts`) lists each duplicate set and exposes per-row **Keep this one** — picking a path strips `huma_uuid` from the other paths via `processFrontMatter`, so they become untracked locals and re-sync as new files on the next cycle. The modal opens from the status bar when only duplicates are outstanding, or by clicking a `duplicate_uuid` row in the audit log. Each strip emits a `duplicate_uuid_resolved` audit (info severity) with `detail: kept <keep-path>`. Tombstoned UUIDs are excluded from the modal's view (server-deleted modal handles them instead). The plugin-side `resolveDuplicateUuid` awaits any inflight cycle before mutating frontmatter to avoid a `saveManifest` race | As designed |
| Server returns 401 mid-sync | TokenManager refreshes once; on refresh failure the cycle errors and the status bar shows `error` with `classifyErrorForUser` | As designed |
| Network unreachable | TypeError caught, classified to "server unreachable" Notice | As designed |
| Pull returns `id` server doesn't have (`error: not_found`) | pull-worker drops the named id from the local manifest, retries the rest of the batch (capped at batch length to bound a misbehaving server), and emits a `pull_drop` audit per drop | As designed |
| `vault.create` race when two cycles try to create same path | second `create` throws "File exists"; outcome marked deferred | Acceptable |

## Out of scope / deferred

- **Local delete → server**: surfaced as `stale-local-delete` only; no delete-marker push. Per plan, v1.1.
- **Concurrent rename-rename to different paths**: see ambiguity row above.
- **Bodies > 6 MB**: Netlify lambda response/request limits. Needs chunked upload or presigned-URL flow.
- **Tombstone-then-recreate UUID reuse**: behaviour undefined; server policy presumably forbids.
- **Per-request abort on plugin unload**: `requestUrl` doesn't expose `AbortSignal`. In-flight requests run to completion.
- **`huma_*` frontmatter keys other than `huma_uuid`**: namespace reserved, no current use.
- **Multi-device simultaneous renames**: race not protected against client-side; relies on server-side serialization.
- **Folder-level operations** (rename / delete folder): plugin sees per-file rename events only.

## Verification matrix

This table is derivable from the `describe("decide() property matrix", ...)` block in `tests/sync/reconcile.test.ts`. Each master-matrix row, each sub-matrix #6 boolean combination, and each critical preserved behavior cites its exact `it(...)` name. When you add a row to the master/sub-matrix tables above, add the corresponding fixture row first.

### Master matrix coverage

| Scenario | Test |
|---|---|
| master row #1 — add (scan-only, no UUID) | `tests/sync/reconcile.test.ts › decide() property matrix › "master row #1: emits add for scan-only file with no UUID"` |
| master row #2 — push id=null (UUID neither side knows) | `tests/sync/reconcile.test.ts › decide() property matrix › "master row #2: pushes with serverId=null when scan has UUID and neither server nor local know it"` |
| master row #3 — first-time pull | `tests/sync/reconcile.test.ts › decide() property matrix › "master row #3: emits first-time pull when server has a row neither local nor scan know"` |
| master row #4 — pull-recover from wiped data.json | `tests/sync/reconcile.test.ts › decide() property matrix › "master row #4: emits pull when local manifest is wiped but vault file still exists"` |
| master row #5 — stale-local-delete | `tests/sync/reconcile.test.ts › decide() property matrix › "master row #5: emits stale-local-delete when local manifest tracks a file that vanished from disk"` |
| master row #6 — sub-matrix delegation (in-sync no-op marker) | `tests/sync/reconcile.test.ts › decide() property matrix › "master row #6: delegates to sub-matrix — in-sync no-op when all three views agree"` |
| master row #7 — no-op (tombstoned, no local state) | `tests/sync/reconcile.test.ts › decide() property matrix › "master row #7: emits no action for tombstoned server entry the local side never tracked"` |
| master row #8 — server-deleted | `tests/sync/reconcile.test.ts › decide() property matrix › "master row #8: emits server-deleted when server is tombstoned and the local side has anything"` |

### Sub-matrix #6 coverage (boolean combinations)

| Booleans (`s.path=l.path`, `scan.path=l.path`, `serverNewer`, `localEdited`) | Test |
|---|---|
| sub-matrix #6 ✓ ✓ ✗ ✗ — in-sync no-op | `tests/sync/reconcile.test.ts › decide() property matrix › "sub-matrix #6 ✓ ✓ ✗ ✗: emits no action when all three paths align and neither side moved"` |
| sub-matrix #6 ✓ ✓ ✓ ✗ — clean server-update | `tests/sync/reconcile.test.ts › decide() property matrix › "sub-matrix #6 ✓ ✓ ✓ ✗: emits clean pull when server bumped version and local is unchanged"` |
| sub-matrix #6 ✓ ✓ ✗ ✓ — clean local-edit | `tests/sync/reconcile.test.ts › decide() property matrix › "sub-matrix #6 ✓ ✓ ✗ ✓: emits clean push when only the local body diverged"` |
| sub-matrix #6 ✓ ✓ ✓ ✓ — divergent edits | `tests/sync/reconcile.test.ts › decide() property matrix › "sub-matrix #6 ✓ ✓ ✓ ✓: emits push and increments conflict counter when both sides diverged"` |
| sub-matrix #6 ✓ ✗ – ✗ — plugin-side rename, no edit | `tests/sync/reconcile.test.ts › decide() property matrix › "sub-matrix #6 ✓ ✗ – ✗: emits push with previousPath for plugin-side rename without body change"` |
| sub-matrix #6 ✓ ✗ – ✓ — plugin-side rename + edit | `tests/sync/reconcile.test.ts › decide() property matrix › "sub-matrix #6 ✓ ✗ – ✓: emits one push with previousPath for plugin-side rename plus local edit"` |
| sub-matrix #6 ✗ ✓ – – — server-side rename | `tests/sync/reconcile.test.ts › decide() property matrix › "sub-matrix #6 ✗ ✓ – –: emits rename-local plus pull when the server moved the file and bumped version"` |
| sub-matrix #6 ✗ ✗ – – — three-way path mismatch (lossy) | `tests/sync/reconcile.test.ts › decide() property matrix › "sub-matrix #6 ✗ ✗ – –: emits a single push at scan.path when all three paths disagree (lossy by design)"` |

### Critical preserved behaviors

| Scenario | Test |
|---|---|
| Duplicate `huma_uuid` refusal (live server) | `tests/sync/reconcile.test.ts › decide() property matrix › "duplicate huma_uuid refusal: emits no actions and surfaces duplicateUuids"` |
| Duplicate `huma_uuid` + tombstoned server (still surfaces) | `tests/sync/reconcile.test.ts › decide() property matrix › "duplicate huma_uuid plus tombstoned server: still emits server-deleted and surfaces duplicateUuids"` |
| Synthetic-server-entry promotion — push case (Guard A) | `tests/sync/reconcile.test.ts › decide() property matrix › "synthetic-server-entry: pushes with serverId and previousPath when delta hides server row but scan diverges"` |
| Synthetic-server-entry promotion — stale-delete case (Guard A) | `tests/sync/reconcile.test.ts › decide() property matrix › "synthetic-server-entry: emits stale-local-delete when delta hides row and scan is absent"` |
| Pass-2 protection — no spurious push on in-sync delta-omitted UUID | `tests/sync/reconcile.test.ts › decide() property matrix › "Pass-2 protection: emits no action when local and scan agree and server delta omits the row"` |

### Cross-cutting infrastructure

| Scenario | Test |
|---|---|
| Cold-start / re-baseline manifest fetch | `tests/sync/manifest-fetch-policy.test.ts` |
| Empty-body hash drift (parsed-back body invariant) | `tests/sync/frontmatter.test.ts` "hash of parsed-back body is stable…" |
| Excluded folder filter (Step A — three-view filter) | `tests/sync/reconcile.test.ts` "emits no actions for server entries inside an excluded folder" |
| Conflict file frontmatter scan filter | `tests/sync/scan.test.ts` "excludes *.conflict.md files from the scan" |
| Path normalization defence | `tests/sync/conflict.test.ts` "normalizes path traversal attempts" |
| Self-write tracker | `tests/sync/self-write-tracker.test.ts` |
| Error classification | `tests/main-error-classifier.test.ts` |
| Pull `not_found` drop | `tests/sync/pull-worker.test.ts` |
| Pre-sign-in heuristic token scan | `tests/security/vault-token-scan.test.ts` "surfaces heuristic matches when no stored tokens are configured (pre-sign-in)" |

## Updating this doc

When you add or change an action in `reconcile.ts`, `engine.ts`, `pull-worker.ts`, `push-worker.ts`, or `conflict.ts`, update the relevant section here. Cross-references cite source symbols (decide branches, dispatch loop steps) rather than line numbers, since line numbers rot when the source moves.

Since the Step A–E refactor (Phase 1), the reconcile decision logic is concentrated in `decide()` and a UUID-union dispatch in `reconcile()`. The Verification matrix above is derivable from the `describe("decide() property matrix", ...)` block in `tests/sync/reconcile.test.ts` — when adding a row to the matrix, add the corresponding fixture row first.
