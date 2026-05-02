// Recognises strings that look like a Huma session token. The dashboard's
// token shape is opaque base64url ≥40 chars; we deliberately match a *broader*
// pattern (any base64url-ish run of ≥40 chars) so the scan errs on the side of
// false-positives — it's a safety guard, not a regex-perfect parser. A user
// hitting a false-positive sees a notification telling them which file to
// edit, not silent token leakage. The plan's non-negotiable contract is "no
// token-shaped string under the vault root, ever."

export const TOKEN_SHAPED_PATTERN = /[A-Za-z0-9_-]{40,}/g;

export interface TokenShapedMatch {
	value: string;
	index: number;
}

export function findTokenShapedStrings(text: string): TokenShapedMatch[] {
	const out: TokenShapedMatch[] = [];
	for (const m of text.matchAll(TOKEN_SHAPED_PATTERN)) {
		if (m.index === undefined) continue;
		out.push({ value: m[0], index: m.index });
	}
	return out;
}

export function looksLikeToken(value: string): boolean {
	if (value.length < 40) return false;
	return /^[A-Za-z0-9_-]+$/.test(value);
}

// True if any of `strings` resemble a stored access/refresh token. Used by the
// startup invariant when comparing exact known-token values against what the
// scanner found on disk — exact-match check, not heuristic.
export function anyMatchesKnownToken(
	candidates: readonly string[],
	knownTokens: readonly string[],
): boolean {
	if (knownTokens.length === 0) return false;
	const known = new Set(knownTokens);
	return candidates.some((c) => known.has(c));
}
