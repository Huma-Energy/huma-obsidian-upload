import type { App, TFile } from "obsidian";
import {
	anyMatchesKnownToken,
	findTokenShapedStrings,
} from "./token-shape";

export interface VaultTokenLeakHit {
	path: string;
	matchedExactStoredToken: boolean;
}

// Scans every markdown file in the vault for strings matching either the
// exact stored access/refresh token (definitive leak) or anything token-shaped
// (heuristic warning). Returns the first hit found per file; an empty array
// means the vault is clean.
//
// The "exact stored token" check is the one that must block startup: if the
// plugin's own tokens have ended up under the vault root, sync MUST refuse to
// run until the user removes them. Heuristic-only matches (token-shaped but
// not equal to a stored token) are surfaced as a warning notification but do
// NOT block, because user content can legitimately contain long base64-ish
// strings (UUIDs concatenated with hashes, embedded keys for unrelated
// services, etc.).
export async function scanVaultForTokens(
	app: App,
	knownTokens: readonly string[],
): Promise<{ blocking: VaultTokenLeakHit[]; suspicious: VaultTokenLeakHit[] }> {
	const blocking: VaultTokenLeakHit[] = [];
	const suspicious: VaultTokenLeakHit[] = [];

	// The heuristic scan runs whether or not we have stored tokens to compare
	// against — pre-sign-in vaults can already contain token-shaped strings
	// the user should know about. The exact-match block path is conditional
	// on knownTokens because there's nothing to compare a candidate to
	// without them.
	const checkExact = knownTokens.length > 0;
	const files: TFile[] = app.vault.getMarkdownFiles();
	for (const file of files) {
		const text = await app.vault.cachedRead(file);
		const candidates = findTokenShapedStrings(text).map((m) => m.value);
		if (candidates.length === 0) continue;
		if (checkExact && anyMatchesKnownToken(candidates, knownTokens)) {
			blocking.push({ path: file.path, matchedExactStoredToken: true });
			continue;
		}
		suspicious.push({ path: file.path, matchedExactStoredToken: false });
	}
	return { blocking, suspicious };
}
