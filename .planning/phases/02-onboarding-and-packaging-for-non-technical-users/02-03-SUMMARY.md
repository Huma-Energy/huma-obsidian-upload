# Plan 02-03 Summary

## Outcome

First-run welcome modal shipped. Auto-opens on enable when both `data.tokens === null` and `data.welcomeSeenAt === null`. Three-step flow: Server URL (with Advanced disclosure) → Sign in (delegates to `SignInModal` from 02-02) → first-sync result. Step 3's "Get started" button persists `welcomeSeenAt`; Skip and Esc/X paths leave the flag unset so the modal reopens on next enable until the user completes it.

## Files

- **NEW**: `src/ui/welcome-modal.ts` — 235 lines including 5-line file-purpose header.
- `src/settings.ts` — added `welcomeSeenAt: string | null` to `HumaPluginData` + `DEFAULT_PLUGIN_DATA`.
- `src/main.ts`:
  - `mergeData` migration line for `welcomeSeenAt`
  - `resetLocalState` clears `welcomeSeenAt`
  - `startup()` triggers welcome modal when conditions hold
  - new `private openWelcomeModal()` wires up `WelcomeModalDeps`
  - import added for `WelcomeModal`
- `styles.css` — added `.huma-welcome-*` classes for tips, URL display block, advanced disclosure, error copy, footer.

## Diff sizes

- `src/ui/welcome-modal.ts`: +235 (new file)
- `src/settings.ts`: +9 / -1
- `src/main.ts`: +63 / -2 (welcome modal trigger + openWelcomeModal helper + mergeData migration + reset clearance)
- `styles.css`: +50

## Acceptance criteria

| Criterion | Result |
|---|---|
| `welcomeSeenAt: string \| null` in HumaPluginData | ✓ |
| `welcomeSeenAt: null` in DEFAULT_PLUGIN_DATA | ✓ |
| `welcomeSeenAt: stored.welcomeSeenAt ??` migration in mergeData | ✓ |
| `this.data.welcomeSeenAt = null` in resetLocalState | ✓ |
| `export class WelcomeModal extends Modal` with 5-line header | ✓ |
| Step 1 / Step 2 / Step 3 / syncing branches in render | ✓ |
| Welcome modal calls `deps.startSignIn` (delegation) | ✓ |
| Step 3 calls `deps.markWelcomeSeen` | ✓ |
| `new WelcomeModal` in main.ts | ✓ |
| `this.data.welcomeSeenAt === null` gating in startup() | ✓ |
| `private async finishSignIn` shared between standalone signIn and welcome flow | ✓ |
| `npm run build && npm run lint && npm test` all exit 0 (113/113) | ✓ |

## Welcome modal design

**Step 1 — Server URL.** Header "Welcome to Huma Vault Sync". Server URL displayed in a centered block with monospaced value. Advanced disclosure (`<details><summary>`) expands an inline text input that persists keystrokes via `deps.setServerUrl`. Footer: Skip for now / Continue (mod-cta).

**Step 2 — Sign in.** Header "Sign in". Tip text. If a previous attempt errored, displays "Last attempt failed: {message}". Footer: Skip for now / Sign in (mod-cta). Sign in calls `deps.startSignIn(welcomeCallbacks)`. Modal stays mounted but contentEl is emptied during the transition; rendering resumes on success/cancel/error.

**syncing — interstitial.** Shown after sign-in success while `runFirstSync` is awaited. Header "Connecting Huma…" + tip. No buttons.

**Step 3 — You're connected.** Header "You're connected". Body computed from `lastSync`/`lastError`:
- error → "Sign-in worked but the first sync failed: {message}. Click Sync now in settings to retry."
- result with actions → "Synced N action(s). The status bar at the bottom-right shows current state — click it any time to sync again."
- no actions → "No files to sync yet. Open or create a note in this vault and Huma will sync it on the next cycle (every 30 seconds by default)."
- result is null → "Sign-in succeeded. Sync runs automatically in the background — check the status bar at the bottom-right."

Footer: Get started (mod-cta). Calls `deps.markWelcomeSeen()` then closes.

## Plumbing decision

`WelcomeModalDeps.startSignIn` takes a `WelcomeSignInCallbacks` object (onSuccess / onCancel / onError). The plugin's `openWelcomeModal` injects the auth-client deps (`startDeviceFlow`, `poll`) when constructing the SignInModal, and layers the welcome callbacks on top of `finishSignIn`:

```typescript
startSignIn: (welcomeCallbacks) => {
    new SignInModal(this.app, {
        startDeviceFlow: () => this.auth.startDeviceFlow(),
        poll: (id) => this.auth.pollDeviceToken(id),
        onSuccess: async (tokens) => {
            await this.finishSignIn(tokens);   // tokens persist + sync starts
            await welcomeCallbacks.onSuccess(); // welcome advances to step 3
        },
        onCancel: welcomeCallbacks.onCancel,
        onError: welcomeCallbacks.onError,
    }).open();
}
```

This keeps the welcome modal ignorant of auth-client internals while letting the plugin own the `finishSignIn` ordering.

## Reset / disable / sign-out semantics

| Action | welcomeSeenAt | tokens |
|---|---|---|
| Disable plugin | preserved | cleared (02-01) |
| Sign out | preserved | cleared |
| Reset local sync state | cleared | cleared |
| Skip welcome (step 1 or 2) | unchanged (null → null) | unchanged |
| Complete welcome (step 3 → Get started) | set to now() | tokens already set in step 2 |

Re-enable behaviour:
- Returning user (welcomeSeenAt set, tokens null after disable): no modal, signed-out state, command palette / settings tab is the path back in.
- Mid-flow user (welcomeSeenAt null, completed Skip): modal reopens.
- Fresh user (welcomeSeenAt null, never signed in): modal opens.
- Reset user (welcomeSeenAt cleared): modal opens.

## Lint deviations

Three `eslint-disable-next-line obsidianmd/ui/sentence-case` comments for product-name appearances ("Welcome to Huma Vault Sync", "Connecting Huma…", "Click Sign in to authorize…" referencing the button label).

## Manual verification

Pending — user wipes `data.json` (or sets `welcomeSeenAt: null` and `tokens: null` manually), reloads, and walks the full 3-step flow + each Skip/error path.

## Files changed

- `src/ui/welcome-modal.ts` (new)
- `src/settings.ts` (welcomeSeenAt field + default)
- `src/main.ts` (mergeData, resetLocalState, startup() trigger, openWelcomeModal helper, import)
- `styles.css` (welcome modal styles)
