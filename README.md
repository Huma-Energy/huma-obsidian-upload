# Huma Vault Sync

Bidirectional sync between an [Obsidian](https://obsidian.md) vault and the [Huma](https://huma.energy) dashboard's collaborative editor.

Edit notes locally in Obsidian (online or offline) and keep them in lockstep with the Huma web app. Identity is a UUID written into each note's frontmatter (`huma_uuid`), so renames don't break sync. Authentication uses the ZITADEL device-authorization grant — no token ever touches the vault.

> **Status:** v0.1.0 — pre-release. Task 1 scaffold only (smoke load + status-bar message). Sync engine ships in subsequent tasks.

## Install (BRAT, beta sideload)

Until this plugin is published to the Obsidian community registry, install via [BRAT (Beta Reviewers Auto-update Tool)](https://github.com/TfTHacker/obsidian42-brat):

1. In Obsidian, install BRAT from **Settings → Community plugins → Browse**.
2. Enable BRAT, then open **BRAT → Add Beta Plugin**.
3. Paste this repository URL and confirm.
4. Enable **Huma Vault Sync** under **Settings → Community plugins**.

BRAT will auto-update the plugin from each new GitHub release.

## Platforms

The plugin runs on macOS desktop, Linux desktop, iOS Obsidian, and Android Obsidian (`isDesktopOnly: false`). Mobile parity is a v1 requirement — the plugin uses only Obsidian's documented Plugin API and standard `fetch` / `crypto`, no Node-only APIs.

## Settings

After the v1 sync engine lands, the plugin's settings tab will expose:

- **Server base URL** — the Huma dashboard origin (e.g. `https://huma.energy`).
- **Sign in / Sign out** — ZITADEL device-flow authentication. Tokens are stored exclusively in Obsidian's plugin data (`data.json`), never in any vault file.
- **Sync interval** — desktop polling interval (default 30s, min 10s, max 300s). Mobile syncs only on foreground resume and on explicit user commands.

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

## License

MIT — see [LICENSE](./LICENSE).
