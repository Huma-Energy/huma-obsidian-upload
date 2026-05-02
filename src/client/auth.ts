import type {
	DeviceAuthRequest,
	DeviceAuthResponse,
	TokenGrantRequest,
	TokenRefreshRequest,
	TokenResponse,
} from "../types";
import { HttpError, type HttpClient } from "./http";
import type { StoredTokens } from "../settings";

export const DEVICE_AUTH_PATH = "/api/vault/auth/device";
export const TOKEN_PATH = "/api/vault/auth/token";

// 30 seconds of slack before we treat an access token as expired, so
// long-running operations don't tear in flight.
const ACCESS_TOKEN_REFRESH_SLACK_MS = 30_000;

export interface DevicePollResult {
	tokens: StoredTokens;
}

export type DevicePollOutcome =
	| { kind: "tokens"; tokens: StoredTokens }
	| { kind: "pending" }
	| { kind: "slow_down" }
	| { kind: "expired" }
	| { kind: "denied" };

export interface SignInProgress {
	deviceCode: DeviceAuthResponse;
	intervalSeconds: number;
}

export class AuthClient {
	private readonly http: HttpClient;
	private readonly clientName: string;

	constructor(http: HttpClient, clientName: string) {
		this.http = http;
		this.clientName = clientName;
	}

	async startDeviceFlow(): Promise<SignInProgress> {
		const body: DeviceAuthRequest = { client_name: this.clientName };
		const res = await this.http.request<DeviceAuthResponse>({
			method: "POST",
			path: DEVICE_AUTH_PATH,
			body,
		});
		return { deviceCode: res, intervalSeconds: res.interval };
	}

	async pollDeviceToken(sessionId: string): Promise<DevicePollOutcome> {
		const body: TokenGrantRequest = {
			session_id: sessionId,
			grant_type: "device_code",
		};
		try {
			const res = await this.http.request<TokenResponse>({
				method: "POST",
				path: TOKEN_PATH,
				body,
			});
			return { kind: "tokens", tokens: tokensFromResponse(res) };
		} catch (err) {
			if (err instanceof HttpError && err.apiError) {
				switch (err.apiError.error) {
					case "authorization_pending":
						return { kind: "pending" };
					case "slow_down":
						return { kind: "slow_down" };
					case "expired_token":
						return { kind: "expired" };
					case "access_denied":
						return { kind: "denied" };
				}
			}
			throw err;
		}
	}

	async refresh(refreshToken: string): Promise<StoredTokens> {
		const body: TokenRefreshRequest = {
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		};
		const res = await this.http.request<TokenResponse>({
			method: "POST",
			path: TOKEN_PATH,
			body,
		});
		return tokensFromResponse(res);
	}
}

export function tokensFromResponse(res: TokenResponse): StoredTokens {
	return {
		access_token: res.access_token,
		refresh_token: res.refresh_token,
		access_expires_at: Date.now() + res.expires_in * 1000,
	};
}

export function isAccessTokenExpired(
	tokens: StoredTokens,
	now: number = Date.now(),
): boolean {
	return tokens.access_expires_at - ACCESS_TOKEN_REFRESH_SLACK_MS <= now;
}

export interface PollLoopHandlers {
	sessionId: string;
	intervalSeconds: number;
	expiresInSeconds: number;
	sleep: (ms: number) => Promise<void>;
	signal?: AbortSignal;
	poll: (sessionId: string) => Promise<DevicePollOutcome>;
}

export type PollLoopResult =
	| { kind: "tokens"; tokens: StoredTokens }
	| { kind: "expired" }
	| { kind: "denied" }
	| { kind: "aborted" };

// Drives the device-code polling loop with slow_down backoff and absolute
// expiry. Polls immediately on the first iteration (so the modal closes as
// soon as the user confirms in the browser, not after a full intervalSeconds
// wait), then sleeps between subsequent polls. Server returns `pending` for
// the impossible-to-confirm-yet first poll; protocol-compliant.
export async function runDevicePollLoop(
	h: PollLoopHandlers,
): Promise<PollLoopResult> {
	let intervalSeconds = h.intervalSeconds;
	const deadline = Date.now() + h.expiresInSeconds * 1000;
	let firstPoll = true;
	while (Date.now() < deadline) {
		if (h.signal?.aborted) return { kind: "aborted" };
		if (!firstPoll) {
			await h.sleep(intervalSeconds * 1000);
			if (h.signal?.aborted) return { kind: "aborted" };
		}
		firstPoll = false;
		const outcome = await h.poll(h.sessionId);
		switch (outcome.kind) {
			case "tokens":
				return { kind: "tokens", tokens: outcome.tokens };
			case "denied":
				return { kind: "denied" };
			case "expired":
				return { kind: "expired" };
			case "slow_down":
				intervalSeconds += 5;
				break;
			case "pending":
				break;
		}
	}
	return { kind: "expired" };
}
