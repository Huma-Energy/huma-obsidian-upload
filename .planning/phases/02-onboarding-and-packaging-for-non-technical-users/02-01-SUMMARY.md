# Plan 02-01 Summary

## Outcome

Token cleanup on disable shipped. `onunload` now clears `data.tokens` (only) and persists via `saveAll` before the plugin instance is destroyed.

## Diff

`src/main.ts`: +12 / -2 lines (one method body replaced).

```typescript
// Obsidian's Plugin types declare onunload as `void`-returning, but the
// runtime awaits the result if a Promise is returned. Returning a
// Promise is the correct pattern here: we need saveAll to finish before
// the plugin instance is destroyed, otherwise the cleared-tokens state
// can be lost.
// eslint-disable-next-line @typescript-eslint/no-misused-promises
async onunload(): Promise<void> {
    this.stopPolling();
    if (this.data.tokens !== null) {
        this.data.tokens = null;
        await this.saveAll();
    }
}
```

## Acceptance criteria

| Criterion | Result |
|---|---|
| `async onunload(): Promise<void>` present | ✓ |
| `this.data.tokens = null` inside onunload | ✓ |
| `await this.saveAll()` inside onunload | ✓ |
| `npm run build` exit 0 | ✓ |
| `npm run lint` exit 0 | ✓ (after eslint-disable-next-line for @typescript-eslint/no-misused-promises) |
| `npm test` exit 0 (113/113) | ✓ |

## Manual verification

Pending — requires user toggle-off / toggle-on cycle in Obsidian. The automated checks confirm the code path is correct; the manual verification confirms `data.json`'s `tokens` field clears on disable while every other field is preserved.

## Deviations

**Lint suppression on the async signature.** Obsidian's Plugin TypeScript declarations type `onunload(): void`, but the runtime calls `await Promise.resolve(plugin.onunload())` so a Promise return is awaited correctly. The eslint rule `@typescript-eslint/no-misused-promises` flags this as a type mismatch; suppressed on this single line with a comment explaining why. Alternative was a fire-and-forget `void (async () => { ... })()` pattern, rejected because Obsidian could destroy the plugin instance mid-write and lose the cleared state.

## Files changed

- `src/main.ts` — onunload body
