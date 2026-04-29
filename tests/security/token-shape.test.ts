import { describe, expect, it } from "vitest";
import {
	anyMatchesKnownToken,
	findTokenShapedStrings,
	looksLikeToken,
} from "../../src/security/token-shape";

describe("token-shape", () => {
	it("matches a long base64url-ish run", () => {
		const text = "hello A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0_-AB world";
		const matches = findTokenShapedStrings(text);
		expect(matches.length).toBe(1);
		expect(matches[0]!.value.length).toBeGreaterThanOrEqual(40);
	});

	it("does not match short identifiers", () => {
		expect(findTokenShapedStrings("uuid-abc 12345 def")).toEqual([]);
	});

	it("looksLikeToken returns false for too-short strings", () => {
		expect(looksLikeToken("abc")).toBe(false);
		expect(looksLikeToken("a".repeat(40))).toBe(true);
	});

	it("anyMatchesKnownToken does exact-match comparison", () => {
		const known = ["secret_token_value_1234567890abcdef0123456789abcdef"];
		const candidates = [
			"secret_token_value_1234567890abcdef0123456789abcdef",
			"different_long_string_1234567890abcdef0123456789abcdef",
		];
		expect(anyMatchesKnownToken(candidates, known)).toBe(true);
		expect(
			anyMatchesKnownToken(
				["different_long_string_1234567890abcdef0123456789abcdef"],
				known,
			),
		).toBe(false);
	});

	it("returns false when no known tokens are stored", () => {
		expect(
			anyMatchesKnownToken(["a".repeat(40)], []),
		).toBe(false);
	});
});
