import type {
	ManifestResponse,
	PullRequest,
	PullResponse,
	PushRequest,
	PushResponse,
	ShareAssignableRole,
	ShareSearchUsersResponse,
	ShareStateResponse,
	ShareVisibility,
	ShareVisibilityResponse,
} from "../types";
import type { HttpClient } from "./http";

export const MANIFEST_PATH = "/api/vault/manifest";
export const PULL_PATH = "/api/vault/pull";
export const PUSH_PATH = "/api/vault/push";
export const SHARE_PATH = "/api/vault/share";

export interface ManifestQuery {
	cursor?: string;
	since?: string;
}

export interface AuthSource {
	getAccessToken(): Promise<string>;
}

export class VaultApiClient {
	private readonly http: HttpClient;
	private readonly auth: AuthSource;

	constructor(http: HttpClient, auth: AuthSource) {
		this.http = http;
		this.auth = auth;
	}

	async fetchManifest(query: ManifestQuery = {}): Promise<ManifestResponse> {
		const params = new URLSearchParams();
		if (query.cursor) params.set("cursor", query.cursor);
		if (query.since) params.set("since", query.since);
		const qs = params.toString();
		const path = qs ? `${MANIFEST_PATH}?${qs}` : MANIFEST_PATH;
		const bearer = await this.auth.getAccessToken();
		return this.http.request<ManifestResponse>({
			method: "GET",
			path,
			bearer,
		});
	}

	async pull(ids: string[]): Promise<PullResponse> {
		const body: PullRequest = { ids };
		const bearer = await this.auth.getAccessToken();
		return this.http.request<PullResponse>({
			method: "POST",
			path: PULL_PATH,
			body,
			bearer,
		});
	}

	async push(req: PushRequest): Promise<PushResponse> {
		const bearer = await this.auth.getAccessToken();
		return this.http.request<PushResponse>({
			method: "POST",
			path: PUSH_PATH,
			body: req,
			bearer,
		});
	}

	// ---- Sharing ----
	// GET reads the current ACL state for one vault file (id = huma_uuid); the
	// action-dispatched POST performs the owner-gated mutations. All ride the
	// same bearer the sync calls use.

	async getShareState(id: string): Promise<ShareStateResponse> {
		const bearer = await this.auth.getAccessToken();
		return this.http.request<ShareStateResponse>({
			method: "GET",
			path: `${SHARE_PATH}?id=${encodeURIComponent(id)}`,
			bearer,
		});
	}

	private async shareAction<T>(body: Record<string, unknown>): Promise<T> {
		const bearer = await this.auth.getAccessToken();
		return this.http.request<T>({
			method: "POST",
			path: SHARE_PATH,
			body,
			bearer,
		});
	}

	async setVisibility(
		id: string,
		visibility: ShareVisibility,
	): Promise<ShareVisibilityResponse> {
		return this.shareAction<ShareVisibilityResponse>({
			action: "set-visibility",
			id,
			visibility,
		});
	}

	async setTenantRole(
		id: string,
		tenantRole: ShareAssignableRole,
	): Promise<{ ok: true; tenantRole: ShareAssignableRole }> {
		return this.shareAction({ action: "set-tenant-role", id, tenantRole });
	}

	async addCollaborator(
		id: string,
		identifier: string,
		role: ShareAssignableRole,
	): Promise<{ ok: true }> {
		return this.shareAction({ action: "add-collaborator", id, identifier, role });
	}

	async updateCollaboratorRole(
		id: string,
		userId: string,
		role: ShareAssignableRole,
	): Promise<{ ok: true }> {
		return this.shareAction({
			action: "update-collaborator-role",
			id,
			userId,
			role,
		});
	}

	async removeCollaborator(id: string, userId: string): Promise<{ ok: true }> {
		return this.shareAction({ action: "remove-collaborator", id, userId });
	}

	async stopSharing(
		id: string,
	): Promise<{ ok: true; collaboratorsRemoved: number }> {
		return this.shareAction({ action: "stop-sharing", id });
	}

	async searchUsers(q: string): Promise<ShareSearchUsersResponse> {
		return this.shareAction<ShareSearchUsersResponse>({
			action: "search-users",
			q,
		});
	}
}
