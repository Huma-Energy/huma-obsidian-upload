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
	// Set by /api/vault/pull on `not_found` to name the offending id so the
	// plugin can drop it from the local manifest instead of looping on a
	// stale row forever.
	id?: string;
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
	| "pull_drop"
	| "server_deleted"
	| "stale_local_delete"
	| "duplicate_uuid"
	| "duplicate_uuid_resolved"
	| "token_scan_warning"
	| "auth_error"
	| "share_visibility_changed"
	| "share_tenant_role_changed"
	| "share_collaborator_added"
	| "share_collaborator_removed"
	| "share_collaborator_role_changed"
	| "share_stopped";

export interface AuditEntry {
	timestamp: string;
	event: AuditEvent;
	path: string;
	id: string | null;
	detail?: string;
}

// ---- Sharing (/api/vault/share) ----
// Wire shapes for the bearer-authed document-sharing endpoint. Visibility uses
// the server's enum values (`tenant` = "Organization" in the UI); the plugin
// maps to user-facing labels at the edges. `owner` is never an assignable
// collaborator/tenant role — only `callerRole` can be "owner".

export type ShareVisibility = "private" | "tenant" | "public";
export type ShareAssignableRole = "editor" | "commenter" | "viewer";
export type ShareCallerRole = ShareAssignableRole | "owner";

export interface ShareUser {
	zitadelSub: string;
	email: string | null;
	name: string | null;
	avatarUrl: string | null;
}

export interface ShareCollaborator {
	userId: string;
	role: ShareAssignableRole;
	addedAt: string;
	user: ShareUser | null;
}

export interface ShareStateResponse {
	ok: true;
	isOwner: boolean;
	callerRole: ShareCallerRole;
	ownerId: string | null;
	owner: ShareUser | null;
	tenantId: string | null;
	visibility: ShareVisibility;
	publicSlug: string | null;
	tenantRole: ShareAssignableRole;
	collaborators: ShareCollaborator[];
}

export interface ShareVisibilityResponse {
	ok: true;
	visibility: ShareVisibility;
	indexable: boolean;
	publicSlug: string | null;
}

export interface ShareSearchUsersResponse {
	ok: true;
	results: ShareUser[];
}
