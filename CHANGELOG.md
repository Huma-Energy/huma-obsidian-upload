# Changelog

All notable changes to **Huma Vault Sync** will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

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
