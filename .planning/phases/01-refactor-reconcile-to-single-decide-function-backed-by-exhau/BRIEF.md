# Phase 1 Brief: Refactor reconcile to single decide() function

Captured 2026-05-01. Source: dispatch from /gsd-do via /gsd-add-phase. Read this before /gsd-plan-phase 1.

## Why this phase exists

The `src/sync/reconcile.ts` module has accumulated bugs along the same fault line:

- **Bug 1 (Pass 2 over-skip)** — Pass 2 was re-pushing every locally-known UUID every cycle because the server delta hides unchanged files. Fix: skip if `localById.has(uuid)`. Live impact: ~36 spurious `push_accept` events per cycle on the user's vault.
- **Bug 3 (Pass 2 over-skip with local divergence)** — Bug 1's fix was too aggressive. Locally edited or renamed files in delta-mode also hit Pass 2 with `localById.has(uuid) === true` and silently no-op'd. Live repro: `AnotherTest.md` was created at `Untitled.md`, then renamed and edited; plugin reported "synced" while the edits never reached the server. Fix: synthesize server entries from the local manifest for delta-omitted UUIDs and route through Pass 1 uniformly.
- **Three-way mismatch sub-matrix row drift** — The matrix said one thing; the code did another. The doc was wishful, not enforced.

Each bug was the same architectural mistake: three passes (Pass 1 over server, Pass 2 over scan-with-uuid, Pass 3 over scan-no-uuid) with overlapping semantics, and a documentation matrix that wasn't enforced as code.

## Reference: how established sync systems handle this

- [vrtmrz/obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync) — CouchDB MVCC, operation-based with revision IDs.
- [remotely-save/remotely-save](https://github.com/remotely-save/remotely-save) — closest to our model. State-based with timestamps + content hashes. Uses unified decision logic, not multi-pass dispatch.
- [kevinmkchin/Obsidian-GitHub-Sync](https://github.com/kevinmkchin/Obsidian-GitHub-Sync) — delegates everything to Git; ~200 SLOC. Not a comparison point because we don't have Git server-side.

We are state-based with UUIDs and a delta cursor. The bugs aren't in the model; they're in the implementation structure.

## What this phase delivers

1. **`decide(server: ManifestEntry | null, local: ManifestRecord | null, scan: ScannedFile | null): SyncAction | null`** — pure function in `src/sync/reconcile.ts`. Encodes every cell of the master matrix (8 presence permutations) + sub-matrix #6 (4 booleans: pathsAlign, scanPathMatchesLocal, serverNewer, localEdited).
2. **Dispatch loop** that iterates the **union of UUIDs** across (`serverManifest`, `localManifest`, `scannedByUuid`). Calls `decide` per UUID. Trivial separate loop for `scannedNoUuid` → adds. **No Pass 2 or Pass 3 left.**
3. **Property-test fixture** in `tests/sync/reconcile.test.ts` that enumerates every cell of CONFLICT-MATRIX.md and asserts `decide`'s output. Adding a column forces a fixture update; the test catches drift before it ships.
4. **CONFLICT-MATRIX.md "Verification matrix"** cites the property test for every cell. Doc derivable from the fixture, not parallel.

## Acceptance criteria

- All 92 existing tests pass.
- Property test covers all master-matrix rows (#1-#8), all sub-matrix #6 cells (8 boolean combinations), and the duplicate-`huma_uuid` + synthetic-server-entry behaviors.
- **Verify-by-deletion test**: temporarily remove the `localById` skip OR the synthetic-server-entry promotion; the property test must fail. (Don't commit the deletion — verify and revert.)
- Build, lint, test all green; `main.js` + `styles.css` copied to `/Users/steffen/Projects/huma/Documentation/documentation-library/sources/.obsidian/plugins/huma-vault-sync/`.

## Out of scope

- No architecture change (still state-based with UUIDs and delta cursor).
- No operation-log semantics (would require server-side cooperation).
- No orphan auto-recovery command (e.g. for `a5b7e117` / `testklp.md`) — separate phase later.
- No new audit events.

## Constraints (project conventions, see CLAUDE.md)

- npm only.
- TypeScript target es2018, strict, noUncheckedIndexedAccess.
- 5-line file-purpose header on new files; do not delete existing headers.
- HTTP via Obsidian's `requestUrl`, never `fetch` (lint-enforced).
- Body writes via `Vault.process`; frontmatter via `FileManager.processFrontMatter`.
- Manifest hashes use `sha256(parseFile(stringifyFile(body, fm)).body)`, never raw body.
- Never run git commands without explicit user permission.
- Never include "Co-Authored-By: Claude" in commits.

## Estimate

Half a day, focused. ~150 lines of current reconcile become ~80 lines `decide` + ~30 lines dispatch + ~150 lines property-test fixture.

## Codebase context

Just-completed map in `.planning/codebase/`:

- `ARCHITECTURE.md` — three-pass structure documented end-to-end with the synthetic-server-entry promotion.
- `CONCERNS.md` — this refactor is the top-listed concern.
- `TESTING.md` — Vitest + `__mocks__/obsidian.ts` pattern, 92-test baseline.
- `CONVENTIONS.md` — parsed-back-body hash invariant, 5-line header rule.
- `docs/CONFLICT-MATRIX.md` — the spec the property test must enforce.
