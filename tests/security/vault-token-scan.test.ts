// Verifies the vault token scanner runs the heuristic ("token-shaped string")
// pass even when the plugin has no stored tokens to compare against — the
// previous early-return left first-launch users with no warning at all if
// their vault contained long base64-shaped strings. The exact-match block
// path remains conditional on having stored tokens.

import { describe, expect, it } from "vitest";
import { createMockApp } from "../../__mocks__/obsidian";
import { scanVaultForTokens } from "../../src/security/vault-token-scan";

// Anything matching the production token-shape regex `[A-Za-z0-9_-]{40,}`.
const TOKEN_SHAPED =
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789-Az";
const SHORT_NON_TOKEN = "hello world this is plain prose";

describe("scanVaultForTokens", () => {
	it("surfaces heuristic matches when no stored tokens are configured (pre-sign-in)", async () => {
		const app = createMockApp();
		app.vault.addFile("notes/secret-key.md", `here is a key: ${TOKEN_SHAPED}`);
		app.vault.addFile("notes/plain.md", SHORT_NON_TOKEN);

		const result = await scanVaultForTokens(
			app as unknown as Parameters<typeof scanVaultForTokens>[0],
			[],
		);

		expect(result.blocking).toEqual([]);
		expect(result.suspicious).toHaveLength(1);
		expect(result.suspicious[0]).toEqual({
			path: "notes/secret-key.md",
			matchedExactStoredToken: false,
		});
	});

	it("blocks on an exact stored-token match", async () => {
		const app = createMockApp();
		app.vault.addFile("notes/leaked.md", `oops: ${TOKEN_SHAPED}`);

		const result = await scanVaultForTokens(
			app as unknown as Parameters<typeof scanVaultForTokens>[0],
			[TOKEN_SHAPED],
		);

		expect(result.blocking).toEqual([
			{ path: "notes/leaked.md", matchedExactStoredToken: true },
		]);
		expect(result.suspicious).toEqual([]);
	});

	it("returns empty results for a clean vault", async () => {
		const app = createMockApp();
		app.vault.addFile("notes/plain.md", SHORT_NON_TOKEN);

		const result = await scanVaultForTokens(
			app as unknown as Parameters<typeof scanVaultForTokens>[0],
			[],
		);

		expect(result.blocking).toEqual([]);
		expect(result.suspicious).toEqual([]);
	});
});
