# Conflict matrix

Every local-vs-server divergence the plugin can encounter, the action it emits, and the worker that executes it. Cross-referenced to source line numbers — keep this doc in sync when reconcile changes.

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
| 1 | absent | absent | present, **no UUID** | `add` (push with id=null) | `reconcile.ts:226` |
| 2 | absent | absent | present, **has UUID** | `push` (id=null; server mints or recognises) | `reconcile.ts:209-223` |
| 3 | live | absent | absent | `pull` (first-time pull) | `reconcile.ts:142-149` |
| 4 | live | absent | present | `pull` (recover from wiped `data.json`) | `reconcile.ts:160-168` |
| 5 | live | present | absent | `stale-local-delete` (surfaced in status bar; no auto-action — delete sync is v1.1) | `reconcile.ts:135-140` |
| 6 | live | present | present | sub-matrix below | — |
| 7 | tombstoned | absent | absent | no-op | — |
| 8 | tombstoned | present **or** scan present | — | `server-deleted` (drop manifest row, leave vault file alone) | `reconcile.ts:117-128` |

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

`rename-local` is ordered **before** pulls and pushes (`reconcile.ts:234-242`), so any same-cycle pull or push uses `server.path` as the logical path and lands at the post-rename file. The engine moves the local file via `app.fileManager.renameFile` (`rename-local.ts:18`), which also updates internal links across the vault.

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
- Audit: `server_deleted` event per dropped row, with the row's last-known path.

### `stale-local-delete`

- Counted into `stats.staleLocalDelete` and surfaced via the status bar's `conflict` state with `staleCount`.
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
| Locally-synced file with `huma_uuid` known to local manifest but absent from a delta server manifest (`?since=lastSince` window misses unchanged files) | reconcile synthesises a server manifest entry for every locally-tracked UUID delta omitted (using the local manifest's last-known state), then routes through Pass 1 normally. In-sync files no-op; locally-edited or renamed files emit push; locally-deleted files emit stale-local-delete. Pass 2 only handles true first-push (id=null) cases | As designed (regression tests in `tests/sync/reconcile.test.ts`: "delta hides server entry, file edited locally → pushes via synthetic server entry", "delta hides server entry, file deleted locally → emits stale-local-delete") |
| Server has rows whose `updated_at` is older than the persisted `lastSince` (e.g. backfilled web docs the user has never pulled, post-sign-out where manifest is preserved) | Engine cold-starts every plugin load with a full fetch and re-baselines every `FULL_FETCH_EVERY` cycles. Standard delta-sync recovery practice (RFC 6578, MS Graph deltas, CloudKit, Drive Changes API) | As designed (policy unit-tested in `tests/sync/manifest-fetch-policy.test.ts`) |
| Two local files share the same `huma_uuid` (corrupted import) | reconcile refuses to push, pull, or rename for the duplicate UUID. Engine emits `duplicate_uuid` audit and the status bar shows a `conflict` state until the user removes the duplicate frontmatter from one of the files | As designed |
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

For each row in the master matrix and the sub-matrix, the test that covers it (or "manual" if untested):

| Scenario | Test |
|---|---|
| #1 add (new local, no UUID) | `tests/sync/reconcile.test.ts` "emits an add for a scanned file with no huma_uuid" |
| #2 push id=null (UUID frontmatter, server-unknown) | `tests/sync/reconcile.test.ts` "master row #2: pushes with id=null when scan has a UUID neither side knows" |
| #3 pull (first-time) | `tests/sync/reconcile.test.ts` "master row #3: pulls first-time when server has a row neither local manifest nor scan has" |
| #4 pull (recover from wiped data.json) | `tests/sync/reconcile.test.ts` "master row #4: pulls to recover when data.json was wiped" |
| #5 stale-local-delete | `tests/sync/reconcile.test.ts` "emits a stale-local-delete when the file vanished locally" |
| #6 various | see sub-matrix below |
| #7 no-op | `tests/sync/reconcile.test.ts` "master row #7 (no-op): emits no actions when server, local, and scan all agree" |
| #8 server-deleted | `tests/sync/reconcile.test.ts` "emits server-deleted for tombstoned server entries" |
| #6 clean pull | `tests/sync/reconcile.test.ts` "emits a pull when the server has a newer version and locally unchanged" |
| #6 clean push | `tests/sync/reconcile.test.ts` "emits a push when the local file diverges from the manifest" |
| #6 divergent push | `tests/sync/reconcile.test.ts` "emits a push and counts a conflict when both sides diverged" |
| #6 plugin-side rename | `tests/sync/reconcile.test.ts` "emits a push with previous_path when the local file was renamed" |
| #6 server-side rename only | `tests/sync/reconcile.test.ts` "emits rename-local when server moved a file the user did not" |
| #6 server-side rename + version bump | `tests/sync/reconcile.test.ts` "rename-local plus pull when server renamed and bumped version" |
| #6 server-rename, no double-push | `tests/sync/reconcile.test.ts` "does not emit plugin-side push-rename when scan path matches local" |
| #6 plugin-side rename + local edit | `tests/sync/reconcile.test.ts` "sub-matrix ✓ ✗ – ✓: emits a single push with previousPath for plugin-side rename + local edit" |
| #6 three-way path mismatch (lossy) | `tests/sync/reconcile.test.ts` "sub-matrix ✗ ✗ – –: concurrent rename-rename to different paths" |
| Cold-start / re-baseline manifest fetch | `tests/sync/manifest-fetch-policy.test.ts` |
| Pass 2 skip on locally-known UUID (delta-mode protection) | `tests/sync/reconcile.test.ts` "does not re-push a locally-known file absent from a delta server manifest" |
| Empty-body hash drift | `tests/sync/frontmatter.test.ts` "hash of parsed-back body is stable…" |
| Excluded folder filter | `tests/sync/reconcile.test.ts` "emits no actions for server entries inside an excluded folder" |
| Conflict file frontmatter scan filter | `tests/sync/scan.test.ts` "excludes *.conflict.md files from the scan" |
| Path normalization defence | `tests/sync/conflict.test.ts` "normalizes path traversal attempts" |
| Self-write tracker | `tests/sync/self-write-tracker.test.ts` |
| Error classification | `tests/main-error-classifier.test.ts` |
| Pull `not_found` drop | `tests/sync/pull-worker.test.ts` |
| Duplicate `huma_uuid` refusal | `tests/sync/reconcile.test.ts` "refuses to act when two scanned files share a huma_uuid" |
| Pre-sign-in heuristic token scan | `tests/security/vault-token-scan.test.ts` "surfaces heuristic matches when no stored tokens are configured (pre-sign-in)" |

## Updating this doc

When you add or change an action in `reconcile.ts`, `engine.ts`, `pull-worker.ts`, `push-worker.ts`, or `conflict.ts`, update the relevant section here. Cross-references include line numbers — those rot when the source moves; treat them as approximate and search by symbol name.
