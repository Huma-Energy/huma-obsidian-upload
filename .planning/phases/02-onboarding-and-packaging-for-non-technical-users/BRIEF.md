---
phase: 02-onboarding-and-packaging-for-non-technical-users
type: brief
status: ready-to-plan
---

# Phase 2 Brief: Onboarding and packaging for non-technical users

## Context

First real users land tomorrow (2026-05-03). Today's install + first-run experience was built for the developer of the plugin and assumes:

- Familiarity with BRAT (the beta sideload tool)
- Knowledge of the Obsidian command palette
- Reading short ephemeral Notices in the corner of the screen
- Understanding that disabling a plugin doesn't always mean credentials are forgotten

A semi-non-technical user — someone who uses Obsidian for personal notes but has never sideloaded a plugin or seen an OAuth device flow — drops out at every one of those steps. This phase closes the four highest-leverage gaps before the user list expands.

## In scope

1. **Token cleanup on disable.** Hook the plugin's `onunload` lifecycle to clear `data.tokens` so disabling the plugin (Settings → Community plugins → toggle off) does not leave OAuth access/refresh tokens at rest in `data.json`. Conservative scope: only tokens are cleared; `manifest`, `auditRing`, `lastSince`, `pendingServerDeletes`, `ignoredStaleIds` are all preserved so re-enabling resumes the user's sync state without a full re-pull. The existing **Reset local sync state** command (palette-only, unchanged) is the path to wipe everything.

2. **Sign-in modal replacing the device-flow Notice.** Today the device user-code surfaces via `new Notice(..., 6000)` for ~10 s with no way to copy the code, no progress indicator, and no error recovery beyond starting over. Replace with a persistent modal that:
   - Shows the user code in a large, copyable element
   - Has a **Copy code** button (uses `navigator.clipboard`)
   - Has an **Open browser** button (uses the verification URL from the device-flow response)
   - Shows poll progress (every poll tick) and the `expires_in` countdown
   - Shows error states: `slow_down`, `expired_token`, `access_denied`, network errors — each with actionable recovery copy
   - Stays open until poll succeeds, errors out, or the user cancels. Closes automatically on success.

   The modal is reused by the welcome modal (plan 02-03) and the standalone **Sign in** command (`src/main.ts:425`). One UI, two entry points.

3. **First-run welcome modal.** Auto-opens on plugin enable when both conditions hold:
   - `data.tokens === null`
   - `data.welcomeSeenAt` is absent (new persisted field)

   Steps inside the modal:
   - **Step 1 — Server URL.** Default `https://humagreenfield.netlify.app` is shown read-only with an "Advanced settings" disclosure. Disclosure expands a text input pre-filled with the default; user can change it. Explained in one short sentence: "This is where your notes will sync. Most users should leave this as is."
   - **Step 2 — Sign in.** Triggers the device-flow + opens the sign-in modal (plan 02-02). The welcome modal blocks behind the sign-in modal; on success it advances. On cancel/error it stays on Step 2.
   - **Step 3 — First sync.** After successful sign-in, runs `runFullSync()` and shows the result inline ("Synced N files from your vault" or "No files to sync yet — open a note to get started"). Closes the modal. Sets `data.welcomeSeenAt = new Date().toISOString()` and persists.

   The welcome-seen flag persists across plugin reloads. Sign-out does NOT clear it (we don't want to re-onboard a returning user). Reset-local-sync-state DOES clear it (full reset means re-onboard).

4. **Settings reorder + inline help + default URL change + README icon.**
   - Reorder fields in `HumaSettingsTab.display()` to: Authentication → Sync now → Server base URL → Sync interval → Excluded folders → Obsidian Sync conflict (existing) → Sync log.
   - Each setting's `setDesc()` is rewritten in plain language. Today's descriptions are accurate but engineer-prose ("delta-mode reconcile", "manifest snapshot", "exponential backoff"). Target a non-engineer who has never read this codebase.
   - Change `DEFAULT_SETTINGS.serverBaseUrl` in `src/settings.ts` from `https://huma.energy` to `https://humagreenfield.netlify.app`. No migration required (no existing users today). Existing users with a stored override keep it via `mergeData` precedence — flagged in the SUMMARY.
   - Copy `huma-webicon.png` (repo root) → `assets/icon.png`. Reference at the top of `README.md` as a centered HTML img tag (~96px wide). NOT referenced anywhere in `src/` (no `addRibbonIcon` change, no modal header change, no settings tab change).

## Out of scope (explicit deferrals)

- **Obsidian community registry submission.** Process change taking weeks of external review (PR to `obsidianmd/obsidian-releases`). Track separately.
- **Mobile install UX docs / video.** Worth a separate phase once we have a real device test pass.
- **Demo gif / additional screenshots in the README.** Icon-only for now.
- **Onboarding for existing users (a tour for users who already have tokens).** The welcome modal only fires on truly fresh state.
- **Confirm modal on `Reset local sync state`.** User explicitly chose to keep the command palette-only without a guard.
- **Server URL migration for existing users.** No users today; not needed.

## Constraints and conventions

- All NEW source files (TypeScript) must include the project's 5-line file-purpose header per `CLAUDE.md`.
- Tabs for indentation per `.editorconfig`.
- Named exports only; no default exports (except the existing `HumaVaultSyncPlugin` default in `src/main.ts`).
- Type-only imports use `import type`.
- Sentence-case UI text (eslint rule `obsidianmd/ui/sentence-case`). Product names like "Obsidian Sync" or "Huma" are exempt.
- Never run git commands without explicit user permission per `CLAUDE.md`. Each plan presents diffs for review at the end.
- Never include "Co-Authored-By: Claude" in any commit message.
- After every code change: `npm run build && npm run lint && npm test` must exit 0.

## User journey after Phase 2

1. User installs BRAT in Obsidian, then adds the plugin URL.
2. User enables the plugin.
3. **Welcome modal opens** showing a single CTA (Sign in) and the server URL behind an Advanced disclosure.
4. User clicks Sign in. **Sign-in modal opens** with the code, Copy button, Open browser button, and progress indicator.
5. User completes browser flow. Sign-in modal closes automatically.
6. **Welcome modal advances to "Synced N files".** User dismisses.
7. Status bar shows `idle`. Clicking it triggers `Sync now`.
8. User later disables the plugin. Their tokens are cleared from `data.json`. Sync state preserved for re-enable.

## References

- `src/main.ts:425` — current `Sign in` command and device-flow caller
- `src/main.ts:onload` — registration site for the welcome-modal trigger
- `src/main.ts:onunload` — registration site for token cleanup
- `src/settings.ts:DEFAULT_SETTINGS` — default server URL location
- `src/ui/settings-tab.ts` — field reorder + inline help target
- `huma-webicon.png` — source of the registry/BRAT icon
- README.md — header insertion point for the icon
