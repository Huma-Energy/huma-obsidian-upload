import type {
	ManifestResponse,
	PullRequest,
	PullResponse,
	PushRequest,
	PushResponse,
} from "../types";
import type { HttpClient } from "./http";

export const MANIFEST_PATH = "/api/vault/manifest";
export const PULL_PATH = "/api/vault/pull";
export const PUSH_PATH = "/api/vault/push";

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
}
