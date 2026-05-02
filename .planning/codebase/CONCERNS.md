# Codebase Concerns

**Analysis Date:** 2026-05-01

## Tech Debt

**Three-pass reconcile structure (`src/sync/reconcile.ts`):**
- Issue: `reconcile()` runs three sequential passes over disjoint partitions of the (server × local × scan) join — Pass 1 over `serverByIdEffective.values()` (`reconcile.ts:187`), Pass 2 over `scannedByUuid` for UUIDs absent from both server and local (`reconcile.ts:329-339`), Pass 3 over `scannedNoUuid` (`reconcile.ts:342-348`). The partition rules (`if (serverById.has(uuid)) continue; if (localById.has(uuid)) continue;`) are the entire data-loss surface area: every bug in this file's history has been "Pass 2 included a UUID it should have excluded, or Pass 1 excluded a UUID it should have handled."
- Files: `src/sync/reconcile.ts:155-348`
- Documented bug history (CHANGELOG.md `[Unreleased]`):
  - **Bug 1 (Pass 2 over-push):** Pass 2 originally treated any locally-known UUID as a "first push" because delta-mode `serverById` excludes unchanged rows. Fix added the `localById.has(uuid)` skip at `reconcile.ts:331`. Live impact was ~36 spurious `push_accept` events per cycle.
  - **Bug 3 (Pass 2 over-skip + delta/local divergence):** the Bug 1 fix made Pass 2 skip *any* locally-known UUID, which is wrong for files the user edited or renamed since the last sync — those UUIDs sit in `localById` but are also absent from delta-mode `serverById`, so they never reconcile. Live repro: file created at `Untitled.md`, renamed and edited, sat unsynced while plugin reported "synced." Fix synthesises a server entry from local manifest state for every locally-tracked UUID delta omitted (`reconcile.ts:172-184`), routing edited/renamed files through Pass 1's existing branches and leaving Pass 2 for true first-push (`serverId: null`) cases only.
  - **Three-way mismatch sub-matrix row:** the `✗ ✗ – –` row in `docs/CONFLICT-MATRIX.md` (concurrent rename-rename to different paths) was wrong against code at one point — `serverRenamed` requires `scanned.path === local.path` (`reconcile.ts:249-252`), so this case bypasses rename-local entirely and the client-side rename wins. Doc now matches but the spec text is hand-maintained, not generated.
- Impact: Reconcile is the data-loss-critical path. Any change to the partition predicates, the synthetic-entry construction, or the Pass 1 branches (rename / edit / stale-delete) can resurrect a silent-skip or silent-overwrite class bug. The history shows two of these regressions shipped already.
- Fix approach: refactor toward a single pass that emits an action per `id` from the union `serverById ∪ localById ∪ scannedByUuid` keyset, with the action chosen by the (presence × edit × version) tuple in one explicit table. Synthetic-server-entry trick is a workaround for the partitioned shape; collapsing the three passes removes both the partition predicates and the synthetic entry. The existing test matrix (`tests/sync/reconcile.test.ts` covers every master-matrix and sub-matrix row plus the regression cases) is sufficient to refactor against.

**Conflict-matrix doc drift (`docs/CONFLICT-MATRIX.md`):**
- Issue: `docs/CONFLICT-MATRIX.md` is the canonical specification of the eight-row master matrix and the sub-matrix #6, but it is plain markdown — not enforced against code, not generated, not lint-checked. Cross-references include line numbers (`reconcile.ts:226`, `reconcile.ts:209-223`, etc.) that the doc itself flags as approximate ("treat them as approximate and search by symbol name", line 199). The three-way mismatch row drifted vs code in the past.
- Files: `docs/CONFLICT-MATRIX.md`, `src/sync/reconcile.ts`
- Impact: Future readers (including the planner / executor agents) treat the doc as authoritative. Drift means agents propose changes against the wrong spec.
- Fix approach: either generate the matrix from a structured source consumed by both the doc and the reconcile dispatch table, or add a contract test that asserts each documented row produces the documented action by feeding fixtures into `reconcile()`. The existing test names already mirror the matrix rows ("master row #2: …", "master row #3: …") so the contract is half-built.

**Body-size pre-flight check (Netlify 5 MiB cap):**
- Issue: Netlify lambdas cap request bodies at 5,242,880 bytes (5 MiB). When a push body exceeds the cap the server returns a size-cap error first, then retries return generic 500s; the push worker (`src/sync/push-worker.ts:103-135`) defers the action and retries it every cycle indefinitely with backoff. Documented as "Server-side limit; client-side pre-flight check queued" in `docs/CONFLICT-MATRIX.md:132`. There is no `MAX_BODY_BYTES` constant, no body-size check in `buildRequest` (`push-worker.ts:137-148`), and no error-classification path to surface "file too large" to the user.
- Files: `src/sync/push-worker.ts:137-148` (request builder, no size check), `docs/CONFLICT-MATRIX.md:132,155`
- Impact: Files >5 MiB silently fail to sync, indistinguishable from network errors in the audit log. User has no UI signal that a specific file is the problem. Currently deferred per user — Netlify migration is upcoming, after which the cap moves or vanishes.
- Fix approach (post-Netlify migration, or earlier if migration slips): add `MAX_BODY_BYTES = 5_242_880` constant; in `buildRequest` reject bodies that exceed it with a typed `BodyTooLargeError`; in `pushOne` treat that error as terminal (do not retry, mark deferred-with-reason); surface in audit as `push_reject` with detail `body too large: NNN bytes > 5,242,880 cap`. The eventual full fix per `docs/CONFLICT-MATRIX.md:155` is chunked upload or presigned-URL flow for >6 MiB.

**Orphaned manifest rows after Pass 2 over-pushes:**
- Issue: When the Bug 1 / Bug 3 over-push regressions were live, Pass 2 emitted `push` actions with `serverId: null` for files whose UUID *was* in the local manifest. The server allocated a new UUID; the manifest then held two rows: the original (orphaned, server has no row matching) and the newly-allocated. Real examples cited by user: `testklp` / `a5b7e117…` paired against `Title.md` / `0e983c07…`. Reconcile cannot tell these apart from any other row whose server row has been tombstoned but the local manifest hasn't caught up — both look like "row in `localById` not in `serverById`." With the synthetic-entry fix in place, the orphan row will now route to Pass 1 with a synthetic server entry equal to its last-known local state, producing a no-op (in-sync) every cycle while the file's *actual* (new) UUID lives on a different row. The orphan never gets dropped.
- Files: `src/sync/reconcile.ts:172-184` (synthetic entry pins the orphan as in-sync), `src/sync/engine.ts:201-223` (only tombstones drop manifest rows)
- Impact: Manifest grows monotonically with one stale row per historical Pass 2 over-push. Each orphan re-fetches a synthetic in-sync no-op every cycle; no functional break, but the manifest is wrong and the row count is misleading. Worse, on a true full-fetch cycle (`firstCycle` or `cyclesSinceFullFetch >= FULL_FETCH_EVERY`, `manifest-fetch-policy.ts:28-30`) the orphan's UUID is genuinely absent from `serverById` (server never had it) — the synthetic entry still fires, so the orphan still no-ops. There is no "this UUID has been gone from a *full* server fetch, drop it" path.
- Fix approach: add an auto-recovery step in the engine. On a full-fetch cycle (`doFullFetch === true` in `engine.ts:109`), any local manifest row whose id is absent from the full fetch result should be dropped with a `manifest_orphan_dropped` audit, before reconcile runs. This is safe because a full fetch is authoritative — absence means the server has no row, tombstoned or live. The synthetic-entry path in reconcile must check the same condition and skip synthesising for known orphans (or run before the orphan drop). Until then, the only recovery is the user running **Reset local sync state** (`main.ts:305-311`), which rebuilds from scratch.

**`lastSince` hides server entries (delta-mode blind spot):**
- Issue: Delta-mode manifest fetch (`?since=lastSince`) returns only rows the server changed inside the window. Rows the server backfilled with timestamps *older* than the persisted `lastSince` (e.g. web-dashboard imports the user has never pulled, post-sign-out where manifest is preserved) would never appear in any subsequent delta response. Without mitigation those rows are invisible to the plugin forever.
- Files: `src/sync/manifest-fetch-policy.ts`, `src/sync/engine.ts:99-119`
- Impact: Mitigated by cold-start full fetch (`firstCycle: true` on every plugin load, `manifest-fetch-policy.ts:13`) and 20-cycle re-baseline (`FULL_FETCH_EVERY = 20`, `manifest-fetch-policy.ts:22`). At default 30 s sync interval that's a ~10 min worst-case gap between when the server backfills a row and when the client sees it. This is the standard delta-sync recovery practice (RFC 6578, Microsoft Graph delta queries, CloudKit, Drive Changes API) and is the right shape, but it remains a known asymmetry: server tombstones propagate faster than backfills.
- Fix approach: `FULL_FETCH_EVERY` is a single tunable; lower it for tighter worst case at the cost of bandwidth. Longer term, the server could expose a `min_updated_at` cursor signaling "any row older than this is included in the delta" so the plugin can detect when its `lastSince` predates a backfill window.

## Known Bugs

**Working tree state at audit time (operational, not a code bug):**
- The audit prompt referenced "13+ uncommitted files in working tree." `git status` at audit time reports the tree is *clean* on branch `claude/huma-obsidian-plugin-WQu5o`, 23 commits ahead of `origin/claude/huma-obsidian-plugin-WQu5o`. Two interpretations: (a) the uncommitted state was resolved between prompt drafting and audit run (the 23 commits ahead suggest staged work was committed locally), or (b) the prompt described a different working tree. Either way, "23 commits unpushed" is itself a state-of-the-world concern for the next refactor — work-in-progress on the reconcile-bug fixes lives only on this local branch.
- Files: n/a (git state)
- Impact: Loss of 23 commits if the local checkout is wiped before push. Branch divergence from any other contributor or CI environment.
- Fix approach: push the branch (`git push`) once the user authorises it; the user has not authorised `git push` per `~/.claude/CLAUDE.md` rules.

**Pull-worker safety cap is `batch.length + 1`:**
- Issue: `pull-worker.ts:88` caps the per-batch retry loop at `initialBatch.length + 1` to defend against a misbehaving server naming `not_found` ids that aren't in the requested batch. The `extractNotFoundId` guard (line 167: `if (!batch.includes(id)) return null`) already rejects foreign ids, so the cap is belt-and-suspenders. Correct, but the cap predates the in-batch guard and could be tightened to `batch.length` once the guard is trusted.
- Files: `src/sync/pull-worker.ts:88,158-169`
- Impact: None at runtime — the loop already breaks on `remaining.length === 0`. Code-clarity debt only.

## Security Considerations

**Token rotation single-flight:**
- `TokenManager.refresh` (`src/sync/token-manager.ts:55-71`) uses a `Promise`-based single-flight (`this.inflight`) so concurrent `getAccessToken()` calls during refresh share one refresh attempt. Unrecoverable error codes (`refresh_token_reused`, `token_reused`, `invalid_grant`, `invalid_token`) clear stored tokens (`token-manager.ts:62-68`), which transitions the plugin to signed-out and stops the polling loop on the next `runFullSync` (`main.ts:323-340`). This is correct.
- Files: `src/sync/token-manager.ts`, `src/main.ts:313-342`
- Mitigations in place: atomic token replacement, single-flight guard, unrecoverable-code handling.
- Outstanding: no per-request `AbortSignal` (Obsidian's `requestUrl` doesn't expose one — documented as out of scope, `docs/CONFLICT-MATRIX.md:157`). In-flight requests run to completion on plugin unload; if a refresh is in flight when the user signs out, the rotation completes and the new tokens are immediately discarded by `signOut`. Not exploitable, but inelegant.

**Vault-token-leak invariant:**
- `scanVaultForTokens` (called from `main.ts:200`) blocks plugin start if any markdown file contains a string equal to a stored access or refresh token; heuristic-only matches surface as a non-blocking warning. The pre-sign-in heuristic-only path runs even with no stored tokens (CHANGELOG fixed entry).
- Files: `src/security/vault-token-scan.ts`, `src/security/token-shape.ts`, `src/main.ts:184-232`
- Mitigations: 0-timeout Notice naming the offending file; `token_scan_warning` audit entry on heuristic match; blocking and signed-out states wired through `renderStatusBar`.
- Outstanding: scan runs once at `onLayoutReady`. A token written into the vault *after* startup (e.g. user pastes one mid-session) is not detected until next plugin reload.

## Performance Bottlenecks

**`saveAll` is a full plugin-data re-serialize:**
- Issue: `saveAll` (`src/main.ts:99-101`) writes the entire `data.json` blob: tokens + manifest + lastSince + auditRing + settings. The push worker calls `onManifestUpdate` every 25 outcomes (`push-worker.ts:23,86-93`) and the engine wires that to `saveManifest` → `saveAll`. The pull worker flushes per batch. On a large-vault initial sync (hundreds of pulls / pushes) this is many full re-serializes.
- Files: `src/main.ts:99-101,118-122`, `src/sync/push-worker.ts:86-93`, `src/sync/pull-worker.ts:133-135`
- Impact: For typical vault sizes (manifest ~hundreds of rows × small JSON entries) this is fine. Above ~10k rows, per-batch flushes start to dominate cycle time.
- Fix approach: flush deltas, not the whole blob. Obsidian's `saveData` API is whole-blob; a delta layer would need its own append-only log on top. Not worth doing until manifest size justifies it.

**Vault scan is full re-scan every cycle:**
- Issue: `scanVault` (`src/sync/scan.ts:26-61`) reads every markdown file (`vault.cachedRead`), parses frontmatter, and SHA-256-hashes the body, every cycle. There is no mtime-based skip. `cachedRead` does keep Obsidian's read cache hot, so the I/O is cheap, but the parse+hash is unconditional.
- Files: `src/sync/scan.ts`
- Impact: Linear-in-vault-size CPU per cycle. For the 30 s default sync interval and a 1k-file vault, this is fine. Mobile devices with thousands of files will feel it.
- Fix approach: cache `(path, mtime, hash)` in plugin data; skip the read+hash if mtime is unchanged since the cached value. Risk: mtime is not atomic against external editors, so a parallel write at the same mtime would leak as "unchanged." A small mtime-window guard (read again if mtime is within 1 s of `now()`) covers it.

## Fragile Areas

**`reconcile.ts` Pass 1 fall-through:**
- Files: `src/sync/reconcile.ts:264-313`
- Why fragile: the cascade is `if (serverNewer && !localEdited) pull; else if (serverNewer && localEdited) push; else if (localEdited) push; else if (serverRenamed-aware path-mismatch) push;`. Each branch builds `previousPath` differently (`!serverRenamed && local && local.path !== scanned.path ? local.path : null`). Adding a fifth branch requires reasoning about the exclusion of all four prior conditions and the `serverRenamed` interaction with the synthetic-server-entry path. The synthetic entry has `version === local.version`, so `serverNewer === false` for synthesised rows — that's load-bearing for routing them through the correct branches, but it isn't enforced by a type or asserted in code.
- Safe modification: extract the (`serverNewer`, `localEdited`, `pathsAlign`) tuple, dispatch via an explicit table, and assert that synthetic entries take a known subset of branches. Extend the existing `tests/sync/reconcile.test.ts` table with a synthetic-entry-specific row per branch.
- Test coverage: the master matrix and sub-matrix #6 are covered by named tests in `tests/sync/reconcile.test.ts`. The synthetic-entry path has two regression tests ("delta hides server entry, file edited locally → pushes via synthetic server entry", "delta hides server entry, file deleted locally → emits stale-local-delete"). Branches are individually covered; the *combination* synthetic-entry × server-renamed is not (and cannot be — server-renamed implies the server changed the row, so delta would have included it).

**Self-write tracker entry leaks:**
- Files: `src/sync/self-write-tracker.ts`, `src/main.ts:81-85`
- Why fragile: tracker entries are matched by `(path, body-hash)`. If the plugin records a write but Obsidian coalesces multiple modify events into one (or fires zero), the entry sits until 30 s TTL prune. The 60 s `setInterval` prune (`main.ts:83-85`) bounds memory but not "first false-positive in the window." A user editing a file to exactly the bytes the plugin just wrote would have their edit suppressed.
- Safe modification: tracker is small; rewriting it to consume entries on a pure-path basis (any modify within 30 s after a record() consumes the entry) would over-suppress concurrent user edits. Current design is correct; the failure mode is rare and bounded.
- Test coverage: `tests/sync/self-write-tracker.test.ts`.

**Engine cycle is single-try:**
- Files: `src/sync/engine.ts:99-298`
- Why fragile: a thrown error inside the cycle (any of: manifest fetch, scan, reconcile, rename-local, pull worker, push worker, manifest save, audit save, lastSince save) skips the `advancePolicy` call (line 261-264) — so the next cycle re-tries the same fetch mode. Cold-start guarantee is preserved on retry, which is correct. But intermediate state (rename-local applied, pull worker partially completed) is *persisted* via `onManifestUpdate` callbacks before the error throws. Recovery on the next cycle relies on `reconcile()` being idempotent against partial progress. It is, by design (action ids are stable, see `reconcile.ts:91-100`), but the partial-state shape isn't tested explicitly.
- Safe modification: any new mutation in the engine cycle must persist via the same incremental-flush pattern (`onManifestUpdate`) to maintain crash-safety.
- Test coverage: integration test for "mid-cycle crash" is not present in the file list; the `tests/sync/` suite covers the workers individually.

## Scaling Limits

**Manifest size in plugin data blob:**
- Current capacity: typical Obsidian vaults (1k–10k files) — fine.
- Limit: at ~50k manifest rows, `saveAll` (full-blob serialize) dominates cycle time and may visibly stall the UI thread on slow disks.
- Scaling path: see "saveAll is a full plugin-data re-serialize" above.

**Audit ring is 200 entries (eviction):**
- Current capacity: 200 entries, append-with-eviction.
- Limit: hard cap. A heavy cycle (50+ pushes + pulls + drops) can evict older entries before the user reads them.
- Scaling path: increase `AUDIT_RING_SIZE` constant in `src/audit/ring.ts`, or persist evicted entries to a rolling on-disk log. Not currently bottlenecked.

**Push worker is serial:**
- Current capacity: one HTTP request at a time per cycle, with 500 ms / 1 s exponential backoff between retries.
- Limit: large-vault initial sync (hundreds of new files) takes minutes.
- Scaling path: bounded concurrency (e.g. 4 in-flight pushes). Risk: `runPushWorker` flushes manifest every 25 outcomes by serial-completion order; concurrency would require a different flush policy and would race the `manifestById` map.

## Dependencies at Risk

**Netlify body cap (5 MiB):**
- Risk: hard cap, no client-side pre-flight check, indefinite retries on oversize files. See "Body-size pre-flight check" above.
- Impact: silent sync failure for any single file >5 MiB.
- Migration plan: per user, Netlify migration is upcoming and changes or removes the cap. Pre-flight check deferred until post-migration shape is known.

**Obsidian `requestUrl` (no `AbortSignal`):**
- Risk: in-flight HTTP cannot be cancelled on plugin unload, sign-out, or sync-now interrupt.
- Impact: documented as out of scope (`docs/CONFLICT-MATRIX.md:157`). In-flight requests run to completion; their results land in a torn-down engine and are dropped.
- Migration plan: wait for Obsidian API to expose abort, or wrap with a Promise.race timeout. Low priority.

**ZITADEL device-authorization grant:**
- Risk: refresh-token-rotation policy is server-defined; reuse detection can lock out legitimate users if two clients sign in with the same refresh token.
- Impact: covered by `UNRECOVERABLE_AUTH_CODES` handling (`token-manager.ts:14-27`). Plugin transitions to signed-out, user re-signs-in. Acceptable.

## Missing Critical Features

**Local delete → server delete (`stale-local-delete` is surface-only):**
- Files: `src/sync/reconcile.ts:216-225,355-358`, `docs/CONFLICT-MATRIX.md:96-98,153`
- Problem: when the user deletes a file locally that the server still has, reconcile emits `stale-local-delete` which surfaces in the status bar but takes no server action. There is no `delete` push action or tombstone push.
- Blocks: bidirectional delete sync. Server-side deletes propagate (the `server-deleted` action drops manifest rows), but local-side deletes do not. Per plan, deferred to v1.1.

**Manifest orphan recovery command:**
- Problem: no command exists to drop manifest rows for UUIDs the server doesn't know about. See "Orphaned manifest rows after Pass 2 over-pushes" above. The only recovery is **Reset local sync state** which wipes everything (manifest + lastSince + audit ring).
- Blocks: surgical recovery from past Pass 2 regressions.

**Body chunked upload / presigned URL:**
- Problem: no path for files >5–6 MiB. Documented as out-of-scope in `docs/CONFLICT-MATRIX.md:155`.
- Blocks: large-file sync.

## Test Coverage Gaps

**Synthetic-server-entry × server-renamed combination:**
- What's not tested: the case where the synthetic entry built in `reconcile.ts:172-184` interacts with the `serverRenamed` branch (`reconcile.ts:249-252`). This combination is logically impossible — synthetic entries are built only when the server's delta omits the row, and server-renamed requires the server to have changed the path, which would put the row *in* the delta. But the impossibility isn't asserted in code.
- Files: `src/sync/reconcile.ts:172-184,249-260`
- Risk: low (combination cannot occur given current server contract). Adds up if the server contract changes to coalesce renames.
- Priority: Low.

**Mid-cycle crash recovery integration test:**
- What's not tested: full-engine simulation where the manifest is incrementally persisted, the engine throws after pull worker but before push worker, and the next cycle picks up cleanly with the same action ids.
- Files: `src/sync/engine.ts:99-298`
- Risk: action-id stability is the contract that makes resume work; without an end-to-end test it could silently break.
- Priority: Medium. Workers individually tested; orchestration is not.

**Body-size cap behaviour:**
- What's not tested: there is no test for "body exceeds 5,242,880 bytes" because there is no client-side check. Once the pre-flight check ships (post-Netlify migration), it needs a unit test.
- Priority: deferred with the feature.

**Manifest orphan cleanup on full fetch:**
- What's not tested: there is no test for "local manifest contains a UUID absent from a full-fetch server manifest." Currently the synthetic-entry path makes this a no-op. Once the orphan-drop fix lands (see "Orphaned manifest rows" above), it needs a test.
- Priority: deferred with the feature.

---

*Concerns audit: 2026-05-01*
