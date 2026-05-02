# Mobile QA checklist

Manual verification pass for iOS Obsidian and Android Obsidian. Run before each
release tag — the desktop CI build doesn't catch sandbox-only regressions
(Capacitor WebView doesn't expose `node:crypto`, Electron-only modules, or
Node `fs`).

## Setup

- **iOS**: install the plugin into a vault on macOS, then sync the vault to the
  iOS device via [Working Copy](https://workingcopyapp.com/) or iCloud Drive.
  Open the vault in Obsidian for iOS; enable the plugin under
  Settings → Community plugins. (The plugin is desktop-on-mobile-on by way of
  `isDesktopOnly: false` in `manifest.json`.)
- **Android**: install via BRAT directly, or copy the plugin folder into
  `<vault>/.obsidian/plugins/huma-vault-sync/` over USB / SAF.

> **Status-bar items are not supported on Obsidian mobile.** All state
> feedback that the desktop status bar provides is reached on mobile via a
> ribbon icon (sync icon at the left edge of the editor) that opens the
> **Huma sync** modal. The modal shows current state and offers
> **Sync now**, **Resolve conflicts** (when applicable), and **Show sync log**.
> Where the desktop checklist below would say "the status bar shows X",
> the mobile equivalent is "open the modal — it shows X".

## Cold-launch checklist

- [ ] Plugin loads within 2 s of vault open. No console errors visible via
      Obsidian's built-in error toast. The Huma sync ribbon icon is present.
- [ ] Tap the ribbon icon. The modal opens and shows `Not signed in. Open
      the plugin settings to sign in.`
- [ ] Open Settings → Community plugins → Huma Vault Sync. The Sign in
      button is visible; the sync-interval slider is functional (visual
      feedback when dragging).
- [ ] Tap Sign in. The device-flow URL opens in Safari (iOS) / Chrome
      (Android) — Obsidian backgrounds; the browser foregrounds.
- [ ] Confirm the device code in the browser. Return to Obsidian (swipe back
      or app switcher). Tap the ribbon icon — the modal shows
      `Syncing — N action(s) pending.` and then `Idle. Last synced …`.

## Sync-cycle checklist (after sign-in)

- [ ] Edit any markdown file locally; wait 5 s. Re-open the modal; it shows
      idle with a recent timestamp. Push reaches the server (verify via
      dashboard).
- [ ] Edit a file in the dashboard's web editor, then return to Obsidian and
      pull-to-refresh / re-foreground the app. Within 5 s of foreground a
      sync runs; the local file matches the dashboard.
- [ ] Background Obsidian for >30 s. On foreground the
      `active-leaf-change` event triggers a sync without a manual command.
- [ ] From the ribbon modal, tap **Sync now**. A sync cycle runs; the modal
      reflects the new state on next open.
- [ ] Trigger a divergent edit (edit same file on both sides during airplane
      mode). On reconnect, the push returns `merge_dirty`; verify a
      `*.conflict.md` sibling appears and the original holds the server's body.
- [ ] Re-open the modal. It shows `N unresolved conflict(s); 0 stale local
      deletion(s).` and a **Resolve conflicts** button. Tap it; Obsidian
      opens the next conflict file.
- [ ] Open the conflict file in mobile Markdown view. The git-style markers
      (`<<<<<<< local` / `=======` / `>>>>>>> server`) render legibly.

## Rename checklist (task 11 verification)

- [ ] Rename a vault file via Obsidian's file browser. Wait for the next sync
      cycle. The dashboard's web view shows the new path; the same UUID is
      retained server-side (visible via dashboard audit log).
- [ ] Rename a file simultaneously on both sides to different new names. The
      server resolves to the path most recently written; surface a conflict
      file if bodies also diverged.

## Sign-out checklist

- [ ] Tap Sign out. Re-open the ribbon modal — it shows the
      `Not signed in.` state. Inspect the plugin's `data.json` (via the OS
      file manager on desktop, or via export-vault on mobile): `tokens` is
      `null`; **manifest, lastSince, and audit ring are preserved** so a
      subsequent sign-in is a fast no-op rather than a full vault rehash.
- [ ] Run the **Reset local sync state** command from the palette. Inspect
      `data.json`: manifest, lastSince, and audit ring are now empty.

## Token-leak invariant

- [ ] After sign-in, paste the access token (copy out of `data.json`) into
      a vault note. Re-launch the plugin. A 0-timeout Notice points to the
      offending file. The ribbon icon's modal shows the blocked state.
      Removing the token and re-launching restores normal operation.

## Performance targets

- [ ] Cold-launch sync of a 100-file vault on cellular completes within 30 s.
- [ ] Reconcile pass over a 1,000-file vault completes within 10 s on
      mid-range mobile hardware (Pixel 6 / iPhone 13 baseline).

## Known caveats

- Obsidian does not support custom status-bar items on mobile, so the plugin
  registers a ribbon icon + modal for state feedback instead. The desktop
  status bar item is registered only when `!Platform.isMobile`.
- `setInterval`-based polling is disabled on mobile (per `Platform.isMobile`)
  to preserve battery. Mobile users sync on foreground resume + the
  **Sync now** button in the ribbon modal (or the Sync now command).
- Obsidian's `app.vault.cachedRead` returns the indexed copy of a file. The
  scanner uses this rather than `read` so iOS's IO budget isn't blown on
  large vaults.
- The plugin uses `crypto.subtle.digest("SHA-256", …)` (Web Crypto), not
  `node:crypto`. Capacitor WebView does not expose Node modules; subtle is
  universal.
- HTTP requests use Obsidian's `requestUrl` (Electron net on desktop,
  native on mobile). No `fetch`, no CORS preflight.
