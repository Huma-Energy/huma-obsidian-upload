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

## Cold-launch checklist

- [ ] Plugin loads — status bar shows `Huma: signed out` within 2 s of vault
      open. No console errors visible via Obsidian's built-in error toast.
- [ ] Open settings → Huma Vault Sync. The Sign in button is visible; the
      sync-interval slider is functional (visual feedback when dragging).
- [ ] Tap Sign in. The device-flow URL opens in Safari (iOS) / Chrome
      (Android) — Obsidian backgrounds; the browser foregrounds.
- [ ] Confirm the device code in the browser. Return to Obsidian (swipe back
      or app switcher). Within ~30 s the status bar shows `Huma: ⟳ syncing`,
      then `Huma: ✓ just now`.

## Sync-cycle checklist (after sign-in)

- [ ] Edit any markdown file locally; wait 5 s. The status bar transitions to
      syncing → idle. Push reaches the server (verify via dashboard).
- [ ] Edit a file in the dashboard's web editor, then return to Obsidian and
      pull-to-refresh / re-foreground the app. The status bar transitions to
      syncing within 5 s of foreground; the local file matches the dashboard.
- [ ] Background Obsidian for >30 s. On foreground the
      `active-leaf-change` event triggers a sync without a manual command.
- [ ] Trigger a divergent edit (edit same file on both sides during airplane
      mode). On reconnect, the push returns `merge_dirty`; verify a
      `*.conflict.md` sibling appears and the original holds the server's body.
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

- [ ] Tap Sign out. The status bar reverts to `Huma: signed out` within
      1 s. Inspect the plugin's `data.json` (via the OS file manager on
      desktop, or via export-vault on mobile) — `tokens` is `null`, the
      manifest is empty, the audit ring is preserved.

## Token-leak invariant

- [ ] After sign-in, paste the access token (copy out of `data.json`) into
      a vault note. Re-launch the plugin. The status bar should show
      `Huma: ⛔ blocked` and a 0-timeout Notice points to the offending file.
      Removing the token and re-launching restores normal operation.

## Performance targets

- [ ] Cold-launch sync of a 100-file vault on cellular completes within 30 s.
- [ ] Reconcile pass over a 1,000-file vault completes within 10 s on
      mid-range mobile hardware (Pixel 6 / iPhone 13 baseline).

## Known caveats

- `setInterval`-based polling is disabled on mobile (per `Platform.isMobile`)
  to preserve battery. Mobile users sync on foreground resume + manual
  Sync now command.
- Obsidian's `app.vault.cachedRead` returns the indexed copy of a file. The
  scanner uses this rather than `read` so iOS's IO budget isn't blown on
  large vaults.
- The plugin uses `crypto.subtle.digest("SHA-256", …)` (Web Crypto), not
  `node:crypto`. Capacitor WebView does not expose Node modules; subtle is
  universal.
