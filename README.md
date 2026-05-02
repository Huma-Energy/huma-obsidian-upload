# Huma Vault Sync

Bidirectional sync between an [Obsidian](https://obsidian.md) vault and the [Huma](https://huma.energy) dashboard's collaborative editor.

Edit notes locally in Obsidian (online or offline) and keep them in lockstep with the Huma web app. Identity is a UUID written into each note's frontmatter (`huma_uuid`), so renames don't break sync. Authentication uses the ZITADEL device-authorization grant — no token ever touches the vault.

> **Status:** v0.1.0 — pre-release. The full sync engine ships: bidirectional pull/push with manifest reconciliation, three-way conflict emission to sibling `*.conflict.md` files, server-side three-way merge, ZITADEL device-flow sign-in, audit ring, and a vault-token-leak startup invariant. See `docs/MOBILE-QA.md` for the manual mobile verification matrix.

## Install (BRAT, beta sideload)

Until this plugin is published to the Obsidian community registry, install via [BRAT (Beta Reviewers Auto-update Tool)](https://github.com/TfTHacker/obsidian42-brat):

1. In Obsidian, install BRAT from **Settings → Community plugins → Browse**.
2. Enable BRAT, then open **BRAT → Add Beta Plugin**.
3. Paste this repository URL and confirm.
4. Enable **Huma Vault Sync** under **Settings → Community plugins**.

BRAT will auto-update the plugin from each new GitHub release.

## Platforms

The plugin runs on macOS desktop, Linux desktop, iOS Obsidian, and Android Obsidian (`isDesktopOnly: false`). Mobile parity is a v1 requirement — the plugin uses only Obsidian's documented Plugin API (`requestUrl` for HTTP, `Vault.process` / `FileManager.processFrontMatter` for atomic file writes) and Web Crypto for hashing. No Node or Electron APIs.

On desktop, sync state surfaces in the status bar. Obsidian does not support custom status-bar items on mobile, so on iOS and Android the plugin instead exposes a ribbon icon that opens a status modal with **Sync now** / **Resolve conflicts** / **Show sync log** buttons.

## Settings

The plugin's settings tab exposes:

- **Server base URL** — the Huma dashboard origin (e.g. `https://huma.energy`).
- **Sign in / Sign out** — ZITADEL device-flow authentication. Tokens are stored exclusively in Obsidian's plugin data (`data.json`), never in any vault file.
- **Sync now** — runs an immediate sync cycle. Same code path as the command-palette `Sync now` action, the ribbon icon, and (since v0.1.x) clicking the status-bar item when it's in the `idle` state.
- **Sync interval** — desktop polling interval (default 30s, min 10s, max 300s). Mobile syncs only on foreground resume and on explicit user commands.
- **Excluded folders** — vault-relative folder paths whose contents are skipped by sync (one path per line, prefix match). Files already on the server are *not* deleted when a folder is added — they remain frozen at their last-synced version until you archive them on the dashboard.

## Conflict resolution

When a local edit and a remote edit can't be cleanly three-way merged, the plugin emits a sibling `<basename>.conflict.md` file containing both bodies separated by git-style markers:

```
<<<<<<< local
…your local edits…
=======
…the server's version…
>>>>>>> server
```

The original file is replaced with the server's body so live state on disk matches the server until you reconcile. Use the **Huma — Resolve conflicts** command palette entry to walk through outstanding conflicts; once you've reconciled the original and deleted the `.conflict.md` sibling, the next push goes through cleanly.

Two other states surface their own resolution modals:

- **Stale local deletions** — a file the local manifest tracks is missing from disk while the server entry is still live. Click the status bar (or a `stale_local_delete` row in **Show sync log**) to open **Resolve stale deletions**, then pick **Restore** (re-pull the file from the server) or **Ignore** (suppress the warning; the warning auto-clears if you later archive the file in the Huma web app).
- **Server-deleted files awaiting review** — the server has archived a file the local vault still holds. Pick **Delete locally** (file goes to your OS trash, respecting Obsidian's deletion preference) or **Keep locally** (strips `huma_uuid` from frontmatter so the local copy stops re-pushing).

Both modals are documented end-to-end in [docs/CONFLICT-MATRIX.md](./docs/CONFLICT-MATRIX.md).

## Security posture

- Tokens (access + refresh) live only in Obsidian's plugin data store. A startup invariant scans the active vault for token-shaped strings and refuses to start if any are found.
- All `huma_*` frontmatter keys are namespaced. The plugin reads/writes `huma_uuid` only; user-defined frontmatter is preserved untouched.
- The server's audit log is the canonical record of every push outcome. The local audit ring (200 entries, in plugin data) is a debugging aid, exposed via **Huma — Show sync log**.

## Development

```bash
npm install
npm run dev      # esbuild watch
npm run build    # tsc + esbuild production
npm run lint
npm test
```

Build output is `main.js` at the repo root, alongside `manifest.json` (Obsidian's required layout). To load locally during development, symlink (or copy) the repo into `<vault>/.obsidian/plugins/huma-vault-sync/`, then enable it in Obsidian.

## Security

Vulnerability disclosure process and the plugin's security model are documented in [SECURITY.md](./SECURITY.md). Do not file public issues for suspected security findings.

## Conflict matrix

Every local-vs-server divergence the plugin can encounter, what action it emits, and which worker executes it, is enumerated in [docs/CONFLICT-MATRIX.md](./docs/CONFLICT-MATRIX.md). Read this before changing `reconcile.ts`.

## Changelog

Release notes live in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT — see [LICENSE](./LICENSE).
