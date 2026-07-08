<p align="center">
	<img src="./obsidian-huma-icon.png" alt="Huma Vault Sync" width="96" height="96">
</p>

# Huma Vault Sync

Bidirectional sync between an [Obsidian](https://obsidian.md) vault and the [Huma](https://huma.energy) dashboard's collaborative editor.

Edit notes locally in Obsidian (online or offline) and keep them in lockstep with the Huma web app. Identity is a UUID written into each note's frontmatter (`huma_uuid`), so renames don't break sync. Authentication uses the ZITADEL device-authorization grant — no token ever touches the vault.

> **Status:** v0.1.9 — pre-release. The full sync engine ships: bidirectional pull/push with manifest reconciliation, three-way conflict emission to sibling `*.conflict.md` files, server-side three-way merge, ZITADEL device-flow sign-in, per-note and per-folder document sharing (visibility + collaborators), audit ring, vault-token-leak startup invariant, and resolution modals for stale local deletions, server-deleted files, and duplicate UUIDs. See `docs/MOBILE-QA.md` for the manual mobile verification matrix.

## Install (BRAT, beta sideload)

Until this plugin is published to the Obsidian community registry, install via [BRAT (Beta Reviewers Auto-update Tool)](https://github.com/TfTHacker/obsidian42-brat):

1. In Obsidian, install BRAT from **Settings → Community plugins → Browse**.
2. Enable BRAT, then open **BRAT → Add Beta Plugin**.
3. Paste `https://github.com/Huma-Energy/huma-obsidian-upload` and confirm.
4. Enable **Huma Vault Sync** under **Settings → Community plugins**.

BRAT will auto-update the plugin from each new GitHub release.

## Platforms

The plugin runs on macOS, Windows, and Linux desktop, plus iOS and Android Obsidian (`isDesktopOnly: false`). Mobile parity is a v1 requirement — the plugin uses only Obsidian's documented Plugin API (`requestUrl` for HTTP, `Vault.process` / `FileManager.processFrontMatter` for atomic file writes) and Web Crypto for hashing. No Node or Electron APIs.

On desktop, sync state surfaces in the status bar. Obsidian does not support custom status-bar items on mobile, so on iOS and Android the plugin exposes a "Huma sync" ribbon icon that opens a status modal with **Sync now** and **Show sync log** buttons; a **Resolve conflicts (N)** button appears when conflicts are outstanding. Other resolution flows (stale local deletions, server-deleted files, duplicate files) are reached by tapping the relevant row inside the sync log.

## Settings

The plugin's settings tab exposes:

- **Server base URL** — the Huma dashboard origin you're syncing with. Pre-filled with the current default; change it only if your Huma deployment lives elsewhere.
- **Sign in / Sign out** — ZITADEL device-flow authentication. Tokens are stored exclusively in Obsidian's plugin data (`data.json`), never in any vault file.
- **Sync now** — runs an immediate sync cycle. Same code path as the command-palette `Sync now` action, the ribbon icon, and clicking the status-bar item when it's in the `idle` state.
- **Sync interval** — desktop polling interval (default 30s, min 10s, max 300s). Mobile syncs only on foreground resume and on explicit user commands.
- **Excluded folders** — vault-relative folder paths whose contents are skipped by sync (one path per line, prefix match). Files already on the server are *not* deleted when a folder is added — they remain frozen at their last-synced version until you archive them on the dashboard.

## Sharing

Set who can see a synced note directly from Obsidian, reusing Huma's document access control. Open the share panel from either:

- **Right-click a note → "Share on Huma…"** in the file explorer, or
- the command palette → **Huma Vault Sync: Share this note**.

Both require you to be signed in and on a Markdown note. A note that hasn't synced yet is pushed automatically first, so it has a document to share. Sharing is *not* on the status-bar item — that only reports sync state.

The panel offers:

- **Visibility** — **Private** (only you and people you add), **Organization** (everyone in your Huma org, at a role you choose), or **Public** (anyone with a non-guessable link; a **Copy** button gives you the URL — un-publishing rotates the link).
- **People** — add collaborators by name/email (typeahead) and set each to **Editor**, **Commenter**, or **Viewer**; remove with the per-row **×**. Only the note's owner can change sharing; for everyone else the panel is read-only.

Changes apply immediately. The plugin mirrors the current state into read-only frontmatter — `huma_visibility`, `huma_shared_with` (collaborator count), and `huma_public_url` (when public) — so a note's sharing is visible at a glance. Editing these keys by hand does nothing: the server is authoritative and the mirror refreshes when you next open the panel. Requires a Huma backend that exposes the `/api/vault/share` endpoint.

### Share a folder

Right-click a folder → **"Share folder on Huma…"** to set a *standing rule* for everything in it: a visibility and a set of people, applied to every synced note under the folder (subfolders included; excluded folders are skipped). Notes that haven't synced yet are pushed first so they have something to share, and notes you don't own are skipped — the result summary reports "shared X; skipped Y you don't own".

The rule is persistent and lives on this device. After each sync it is re-applied to **newly-synced notes** in the folder, so files you add later are shared automatically. This pass is add-only: a note you later adjust individually is left as-is. Re-opening the panel and editing the rule re-applies it to *every* note in the folder — with a confirmation first if the edit would reduce access (narrower visibility, or a removed/downgraded person).

Deleting a folder rule (from the panel, or **Settings → Shared folders**) stops auto-sharing new notes; notes already shared keep the access they have. Because a vault folder isn't a Huma entity, there is no server-side "shared folder" — this is a client-side rule that fans the per-note sharing out for you.

## Conflict resolution

When a local edit and a remote edit can't be cleanly three-way merged, the plugin emits a sibling `<basename>.conflict.md` file containing both bodies separated by git-style markers:

```
<<<<<<< local
…your local edits…
=======
…the server's version…
>>>>>>> server
```

The original file is replaced with the server's body so live state on disk matches the server until you reconcile. Use the **Huma Vault Sync: Resolve conflicts** command (open the command palette and search for "Resolve conflicts") to walk through outstanding conflicts; once you've reconciled the original and deleted the `.conflict.md` sibling, the next push goes through cleanly.

Three other states surface their own resolution modals:

- **Stale local deletions** — a file the local manifest tracks is missing from disk while the server entry is still live. Click the status bar (or a `stale_local_delete` row in **Show sync log**) to open **Resolve stale deletions**, then pick **Restore** (re-pull the file from the server) or **Ignore** (suppress the warning; the warning auto-clears if you later archive the file in the Huma web app).
- **Server-deleted files awaiting review** — the server has archived a file the local vault still holds. Pick **Delete locally** (file goes to your OS trash, respecting Obsidian's deletion preference) or **Keep locally** (strips `huma_uuid` from frontmatter so the local copy stops re-pushing).
- **Duplicate files** — two or more vault files share the same `huma_uuid` (typically a corrupted import or copy/paste). Sync is paused for that UUID. Pick **Keep this one** on the file that should stay linked; the others have their `huma_uuid` stripped and re-sync as new files on the next cycle, with their current contents.

All three modals are documented end-to-end in [docs/CONFLICT-MATRIX.md](./docs/CONFLICT-MATRIX.md).

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
