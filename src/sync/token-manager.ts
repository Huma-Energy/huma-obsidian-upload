import type { AuthClient } from "../client/auth";
import { isAccessTokenExpired } from "../client/auth";
import { HttpError } from "../client/http";
import type { AuthSource } from "../client/vault-api";
import type { StoredTokens } from "../settings";

export interface TokenStore {
	getTokens(): StoredTokens | null;
	setTokens(tokens: StoredTokens | null): Promise<void>;
}

// Server-side error codes that mean the refresh token is no longer accepted.
// Encountering any of these means the only recovery is for the user to sign
// in again — retrying with the same refresh token will fail forever.
const UNRECOVERABLE_AUTH_CODES = new Set([
	"refresh_token_reused",
	"token_reused",
	"invalid_grant",
	"invalid_token",
]);

export function isUnrecoverableAuthError(err: unknown): boolean {
	if (!(err instanceof HttpError)) return false;
	const code = err.apiError?.error;
	if (typeof code !== "string") return false;
	return UNRECOVERABLE_AUTH_CODES.has(code);
}

export class TokenManager implements AuthSource {
	private readonly auth: AuthClient;
	private readonly store: TokenStore;
	private inflight: Promise<StoredTokens> | null = null;

	constructor(auth: AuthClient, store: TokenStore) {
		this.auth = auth;
		this.store = store;
	}

	async getAccessToken(): Promise<string> {
		const tokens = await this.ensureFresh();
		return tokens.access_token;
	}

	private async ensureFresh(): Promise<StoredTokens> {
		const current = this.store.getTokens();
		if (!current) throw new Error("Not signed in.");
		if (!isAccessTokenExpired(current)) return current;
		if (this.inflight) return this.inflight;
		this.inflight = this.refresh(current).finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	private async refresh(current: StoredTokens): Promise<StoredTokens> {
		try {
			const next = await this.auth.refresh(current.refresh_token);
			// Refresh tokens rotate per the API Contract — replace both atomically.
			await this.store.setTokens(next);
			return next;
		} catch (err) {
			if (isUnrecoverableAuthError(err)) {
				// The refresh token is no longer accepted (already rotated, or
				// reuse-detected by ZITADEL). Clear stored tokens so the plugin
				// transitions to signed-out and stops looping on every sync
				// cycle with the same revoked token.
				await this.store.setTokens(null);
			}
			throw err;
		}
	}
}
