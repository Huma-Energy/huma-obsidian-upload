import type { AuthClient } from "../client/auth";
import { isAccessTokenExpired } from "../client/auth";
import type { AuthSource } from "../client/vault-api";
import type { StoredTokens } from "../settings";

export interface TokenStore {
	getTokens(): StoredTokens | null;
	setTokens(tokens: StoredTokens | null): Promise<void>;
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
		const next = await this.auth.refresh(current.refresh_token);
		// Refresh tokens rotate per the API Contract — replace both atomically.
		await this.store.setTokens(next);
		return next;
	}
}
