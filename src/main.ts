import { Notice, Platform, Plugin, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_PLUGIN_DATA,
	type HumaPluginData,
	type ManifestRecord,
	type StoredTokens,
} from "./settings";
import { FetchHttpClient } from "./client/http";
import { AuthClient, runDevicePollLoop } from "./client/auth";
import { VaultApiClient } from "./client/vault-api";
import { TokenManager } from "./sync/token-manager";
import { SyncEngine, type EngineState } from "./sync/engine";
import { HumaSettingsTab } from "./ui/settings-tab";
import { attachStatusBar, type StatusBarHandle } from "./ui/status-bar";
import { AuditLogModal } from "./ui/audit-log-modal";
import { listConflictFiles } from "./sync/conflict";
import { scanVaultForTokens } from "./security/vault-token-scan";
import { pushAuditMany } from "./audit/ring";
import type { AuditEntry } from "./types";

const PLUGIN_USER_AGENT = "Huma Obsidian Plugin v0.1.0";
const REVOKE_PATH = "/api/vault/auth/revoke";
const VAULT_DEBOUNCE_MS = 5_000;

export default class HumaVaultSyncPlugin extends Plugin {
	data: HumaPluginData = structuredClone(DEFAULT_PLUGIN_DATA);
	private http: FetchHttpClient | null = null;
	private auth: AuthClient | null = null;
	private vaultApi: VaultApiClient | null = null;
	private tokenManager: TokenManager | null = null;
	private engine: SyncEngine | null = null;
	private statusBar: StatusBarHandle | null = null;
	private startupBlocked = false;
	private lastSyncedAt: string | null = null;
	private pollHandle: number | null = null;

	async onload(): Promise<void> {
		await this.loadAll();
		this.rebuildClients();
		const statusBarEl = this.addStatusBarItem();
		this.statusBar = attachStatusBar(statusBarEl);
		this.statusBar.onClick((state) => {
			if (state.kind === "error" || state.kind === "conflict") {
				this.openAuditLog();
			} else {
				// Open settings tab; Obsidian doesn't expose a programmatic
				// "open my settings tab" so we fall back to the global one.
				(this.app as unknown as { setting?: { open(): void } }).setting?.open();
			}
		});

		this.addSettingTab(new HumaSettingsTab(this.app, this));
		this.registerCommands();
		this.registerVaultEventHooks();

		this.app.workspace.onLayoutReady(() => {
			void this.startup();
		});

		this.renderStatusBar({ kind: "signed-out" });
	}

	onunload(): void {
		this.stopPolling();
	}

	async loadAll(): Promise<void> {
		const stored = (await this.loadData()) as Partial<HumaPluginData> | null;
		this.data = mergeData(stored);
	}

	async saveAll(): Promise<void> {
		await this.saveData(this.data);
	}

	rebuildClients(): void {
		this.http = new FetchHttpClient(this.data.settings.serverBaseUrl);
		this.auth = new AuthClient(this.http, PLUGIN_USER_AGENT);
		this.tokenManager = new TokenManager(this.auth, {
			getTokens: () => this.data.tokens,
			setTokens: async (t: StoredTokens | null) => {
				this.data.tokens = t;
				await this.saveAll();
			},
		});
		this.vaultApi = new VaultApiClient(this.http, this.tokenManager);
		this.engine = new SyncEngine({
			api: this.vaultApi,
			app: this.app,
			getManifest: () => this.data.manifest,
			saveManifest: async (records: ManifestRecord[]) => {
				this.data.manifest = records;
				await this.saveAll();
			},
			appendAudit: async (entries: AuditEntry[]) => {
				pushAuditMany(this.data.auditRing, entries);
				await this.saveAll();
			},
			getLastSince: () => this.data.lastSince,
			saveLastSince: async (iso: string) => {
				this.data.lastSince = iso;
				await this.saveAll();
			},
			callbacks: {
				onState: (state) => this.onEngineState(state),
			},
		});
	}

	rebuildHttpClient(): void {
		this.rebuildClients();
		this.restartPolling();
	}

	private renderStatusBar(state: EngineState | { kind: "signed-out" } | { kind: "blocked"; reason: string }): void {
		if (!this.statusBar) return;
		switch (state.kind) {
			case "blocked":
				this.statusBar.render({ kind: "blocked", reason: state.reason });
				return;
			case "signed-out":
				this.statusBar.render({ kind: "signed-out" });
				return;
			case "idle":
				this.statusBar.render({
					kind: "idle",
					lastSyncedAt: state.lastSyncedAt ?? this.lastSyncedAt,
				});
				return;
			case "syncing":
				this.statusBar.render({ kind: "syncing", pendingActions: state.pending });
				return;
			case "error":
				this.statusBar.render({ kind: "error", message: state.message });
				return;
			case "conflict":
				this.statusBar.render({
					kind: "conflict",
					conflictCount: state.conflicts,
					staleCount: state.stale,
				});
				return;
		}
	}

	private onEngineState(state: EngineState): void {
		if (state.kind === "idle" && state.lastSyncedAt) {
			this.lastSyncedAt = state.lastSyncedAt;
		}
		this.renderStatusBar(state);
	}

	private async startup(): Promise<void> {
		await this.runStartupInvariant();
		if (this.startupBlocked) return;
		if (this.data.tokens) {
			void this.runFullSync();
			this.startPolling();
		} else {
			this.renderStatusBar({ kind: "signed-out" });
		}
	}

	private async runStartupInvariant(): Promise<void> {
		const tokens = this.data.tokens;
		const known = tokens
			? [tokens.access_token, tokens.refresh_token]
			: [];
		const result = await scanVaultForTokens(this.app, known);
		if (result.blocking.length > 0) {
			this.startupBlocked = true;
			const paths = result.blocking.map((h) => h.path).join(", ");
			new Notice(
				`Huma Vault Sync refused to start: a stored auth token was found in the vault (${paths}). ` +
					`Remove it before re-enabling sync. Tokens must never live under the vault root.`,
				0,
			);
			this.renderStatusBar({ kind: "blocked", reason: "token-in-vault" });
			return;
		}
		if (result.suspicious.length > 0) {
			const paths = result.suspicious
				.slice(0, 3)
				.map((h) => h.path)
				.join(", ");
			new Notice(
				`Huma Vault Sync warning: ${result.suspicious.length} file(s) contain token-shaped strings (${paths}${
					result.suspicious.length > 3 ? ", …" : ""
				}). If these are not your tokens, you can ignore this notice.`,
				8000,
			);
		}
	}

	async signIn(): Promise<void> {
		if (this.startupBlocked) {
			throw new Error(
				"Sign-in blocked because a token-shaped string was found in the vault.",
			);
		}
		if (!this.auth) throw new Error("Auth client not initialised.");

		const progress = await this.auth.startDeviceFlow();
		const { deviceCode, intervalSeconds } = progress;
		window.open(deviceCode.verification_uri_complete, "_blank");
		new Notice(
			`Huma sign-in: enter code ${deviceCode.user_code} in your browser. ` +
				`This window will sign you in automatically when you confirm.`,
			Math.min(deviceCode.expires_in, 600) * 1000,
		);

		const result = await runDevicePollLoop({
			sessionId: deviceCode.session_id,
			intervalSeconds,
			expiresInSeconds: deviceCode.expires_in,
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			poll: (sessionId) => {
				if (!this.auth) throw new Error("Auth client gone.");
				return this.auth.pollDeviceToken(sessionId);
			},
		});

		switch (result.kind) {
			case "tokens":
				this.data.tokens = result.tokens;
				await this.saveAll();
				new Notice("Huma: signed in.", 3000);
				void this.runFullSync();
				this.startPolling();
				return;
			case "denied":
				throw new Error("Sign-in denied at the verification page.");
			case "expired":
				throw new Error(
					"Sign-in code expired before confirmation. Try again.",
				);
			case "aborted":
				throw new Error("Sign-in aborted.");
		}
	}

	async signOut(): Promise<void> {
		this.stopPolling();
		const tokens = this.data.tokens;
		this.data.tokens = null;
		this.data.manifest = [];
		this.data.lastSince = null;
		await this.saveAll();
		this.renderStatusBar({ kind: "signed-out" });
		if (tokens && this.http) {
			try {
				await this.http.request({
					method: "POST",
					path: REVOKE_PATH,
					body: { refresh_token: tokens.refresh_token },
				});
			} catch {
				// best-effort
			}
		}
		new Notice("Huma: signed out.", 3000);
	}

	async runFullSync(): Promise<void> {
		if (!this.engine || !this.data.tokens || this.startupBlocked) return;
		try {
			await this.engine.runSync();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`Huma sync failed: ${message}`, 6000);
		}
	}

	private startPolling(): void {
		this.stopPolling();
		if (Platform.isMobile) {
			// Mobile syncs only on foreground resume + user-initiated commands.
			return;
		}
		const intervalMs = this.data.settings.syncIntervalSeconds * 1000;
		const handle = window.setInterval(() => {
			void this.runFullSync();
		}, intervalMs);
		this.registerInterval(handle);
		this.pollHandle = handle;
	}

	private stopPolling(): void {
		if (this.pollHandle !== null) {
			window.clearInterval(this.pollHandle);
			this.pollHandle = null;
		}
	}

	private restartPolling(): void {
		if (!this.data.tokens || this.startupBlocked) return;
		this.startPolling();
	}

	private registerVaultEventHooks(): void {
		const debounce = () => {
			if (!this.engine || !this.data.tokens || this.startupBlocked) return;
			this.engine.scheduleDebouncedSync(VAULT_DEBOUNCE_MS);
		};
		this.registerEvent(this.app.vault.on("modify", (_f: TAbstractFile) => debounce()));
		this.registerEvent(this.app.vault.on("create", (_f: TAbstractFile) => debounce()));
		this.registerEvent(this.app.vault.on("delete", (_f: TAbstractFile) => debounce()));
		this.registerEvent(this.app.vault.on("rename", (_f: TAbstractFile, _old: string) => debounce()));

		// Mobile foreground resume — Obsidian re-fires layout-ready when the app
		// returns from background. Use it as the mobile sync trigger.
		if (Platform.isMobile) {
			this.registerEvent(
				this.app.workspace.on("active-leaf-change", (_leaf: WorkspaceLeaf | null) => {
					debounce();
				}),
			);
		}
	}

	private registerCommands(): void {
		this.addCommand({
			id: "huma-sync-now",
			name: "Sync now",
			callback: () => void this.runFullSync(),
		});
		this.addCommand({
			id: "huma-sign-in-out",
			name: "Sign in / Sign out",
			callback: async () => {
				try {
					if (this.data.tokens) await this.signOut();
					else await this.signIn();
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					new Notice(`Huma: ${message}`, 6000);
				}
			},
		});
		this.addCommand({
			id: "huma-resolve-conflicts",
			name: "Resolve conflicts",
			callback: () => void this.openNextConflict(),
		});
		this.addCommand({
			id: "huma-show-sync-log",
			name: "Show sync log",
			callback: () => this.openAuditLog(),
		});
	}

	private async openNextConflict(): Promise<void> {
		const conflicts = listConflictFiles(this.app);
		if (conflicts.length === 0) {
			new Notice("Huma: no conflict files to resolve.", 3000);
			return;
		}
		const first = conflicts[0]!;
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(first);
		new Notice(
			`Huma: ${conflicts.length} conflict file(s) outstanding. Edit the original, delete the .conflict.md sibling, then run Sync now.`,
			6000,
		);
	}

	private openAuditLog(): void {
		new AuditLogModal(this.app, this.data.auditRing, this).open();
	}
}

function mergeData(stored: Partial<HumaPluginData> | null): HumaPluginData {
	const base = structuredClone(DEFAULT_PLUGIN_DATA);
	if (!stored) return base;
	return {
		settings: { ...base.settings, ...(stored.settings ?? {}) },
		tokens: stored.tokens ?? null,
		manifest: stored.manifest ?? base.manifest,
		auditRing: stored.auditRing ?? base.auditRing,
		lastSince: stored.lastSince ?? null,
	};
}
