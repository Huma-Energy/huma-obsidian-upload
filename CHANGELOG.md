# Changelog

All notable changes to **Huma Vault Sync** will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Reconcile rewritten as single `decide(server, local, scan)` function backed by exhaustive matrix property tests.** The three-pass partition structure collapsed into a pure per-UUID decision function plus a UUID-union dispatch loop. Server-side rename detection lives entirely in dispatch (rebinds `effectiveScan` and `effectiveLocal` to `server.path` so `decide()` sees pathsAlign-true and produces same-cycle pull/push naturally). 379 → 279 LOC, all 10 public type exports byte-identical. The `decide()` property fixture in `tests/sync/reconcile.test.ts` enumerates every `docs/CONFLICT-MATRIX.md` cell — 8 master rows + 8 sub-matrix #6 boolean combinations + 5 critical preserved behaviors (duplicate-uuid refusal × 2, synthetic-server-entry × 2, Pass-2 protection). Verify-by-deletion procedure documents Guard A (synthetic-entry promotion) and Guard B (duplicate-uuid skip) as load-bearing. CONFLICT-MATRIX.md Verification matrix is now derivable from the property fixture; all 7 pre-refactor `reconcile.ts:NNN` line-number citations replaced with symbol-name citations.
- **`stale_local_delete` audit event** (severity `warning`). Reconcile's stale-local-delete actions now produce audit entries so the user can trace which file produced a status-bar warning.
- **Stale deletion resolution UI** (`src/ui/stale-resolution-modal.ts`). When the local manifest tracks a UUID whose file is missing from disk, the user can pick **Restore** (direct pull-worker call, awaits any inflight cycle to avoid the saveManifest overwrite race; the restored file is opened and revealed in the file explorer) or **Ignore** (UUID added to `ignoredStaleIds`, suppressed by post-reconcile filter, auto-cleaned when the server tombstones the file). Surfaced via status-bar click when stale-deletes are the only outstanding issue, or by clicking a `stale_local_delete` row in the audit log.
- **Server-deleted resolution UI** (`src/ui/server-deleted-resolution-modal.ts`). When the server tombstones a file the local vault still holds, the user can pick **Delete locally** (`fileManager.trashFile`, respects user's deletion preference) or **Keep locally** (strips `huma_uuid` via `processFrontMatter` so the orphan stops re-pushing). Pending entries persisted in `data.pendingServerDeletes`, deduped by id, auto-cleared if the file no longer exists in the vault. Modal copy warns about the un-archive blind spot until the server-side fix lands.
- **"Sync now" button in the settings tab** and **clickable idle status-bar state**. The status bar in `idle` now triggers `runFullSync()` on click instead of showing a Notice. Settings tab gets a CTA button (disabled when not signed in) that runs the same sync code path as the command-palette action and the ribbon icon.

### Changed

- **Status bar `conflict` state** extends with `serverDeletedCount` and the click router opens the appropriate resolution modal when only one issue kind is outstanding, otherwise the audit log.
- **Audit log rows for `stale_local_delete` and `server_deleted` are clickable** (with keyboard support) and route to their resolution modals.
- **`server_deleted` audit event severity bumped from `info` to `warning`** to match the user-attention required.

### Fixed

- **Restore stale-deletion no longer waits a full sync cycle.** The original implementation dropped the manifest row and called `runFullSync()`, which coalesced onto an inflight polling cycle. That cycle's end-of-cycle `saveManifest` overwrote the drop, leaving the user to wait for the next 30 s polling tick. Restore now bypasses reconcile entirely with a direct `runPullWorker` call, after first awaiting any inflight cycle so no concurrent `saveManifest` can step on the result. Latency dropped from multi-minute to ~1 s in observed cases.

- **Locally-edited files no longer go silent in delta-mode reconcile.** Reconcile now synthesises a server manifest entry (from the local manifest's last-known state) for every locally-tracked UUID that delta excluded, and Pass 1 reconciles them uniformly. Previously the Bug 1 fix made Pass 2 skip any locally-known UUID — correct for in-sync files but wrong for files the user had edited or renamed since the last sync. Live repro: a file created at `Untitled.md`, then renamed and edited, sat unsynced on disk while the plugin reported "synced". Same mechanism caused other locally-modified files to silently miss pushes for entire delta windows.
- **Backfilled server rows now reach disk after sign-in.** Engine cold-starts every plugin load with a full manifest fetch (`since: null`), and re-baselines every 20th cycle thereafter. Previously a `lastSince` persisted across sign-out could mask any row the server backfilled with an older timestamp — those rows never appeared in delta responses and never pulled. The cold-start + periodic re-baseline pattern is the standard delta-sync recovery practice (RFC 6578 sync collections, Microsoft Graph delta queries, Apple CloudKit change tokens, Google Drive Changes API). Policy lives in `src/sync/manifest-fetch-policy.ts`.
- **Reconcile no longer re-pushes every locally-synced file every cycle.** `Pass 2` (UUIDs absent from the server manifest) was treating any locally-known UUID as a "first push". Because the manifest is fetched in delta mode (`?since=lastSince`), unchanged files are absent from `serverById` — so every previously-synced file fell into Pass 2 and re-pushed every cycle. Pass 2 now also skips UUIDs present in `localById`. Live impact on the user's vault: ~36 spurious `push_accept` events per cycle dropping to zero for unchanged files.
- **Pull `not_found` no longer loops forever.** When `/api/vault/pull` returns `404 { error: "not_found", id: <uuid> }` the pull worker now drops that id from the local manifest, retries the rest of the batch with the survivors, and emits a `pull_drop` audit entry. Previously the entire batch was treated as a generic failure, so the stale id was retried on every cycle indefinitely. Worker is bounded at `batch.length + 1` retries to defend against a misbehaving server.
- **Duplicate `huma_uuid` no longer risks data loss.** When two vault files carry the same `huma_uuid` (e.g. user copy-pasted a synced note keeping its frontmatter), reconcile now refuses to push, pull, or rename for that UUID until the user removes one of the duplicates. Previously the second-listed file silently won and was pushed as a rename of the first, which could cause the next pull to clobber content the user still had locally.
- **Pre-sign-in heuristic token scan.** `scanVaultForTokens` now runs the heuristic scan even when no auth tokens are stored. The previous early-return left first-launch users with no warning if their vault contained long base64-shaped strings.

### Added

- **`server_deleted` audit event.** Engine now emits an audit entry for every manifest row dropped due to a server-side tombstone, with the row's last-known path. Surfaced via Show sync log so the user can trace why a row vanished and find the on-disk file the plugin intentionally left behind.
- **Status bar surfaces duplicate `huma_uuid` count.** The `conflict` state aggregates conflict files, stale local deletions, and duplicate-UUID file sets; click-through opens the audit log.
- **Excluded folders** setting. Vault-relative folder paths (one per line, prefix match) whose contents are skipped by sync. Files already on the server are not deleted when a folder is added to the list — they remain frozen at their last-synced version until archived manually on the dashboard. Reconcile drops excluded paths from the server manifest, the local manifest, and the vault scan, so excluded files cannot push, pull, or trigger stale-delete actions.

## [0.1.0] — 2026-04-30

First pre-release. Distributed via [BRAT](https://github.com/TfTHacker/obsidian42-brat); not yet submitted to the Obsidian community plugin registry.

### Added

- Bidirectional sync engine. Server manifest (`/api/vault/manifest`) is reconciled against the local manifest and a vault scan to produce a deterministic action list (server-deletes → pulls → pushes → adds → stale-deletes). Action ids are stable so a crashed cycle resumes cleanly.
- Pull worker (`/api/vault/pull`) batching at 50 IDs per request, writing each file via `Vault.process` (existing) or `vault.create` (new). Server-provided paths are run through `normalizePath`.
- Push worker (`/api/vault/push`) with three server outcomes — `accept`, `merge_clean`, `merge_dirty`. Up to three attempts with exponential backoff between them (500 ms, then 1 s); a third failure defers the action to the next cycle.
- First-push UUID injection via `FileManager.processFrontMatter`, leaving body content untouched.
- Conflict emission to sibling `<basename>.conflict.md` files with git-style markers (`<<<<<<< local` / `=======` / `>>>>>>> server`). The original file is replaced with the server body so on-disk state matches the server until the user reconciles.
- ZITADEL device-authorization grant for sign-in. Polling honors `slow_down`, `expired_token`, and `access_denied`. Tokens (access + refresh) live only in plugin data, never in any vault file.
- 200-entry append-with-eviction audit ring covering pushes (`push_accept`, `push_reject`, `merge_clean`, `merge_dirty`) and pulls (`pull_apply`). Surfaced via the **Show sync log** command.
- Status-bar item on desktop with six states (signed-out, idle, syncing, error, conflict, blocked); ribbon icon + status modal on mobile, since Obsidian doesn't support custom status-bar items there.
- Vault-token-leak startup invariant. The plugin scans every markdown file for token-shaped strings (`[A-Za-z0-9_-]{40,}`); exact matches against currently stored tokens block startup with a 0-timeout Notice naming the offending file. Heuristic-only matches surface as a warning.
- Self-write tracker (path × body-hash, 30 s TTL, periodic prune) so plugin-initiated writes don't trigger their own modify events and induce a sync loop.
- Settings tab: server base URL, sign-in/out, sync interval slider (10–300 s, default 30 s).
- Commands: **Sync now**, **Sign in**, **Sign out**, **Resolve conflicts** (palette-hidden when nothing to resolve), **Show sync log**, **Reset local sync state**.
- Mobile QA matrix in `docs/MOBILE-QA.md` covering cold-launch, sync cycle, conflict handling, sign-out, the token-leak invariant, and performance targets.

### Security

- Tokens are stored exclusively in Obsidian's plugin data (`data.json`); the startup invariant blocks the plugin from running if any token-shaped string is found in the vault.
- All HTTP traffic uses Obsidian's `requestUrl` instead of `fetch`. No CORS preflight, no `node:fetch`.
- Server-provided paths are normalized through `normalizePath` before any vault operation, defending against traversal attempts.
- File body writes use `Vault.process`; frontmatter writes use `FileManager.processFrontMatter`. Both are atomic against concurrent plugin writes.
- Refresh tokens rotate atomically through `TokenManager` with a single-flight in-flight guard so concurrent requests during refresh don't double-spend the refresh token.

### Notes

- `minAppVersion: 1.4.16`. Earlier Obsidian versions are unsupported; some APIs the plugin relies on (`Platform`, `processFrontMatter`, `requestUrl`) predate that but the plugin has not been validated below 1.4.
- Manifest persistence is incremental: the push worker flushes the manifest every 25 successful outcomes (and at end-of-run); the pull worker flushes per batch. A mid-cycle crash loses at most 25 pushes worth of progress, not the full cycle.
- Sign-out preserves the manifest, lastSince, and audit ring so re-signing-in is a fast no-op rather than a full vault rehash. Use the **Reset local sync state** command to clear them explicitly.

[Unreleased]: https://github.com/Huma-Energy/huma-obsidian-upload/compare/0.1.0...HEAD
[0.1.0]: https://github.com/Huma-Energy/huma-obsidian-upload/releases/tag/0.1.0
