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
	// Local manifest written in later tasks (3–6); reserved here so loadData/saveData stays stable.
	manifest: ManifestRecord[];
	auditRing: AuditEntry[];
}

export interface HumaSettings {
	serverBaseUrl: string;
	syncIntervalSeconds: number;
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
	serverBaseUrl: "https://huma.energy",
	syncIntervalSeconds: 30,
};

export const SYNC_INTERVAL_MIN_SECONDS = 10;
export const SYNC_INTERVAL_MAX_SECONDS = 300;

export const DEFAULT_PLUGIN_DATA: HumaPluginData = {
	settings: DEFAULT_SETTINGS,
	tokens: null,
	manifest: [],
	auditRing: [],
};
