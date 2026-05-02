# Roadmap: Huma Vault Sync

## Overview

Pre-release v0.1 plugin shipping bidirectional sync. Recent work has closed delta-mode reconcile gaps (Bug 1 over-skip, Bug 3 over-skip with local divergence, cold-start full fetch). Current milestone hardens reconcile against the class of bugs that have surfaced repeatedly: each was a corner the multi-pass reconcile structure missed differently.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

## Phase Details

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1     | 2/2            | ✅ done — UAT 7/7 pass | 2026-05-02 |

### Phase 1: Refactor reconcile to single decide() function backed by exhaustive matrix property tests

**Goal:** Replace the three-pass reconcile structure in `src/sync/reconcile.ts` with a single pure `decide(server, local, scan) → SyncAction | null` function plus a UUID-union dispatch loop. Property-test every cell of `docs/CONFLICT-MATRIX.md` (master matrix + sub-matrix #6) so drift between spec and code is impossible.

**Why:** Bug 1 (Pass 2 over-skip) and Bug 3 (Pass 2 over-skip with local divergence) were the same fault in opposite directions. Each fix patched one corner of the multi-pass logic. Established sync references (vrtmrz/obsidian-livesync, remotely-save) use unified decision logic. Conflict matrix is documentation, not enforced code — drift has gone undetected.

**Requirements:** see `.planning/phases/01-refactor-reconcile-to-single-decide-function-backed-by-exhau/BRIEF.md`
**Depends on:** Nothing (first phase in this roadmap)
**Success Criteria** (what must be TRUE):
  1. `src/sync/reconcile.ts` exposes a single `decide(server, local, scan): SyncAction | null` pure function and a thin dispatch over the union of UUIDs across all three views; no Pass 2 / Pass 3 left.
  2. A property-test fixture in `tests/sync/reconcile.test.ts` enumerates every cell of CONFLICT-MATRIX.md and asserts decide's output for each.
  3. All 92 existing tests still pass; build + lint + test all exit 0.
  4. Verify-by-deletion: removing the `localById` skip OR the synthetic-server-entry promotion makes the property test fail.
  5. CONFLICT-MATRIX.md "Verification matrix" cites the property test for every cell; doc is derivable from the fixture.
  6. Build artifacts (`main.js`, `styles.css`) copied to the dev install path.

**Plans:** 2 plans

Plans:
- [x] 01-01-PLAN.md — Refactor reconcile.ts to decide() + UUID-union dispatch backed by property-fixture covering every CONFLICT-MATRIX cell
- [x] 01-02-PLAN.md — Update CONFLICT-MATRIX.md Verification matrix to cite the property fixture; copy build artifacts to dev install (with human-verify checkpoint)
