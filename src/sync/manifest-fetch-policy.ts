// Decides whether each sync cycle should request a full server manifest or a
// delta (`?since=lastSince`). Standard delta-sync practice (WebDAV RFC 6578,
// MS Graph delta queries, CloudKit, Drive Changes API): cold-start always
// fetches in full, and clients periodically re-baseline so a stale or
// dropped delta token cannot leave files invisible forever. Engine owns the
// policy state; this module owns the rule.

export interface ManifestFetchPolicyState {
	// True until the engine has completed one successful cycle since the
	// plugin loaded. Forces the first cycle to full-fetch, which recovers
	// rows the server backfilled with timestamps older than the persisted
	// `lastSince` (rows that delta would otherwise never return).
	firstCycle: boolean;
	// Number of consecutive delta-fetch cycles since the last full fetch.
	// When this reaches FULL_FETCH_EVERY the next cycle re-baselines.
	cyclesSinceFullFetch: number;
}

// Re-baseline interval. At the default 30 s sync interval, 20 cycles is
// ~10 min — frequent enough to self-heal silent drift, infrequent enough
// not to waste bandwidth on stable vaults. Tune via this constant.
export const FULL_FETCH_EVERY = 20;

export function initialPolicyState(): ManifestFetchPolicyState {
	return { firstCycle: true, cyclesSinceFullFetch: 0 };
}

export function shouldFullFetch(state: ManifestFetchPolicyState): boolean {
	return state.firstCycle || state.cyclesSinceFullFetch >= FULL_FETCH_EVERY;
}

// Returns the next policy state after a successful cycle. `didFullFetch`
// must reflect whether the just-completed cycle actually issued a
// no-`since` request.
export function advancePolicy(
	state: ManifestFetchPolicyState,
	didFullFetch: boolean,
): ManifestFetchPolicyState {
	return {
		firstCycle: false,
		cyclesSinceFullFetch: didFullFetch ? 0 : state.cyclesSinceFullFetch + 1,
	};
}
