import type { AuditEntry } from "./types";

export interface StoredTokens {
	access_token: string;
	refresh_token: string;
	// Wall-clock ms epoch of access-token expiry (now + expires_in*1000 at receipt).
	access_expires_at: number;
}

export interface HumaPluginData {
	settings: HumaSettings;
	tokens: StoredTokens | null;
	manifest: ManifestRecord[];
	auditRing: AuditEntry[];
	// Server-time of the last successful manifest fetch; used as `?since=`
	// for delta polling in the sync engine.
	lastSince: string | null;
	// UUIDs the user has chosen to ignore in stale-local-delete state.
	// Reconcile still produces stale-local-delete actions for these IDs;
	// the engine filters them out before audit + status-bar surfacing.
	// Cleaned up automatically when the server entry tombstones (the
	// matching server_deleted action drops the manifest row and the id
	// from this set). The manifest row is kept so re-creating the file
	// at the same uuid stays linked to the server entry.
	ignoredStaleIds: string[];
	// Files the server has tombstoned but the user hasn't yet reviewed.
	// Each cycle's reconcile re-emits a server-deleted action while the
	// tombstone is still in the manifest's `since`-window; the plugin
	// dedupes by id. Persisted across reloads so the review surface
	// survives session restart. Cleared when the user picks Delete /
	// Keep, or auto-cleared if the file no longer exists in the vault.
	pendingServerDeletes: PendingServerDelete[];
	// Timestamp of when the user completed the first-run welcome flow.
	// `null` means not yet seen. Persisted across reloads so the welcome
	// modal does not re-open on subsequent enables. Sign-out does NOT
	// clear this (returning users don't re-onboard); resetLocalState
	// DOES clear it (full reset means re-onboard); disable preserves it.
	welcomeSeenAt: string | null;
}

export interface PendingServerDelete {
	// Tombstoned UUID. Originally minted by the server; matches the
	// `huma_uuid` frontmatter the local file still carries.
	id: string;
	// Last-known vault path at the moment the tombstone was first
	// observed. May be stale if the user has since renamed the file.
	path: string;
	// ISO timestamp of when the plugin first observed this tombstone.
	// Not the server's `archivedAt` — that field isn't surfaced in the
	// reconcile action. Used only to display "tombstoned N ago" in the
	// resolution modal.
	firstSeenAt: string;
}

export interface HumaSettings {
	serverBaseUrl: string;
	syncIntervalSeconds: number;
	// Vault-relative folder paths whose contents are skipped by sync. Files
	// already on the server are NOT deleted when their folder is excluded —
	// they remain on the server, frozen at their last-synced version, until
	// archived manually. Prefix match: "drafts" excludes "drafts/note.md".
	excludedFolders: string[];
}

// Forward-declared shape used by sync code in later tasks. Defined here so the
// data file's schema is settled at task 2 and won't migrate on first sync.
export interface ManifestRecord {
	id: string;
	path: string;
	version: number;
	hash: string;
	lastSyncedAt: string;
}

export const DEFAULT_SETTINGS: HumaSettings = {
	serverBaseUrl: "https://humagreenfield.netlify.app",
	syncIntervalSeconds: 30,
	excludedFolders: [],
};

export const SYNC_INTERVAL_MIN_SECONDS = 10;
export const SYNC_INTERVAL_MAX_SECONDS = 300;

export const DEFAULT_PLUGIN_DATA: HumaPluginData = {
	settings: DEFAULT_SETTINGS,
	tokens: null,
	manifest: [],
	auditRing: [],
	lastSince: null,
	ignoredStaleIds: [],
	pendingServerDeletes: [],
	welcomeSeenAt: null,
};
