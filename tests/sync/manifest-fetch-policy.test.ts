// Unit tests for the manifest-fetch policy. The engine is hard to test in
// isolation; the cold-start + periodic-rebaseline rule is the testable part
// and the engine just consults it. Lock the rule down so future tweaks to
// FULL_FETCH_EVERY can't accidentally change recovery semantics. Pure
// functions only — no engine plumbing required.

import { describe, expect, it } from "vitest";
import {
	advancePolicy,
	FULL_FETCH_EVERY,
	initialPolicyState,
	shouldFullFetch,
} from "../../src/sync/manifest-fetch-policy";

describe("manifest fetch policy", () => {
	it("first cycle after init must full-fetch (cold start)", () => {
		expect(shouldFullFetch(initialPolicyState())).toBe(true);
	});

	it("after a successful first full fetch, subsequent cycles delta-fetch", () => {
		const next = advancePolicy(initialPolicyState(), true);
		expect(next.firstCycle).toBe(false);
		expect(next.cyclesSinceFullFetch).toBe(0);
		expect(shouldFullFetch(next)).toBe(false);
	});

	it("re-baselines after FULL_FETCH_EVERY consecutive delta cycles", () => {
		// Cycle 1 is the cold-start full fetch; cycles 2..FULL_FETCH_EVERY are
		// deltas; cycle FULL_FETCH_EVERY+1 must re-baseline. Counter starts
		// at 0 after the first full fetch and increments per delta.
		let state = advancePolicy(initialPolicyState(), true);
		for (let i = 0; i < FULL_FETCH_EVERY; i++) {
			expect(shouldFullFetch(state)).toBe(false);
			state = advancePolicy(state, false);
		}
		// After FULL_FETCH_EVERY deltas the counter equals the threshold —
		// next cycle must full-fetch.
		expect(state.cyclesSinceFullFetch).toBe(FULL_FETCH_EVERY);
		expect(shouldFullFetch(state)).toBe(true);
	});

	it("a full fetch resets the delta counter", () => {
		let state = advancePolicy(initialPolicyState(), true);
		for (let i = 0; i < 5; i++) state = advancePolicy(state, false);
		expect(state.cyclesSinceFullFetch).toBe(5);
		state = advancePolicy(state, true);
		expect(state.cyclesSinceFullFetch).toBe(0);
		expect(shouldFullFetch(state)).toBe(false);
	});

	it("firstCycle clears after the first advancePolicy call regardless of mode", () => {
		// Even if the engine somehow ran the first cycle as a delta (it
		// won't — shouldFullFetch returns true — but defensively), the flag
		// must not stick.
		const next = advancePolicy(initialPolicyState(), false);
		expect(next.firstCycle).toBe(false);
	});
});
