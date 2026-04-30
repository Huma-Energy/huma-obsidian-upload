# Security policy

This plugin sits between an Obsidian vault and the Huma dashboard's vault API. It handles OAuth access and refresh tokens, scans every markdown file in the vault on startup, and writes back to the vault. Issues that compromise tokens, leak file contents, or let a hostile server escape vault root are taken seriously.

## Reporting a vulnerability

Please report suspected vulnerabilities privately:

- **Email:** security@huma.energy
- **Subject:** `[huma-vault-sync] <short summary>`

Do **not** open a public GitHub issue, gist, or PR for a security finding. Public reports give attackers a window before a fix ships.

In your report, please include:

- A short description of the issue and its impact.
- Steps to reproduce (a minimal vault layout, sequence of actions, or test case is ideal).
- The plugin version (`manifest.json` `version` field), the Obsidian version, and the platform (macOS / Linux / iOS / Android).
- Whether the issue affects only the plugin or also the server-side vault API. Server-side issues are routed to the dashboard team.

We aim to acknowledge reports within **3 business days** and to ship a fix or mitigation for confirmed vulnerabilities within **30 days**, faster for active exploitation. We will credit reporters in the release notes unless you prefer to remain anonymous.

## Supported versions

Only the latest pre-release version is supported. Beta users on older versions should update through BRAT. Once the plugin reaches v1.0, the most recent two minor releases will be supported.

## Security model

- **Tokens never enter the vault.** Access and refresh tokens are stored exclusively in Obsidian's plugin data (`<vault>/.obsidian/plugins/huma-vault-sync/data.json`). They are never written into a vault file.
- **Startup invariant.** When the plugin loads with at least one stored token, it scans every markdown file in the vault for token-shaped strings (≥40 char base64url runs). If any string exactly equals the stored access or refresh token, the plugin refuses to start and emits a 0-timeout Notice naming the offending file. Heuristic-only matches (token-shaped but not equal to a stored token) are surfaced as a warning rather than a block, to avoid false positives on legitimate user content (UUIDs concatenated with hashes, embedded keys for unrelated services). Before first sign-in there is no stored token to compare against, so the scan is skipped.
- **Token rotation.** The plugin uses ZITADEL's device-authorization grant. Refresh tokens rotate per server policy; the `TokenManager` swaps both tokens atomically on refresh.
- **Server paths are normalized.** Every path returned by the server is run through Obsidian's `normalizePath` before any vault operation, defending against traversal attempts and platform-mixed slashes.
- **Atomic writes.** Body changes use `Vault.process`; frontmatter changes use `FileManager.processFrontMatter`. This avoids races with other plugins modifying the same file and matches Obsidian's plugin guidelines.
- **No `fetch`.** All HTTP traffic goes through Obsidian's `requestUrl` (Electron `net` on desktop, native on mobile). This avoids CORS preflight and keeps the plugin to the documented network surface.

## Scope

In scope for this disclosure policy:

- The plugin code in this repository (`src/**`, `manifest.json`, `styles.css`).
- The plugin's interaction with the vault, plugin data store, and Obsidian APIs.
- The plugin's authentication flow against the Huma dashboard.

Out of scope (route to the appropriate team):

- The Huma dashboard server and its vault API. Report those to the same address with `[huma-dashboard]` in the subject; the report will be forwarded.
- ZITADEL itself. Report upstream at https://zitadel.com/security.
- Obsidian itself. Report upstream at https://obsidian.md/security.

## Out-of-scope findings

Unless they enable a real attack against tokens, vault contents, or the user's machine, the following are not treated as vulnerabilities:

- UI inconsistencies, sentence-case lint findings, missing keyboard shortcuts.
- Issues that require physical access to an unlocked device.
- Self-XSS via the user pasting attacker-controlled content into their own vault.
- Theoretical issues without a working proof of concept.
