---
status: testing
phase: 02-onboarding-and-packaging-for-non-technical-users
source:
  - 02-01-SUMMARY.md
  - 02-02-SUMMARY.md
  - 02-03-SUMMARY.md
  - 02-04-SUMMARY.md
started: 2026-05-02T12:18:00Z
updated: 2026-05-02T12:18:00Z
---

## Current Test

number: 1
name: Cold Start Smoke Test (Phase 2 surfaces)
expected: |
  Plugin loads without console errors after the Phase 2 changes. Status
  bar populates correctly. data.json was just edited to clear tokens
  + welcomeSeenAt; on plugin enable the welcome modal should auto-open.
awaiting: user response

## Tests

### 1. Cold Start Smoke Test (Phase 2 surfaces)
expected: |
  After the data.json edit (tokens=null, welcomeSeenAt=null), reload the
  plugin (Settings → Community plugins → toggle off, then back on, OR
  quit + reopen Obsidian). Plugin loads without console errors. The
  welcome modal opens automatically.
result: [pending]

### 2. Welcome modal Step 1 — server URL and Advanced disclosure
expected: |
  Welcome modal Step 1 shows:
  - Heading "Welcome to Huma Vault Sync"
  - Tip text "Your notes will sync to the Huma dashboard. Let's get you connected."
  - A centered card showing "SERVER" label and the URL value (default
    https://humagreenfield.netlify.app, or whatever your stored value is)
  - An "Advanced settings" disclosure that expands to reveal a Server URL
    text input
  - Footer with "Skip for now" and "Continue" (CTA) buttons
result: [pending]

### 3. Welcome modal Step 2 — Sign in
expected: |
  Click Continue. Step 2 shows:
  - Heading "Sign in"
  - Tip text mentioning the browser flow
  - Footer with "Skip for now" and "Sign in" (CTA) buttons
  Click Sign in. Step 2's contentEl empties briefly, then the SignInModal
  opens (this is the modal owned by 02-02; you tested its mechanics
  separately if you want — within the welcome flow it's the same UI).
result: [pending]

### 4. Sign-in modal — code display and actions
expected: |
  Sign-in modal shows:
  - Heading "Sign in to Huma"
  - Tip text "Confirm sign-in in your browser…"
  - User code in a large monospaced box (centered, bold, e.g. ABCD-1234)
  - Two buttons: "Copy code" (CTA) and "Open browser"
  - Status line "Waiting for confirmation in your browser…"
  - Expiry countdown ("Code expires in 9:42") that ticks down each second
  - Footer "Cancel" button
  Browser opens automatically to the verification URL.
result: [pending]

### 5. Sign-in modal — Copy code button
expected: |
  Click "Copy code". A short Notice appears: "Huma: code copied." Paste
  into another text field (e.g. a TextEdit window) — the user code is
  in the clipboard.
result: [pending]

### 6. Sign-in modal — Open browser button
expected: |
  Click "Open browser". Your default browser opens (or focuses) to the
  verification URL. (If the auto-open at modal start was blocked, this
  is the recovery path.)
result: [pending]

### 7. Sign-in modal — successful sign-in
expected: |
  Complete the device-flow in your browser. Within a few seconds, the
  sign-in modal closes automatically. The welcome modal advances to
  the "Connecting Huma…" interstitial briefly, then to Step 3.
result: [pending]

### 8. Welcome modal Step 3 — first-sync result
expected: |
  Step 3 shows:
  - Heading "You're connected"
  - One of three messages depending on your vault state:
    - "Synced N action(s). The status bar at the bottom-right shows…"
    - "No files to sync yet. Open or create a note in this vault…"
    - (or an error message if the first sync failed)
  - Footer with "Get started" CTA button
  Click "Get started". Modal closes. Status bar transitions to idle
  (or conflict if there are stale entries / duplicates from a prior
  session).
result: [pending]

### 9. Welcome modal does NOT reopen on next enable
expected: |
  Reload the plugin (toggle off / on). The welcome modal does NOT
  reopen — welcomeSeenAt was persisted in Step 3. data.tokens was
  cleared by the disable lifecycle (per 02-01) but welcomeSeenAt
  should still be the ISO timestamp from your "Get started" click.
  Status bar shows "signed-out" with the log-in icon. To re-test the
  welcome modal you'd run "Reset local sync state" from the palette,
  which clears welcomeSeenAt.
result: [pending]

### 10. Disable clears tokens, preserves rest
expected: |
  After successful sign-in (Step 7+), disable the plugin (toggle off).
  Open data.json — `tokens` is `null`. Other fields preserved:
  `manifest` array still has your synced files, `auditRing` has events,
  `welcomeSeenAt` keeps the ISO timestamp. Re-enable: signed-out state,
  no welcome modal.
result: [pending]

### 11. Skip path keeps welcome modal recurrent
expected: |
  Setup: edit data.json again (tokens=null, welcomeSeenAt=null).
  Reload → welcome modal opens.
  Click "Skip for now" at Step 1 (or Step 2 — either works).
  Modal closes. Reload plugin again. Welcome modal opens AGAIN
  (welcomeSeenAt is still null because Skip doesn't persist it).
result: [pending]

### 12. Settings tab field order
expected: |
  Open Settings → Huma Vault Sync. Field order top to bottom:
  1. Authentication (Sign in / Sign out)
  2. Sync now
  3. Server base URL
  4. Sync interval (seconds)
  5. Excluded folders
  6. (Disable Obsidian Sync — only if Obsidian's core Sync plugin is enabled)
  7. Sync log
result: [pending]

### 13. Settings tab plain-language descriptions
expected: |
  Each setting's description reads in plain language (no jargon like
  "delta-mode reconcile" or "manifest snapshot"). Confirm by skimming
  each row's grey description text.
result: [pending]

### 14. Default server URL fresh install
expected: |
  Fresh-install behavior: if data.json is wiped entirely (delete the
  file or `tokens: null` AND `settings: {}`), on plugin enable the
  Server base URL setting shows `https://humagreenfield.netlify.app`
  by default. (You don't have to do this test if your data.json
  already has a stored URL — settings are preserved per mergeData.)
result: [pending]

### 15. Icon in README header (automated)
expected: |
  README.md contains <img src="./assets/icon.png" near the top.
  assets/icon.png exists and is non-empty. No src/*.ts file
  references the icon.
result: pass
evidence: "assets/icon.png exists (5423 bytes); README.md has 1 reference; grep -rn 'assets/icon.png' src/ returned 0 matches; grep -rn 'huma-webicon.png' src/ returned 0 matches."

### 16. Build + lint + tests all green (automated)
expected: |
  npm run build && npm run lint && npm test all exit 0.
  113 tests passing.
result: pass
evidence: "npm test: 14 test files, 113 passed. build + lint exit 0."

### 17. Public surfaces unchanged in src/ (automated)
expected: |
  No new src/ references to assets/icon.png. Ribbon icon, status bar,
  modal headers all unchanged from Phase 1's icon discipline.
result: pass
evidence: "Only existing addRibbonIcon('refresh-cw', ...) at src/main.ts:106 and setIcon() in status-bar.ts:53 use Lucide names. No icon.png usage in src/."

## Summary

total: 17
passed: 3
issues: 0
pending: 14
skipped: 0

## Gaps

[none yet]
