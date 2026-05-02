import { describe, expect, it, vi } from "vitest";
import {
	isAccessTokenExpired,
	runDevicePollLoop,
	tokensFromResponse,
	type DevicePollOutcome,
} from "../../src/client/auth";

describe("tokensFromResponse", () => {
	it("computes absolute access expiry from expires_in", () => {
		const before = Date.now();
		const t = tokensFromResponse({
			access_token: "a",
			refresh_token: "r",
			token_type: "Bearer",
			expires_in: 3600,
		});
		const after = Date.now();
		expect(t.access_expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000);
		expect(t.access_expires_at).toBeLessThanOrEqual(after + 3600 * 1000);
	});
});

describe("isAccessTokenExpired", () => {
	const now = 1_700_000_000_000;
	it("treats tokens within the slack window as expired", () => {
		expect(
			isAccessTokenExpired(
				{
					access_token: "a",
					refresh_token: "r",
					access_expires_at: now + 10_000,
				},
				now,
			),
		).toBe(true);
	});
	it("treats tokens past the slack window as still valid", () => {
		expect(
			isAccessTokenExpired(
				{
					access_token: "a",
					refresh_token: "r",
					access_expires_at: now + 5 * 60 * 1000,
				},
				now,
			),
		).toBe(false);
	});
});

describe("runDevicePollLoop", () => {
	const tokens = {
		access_token: "access",
		refresh_token: "refresh",
		access_expires_at: Date.now() + 3600 * 1000,
	};

	it("returns tokens when poll succeeds", async () => {
		const poll = vi.fn(
			async (): Promise<DevicePollOutcome> => ({ kind: "tokens", tokens }),
		);
		const result = await runDevicePollLoop({
			sessionId: "s",
			intervalSeconds: 5,
			expiresInSeconds: 60,
			sleep: async () => {},
			poll,
		});
		expect(result).toEqual({ kind: "tokens", tokens });
		expect(poll).toHaveBeenCalledTimes(1);
	});

	it("backs off on slow_down by adding 5 seconds", async () => {
		// First poll happens immediately (no leading sleep). After two
		// consecutive slow_down outcomes the interval is bumped by 5
		// each time, so the next two sleeps are 10s and 15s.
		const sleeps: number[] = [];
		let calls = 0;
		const poll = vi.fn(async (): Promise<DevicePollOutcome> => {
			calls++;
			if (calls === 1) return { kind: "slow_down" };
			if (calls === 2) return { kind: "slow_down" };
			return { kind: "tokens", tokens };
		});
		await runDevicePollLoop({
			sessionId: "s",
			intervalSeconds: 5,
			expiresInSeconds: 60,
			sleep: async (ms: number) => {
				sleeps.push(ms);
			},
			poll,
		});
		expect(sleeps).toEqual([10_000, 15_000]);
	});

	it("polls immediately on the first iteration with no leading sleep", async () => {
		const sleeps: number[] = [];
		const poll = vi.fn(
			async (): Promise<DevicePollOutcome> => ({ kind: "tokens", tokens }),
		);
		await runDevicePollLoop({
			sessionId: "s",
			intervalSeconds: 5,
			expiresInSeconds: 60,
			sleep: async (ms: number) => {
				sleeps.push(ms);
			},
			poll,
		});
		expect(poll).toHaveBeenCalledTimes(1);
		expect(sleeps).toEqual([]);
	});

	it("returns denied when the user rejects", async () => {
		const result = await runDevicePollLoop({
			sessionId: "s",
			intervalSeconds: 5,
			expiresInSeconds: 60,
			sleep: async () => {},
			poll: async () => ({ kind: "denied" }),
		});
		expect(result.kind).toBe("denied");
	});

	it("returns expired when the device code is rejected as expired", async () => {
		const result = await runDevicePollLoop({
			sessionId: "s",
			intervalSeconds: 5,
			expiresInSeconds: 60,
			sleep: async () => {},
			poll: async () => ({ kind: "expired" }),
		});
		expect(result.kind).toBe("expired");
	});

	it("returns aborted when the signal fires", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		const result = await runDevicePollLoop({
			sessionId: "s",
			intervalSeconds: 5,
			expiresInSeconds: 60,
			sleep: async () => {},
			poll: async () => ({ kind: "pending" }),
			signal: ctrl.signal,
		});
		expect(result.kind).toBe("aborted");
	});
});
