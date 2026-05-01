// Transcribed from the plan's API Contract. Once @huma/vault-api-schema is
// published, regenerate this file from that JSON Schema and pin the version.

export interface DeviceAuthRequest {
	client_name: string;
}

export interface DeviceAuthResponse {
	session_id: string;
	user_code: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
}

export interface TokenGrantRequest {
	session_id: string;
	grant_type: "device_code";
}

export interface TokenRefreshRequest {
	refresh_token: string;
	grant_type: "refresh_token";
}

export interface TokenResponse {
	access_token: string;
	refresh_token: string;
	token_type: "Bearer";
	expires_in: number;
}

export interface ApiError {
	error: string;
	error_description?: string;
}

export type DevicePollError =
	| "authorization_pending"
	| "slow_down"
	| "expired_token"
	| "access_denied";

export interface ManifestEntry {
	id: string;
	path: string;
	version: number;
	hash: string;
	deleted_at: string | null;
}

export interface ManifestResponse {
	files: ManifestEntry[];
	next_cursor: string | null;
	server_time: string;
}

export interface PullRequest {
	ids: string[];
}

export interface PullFile {
	id: string;
	path: string;
	version: number;
	body: string;
	frontmatter: Record<string, unknown> | null;
}

export interface PullResponse {
	files: PullFile[];
}

export interface PushRequest {
	id: string | null;
	base_version: number | null;
	path: string;
	previous_path: string | null;
	body: string;
	frontmatter: Record<string, unknown> | null;
	client_mtime: string;
}

export type PushResponse =
	| { action: "accept"; id: string; version: number }
	| {
			action: "merge_clean";
			id: string;
			version: number;
			body: string;
			frontmatter: Record<string, unknown> | null;
	  }
	| {
			action: "merge_dirty";
			id: string;
			server_version: number;
			server_body: string;
			server_frontmatter: Record<string, unknown> | null;
	  };

export type AuditEvent =
	| "push_accept"
	| "push_reject"
	| "merge_clean"
	| "merge_dirty"
	| "path_change"
	| "pull_apply"
	| "token_scan_warning"
	| "auth_error";

export interface AuditEntry {
	timestamp: string;
	event: AuditEvent;
	path: string;
	id: string | null;
	detail?: string;
}
