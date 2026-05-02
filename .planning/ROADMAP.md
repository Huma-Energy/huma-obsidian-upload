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
| 2     | 4/4            | 🔧 implementation done — UAT pending | 2026-05-02 |

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

### Phase 2: Onboarding and packaging for non-technical users

**Goal:** Make the plugin installable and usable end-to-end by a non-technical user. Eliminate friction at three stages: first enable (silent today), sign-in (10 s Notice that's easy to miss), and disable (orphaned OAuth tokens in `data.json`). Also: ship the registry/BRAT visual asset so the listing page isn't text-only.

**Why:** First real users land tomorrow. Today the plugin enables silently, the device-flow code can scroll off-screen before the user sees it, disabling leaves tokens at rest, and the BRAT listing has no visual anchor. Each is a discrete defect against "semi-non-technical install".

**Requirements:** see `.planning/phases/02-onboarding-and-packaging-for-non-technical-users/BRIEF.md`
**Depends on:** Phase 1 (decide() + resolution UIs already shipped — Phase 2 builds on top of the existing modal infrastructure)
**Success Criteria** (what must be TRUE):
  1. Disabling the plugin via Settings → Community plugins → toggle off clears `data.tokens` from `data.json`. Other state (`manifest`, `auditRing`, `lastSince`, `pendingServerDeletes`, `ignoredStaleIds`) is preserved so re-enable resumes without a full re-pull.
  2. Enabling the plugin in a fresh-install state (`data.tokens === null` and welcome-seen flag absent) auto-opens a welcome modal that walks the user through Sign in → first sync. The flag persists so it does not re-open on subsequent enables.
  3. Sign-in modal stays open during device-flow polling, displays the user code prominently with Copy and Open Browser buttons, and shows poll progress + error states. Replaces the current 10 s Notice. Reused by both the welcome modal and the standalone Sign in command.
  4. Settings tab fields are reordered by access frequency: Authentication → Sync now → Server URL → Sync interval → Excluded folders → Sync log. Each setting has a one-line, plain-language description targeted at a non-engineer.
  5. Default `serverBaseUrl` in `DEFAULT_SETTINGS` changes to `https://humagreenfield.netlify.app`. Existing users with a stored value keep it via `mergeData` precedence (no migration; no users today).
  6. `assets/icon.png` exists at the repo root, copied from `huma-webicon.png`, referenced in the README header for BRAT and community-registry visibility. NOT referenced anywhere in `src/` (no settings UI, no ribbon icon, no modal headers).
  7. Build + lint + tests all green; no test regressions.

**Plans:** 4 plans

Plans:
- [x] 02-01-PLAN.md — Token cleanup on plugin disable (clear `data.tokens` in `onunload`, preserve everything else)
- [x] 02-02-PLAN.md — Sign-in modal replacing the device-flow Notice (used by welcome modal and standalone command)
- [x] 02-03-PLAN.md — First-run welcome modal (auto-opens on enable when no tokens + no welcome-seen flag)
- [x] 02-04-PLAN.md — Settings reorder + inline help, default server URL change, README icon
