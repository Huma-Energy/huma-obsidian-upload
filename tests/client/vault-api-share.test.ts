// Verifies VaultApiClient's sharing methods produce the correct wire requests
// against /api/vault/share: GET for state (id in query, encoded), and the
// action-dispatched POST body for each mutation. Uses a fake HttpClient that
// records the last request and a stub AuthSource so no network is involved.

import { describe, expect, it } from "vitest";
import { VaultApiClient, SHARE_PATH } from "../../src/client/vault-api";
import type { HttpClient, JsonRequestOptions } from "../../src/client/http";

function makeClient(response: unknown = { ok: true }): {
	api: VaultApiClient;
	calls: JsonRequestOptions[];
} {
	const calls: JsonRequestOptions[] = [];
	const http: HttpClient = {
		async request<T>(opts: JsonRequestOptions): Promise<T> {
			calls.push(opts);
			return response as T;
		},
	};
	const auth = { getAccessToken: async () => "test-bearer" };
	return { api: new VaultApiClient(http, auth), calls };
}

describe("VaultApiClient sharing", () => {
	it("getShareState issues a GET with the id query param, encoded + bearer", async () => {
		const { api, calls } = makeClient();
		await api.getShareState("a b/c");
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.method).toBe("GET");
		expect(call.path).toBe(`${SHARE_PATH}?id=a%20b%2Fc`);
		expect(call.bearer).toBe("test-bearer");
		expect(call.body).toBeUndefined();
	});

	it("setVisibility posts the set-visibility action", async () => {
		const { api, calls } = makeClient();
		await api.setVisibility("uuid-1", "public");
		expect(calls[0]!.method).toBe("POST");
		expect(calls[0]!.path).toBe(SHARE_PATH);
		expect(calls[0]!.bearer).toBe("test-bearer");
		expect(calls[0]!.body).toEqual({
			action: "set-visibility",
			id: "uuid-1",
			visibility: "public",
		});
	});

	it("setTenantRole posts the set-tenant-role action", async () => {
		const { api, calls } = makeClient();
		await api.setTenantRole("uuid-1", "viewer");
		expect(calls[0]!.body).toEqual({
			action: "set-tenant-role",
			id: "uuid-1",
			tenantRole: "viewer",
		});
	});

	it("addCollaborator posts identifier + role", async () => {
		const { api, calls } = makeClient();
		await api.addCollaborator("uuid-1", "alice@example.com", "editor");
		expect(calls[0]!.body).toEqual({
			action: "add-collaborator",
			id: "uuid-1",
			identifier: "alice@example.com",
			role: "editor",
		});
	});

	it("updateCollaboratorRole posts userId + role", async () => {
		const { api, calls } = makeClient();
		await api.updateCollaboratorRole("uuid-1", "sub-2", "commenter");
		expect(calls[0]!.body).toEqual({
			action: "update-collaborator-role",
			id: "uuid-1",
			userId: "sub-2",
			role: "commenter",
		});
	});

	it("removeCollaborator posts userId", async () => {
		const { api, calls } = makeClient();
		await api.removeCollaborator("uuid-1", "sub-2");
		expect(calls[0]!.body).toEqual({
			action: "remove-collaborator",
			id: "uuid-1",
			userId: "sub-2",
		});
	});

	it("stopSharing posts the stop-sharing action", async () => {
		const { api, calls } = makeClient();
		await api.stopSharing("uuid-1");
		expect(calls[0]!.body).toEqual({ action: "stop-sharing", id: "uuid-1" });
	});

	it("searchUsers posts the query and returns results", async () => {
		const { api, calls } = makeClient({
			ok: true,
			results: [{ zitadelSub: "s", email: "e", name: "n", avatarUrl: null }],
		});
		const res = await api.searchUsers("ali");
		expect(calls[0]!.body).toEqual({ action: "search-users", q: "ali" });
		expect(res.results).toHaveLength(1);
	});
});
