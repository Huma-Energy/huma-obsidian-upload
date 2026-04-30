import { Notice, Platform, Plugin, TFile, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_PLUGIN_DATA,
	type HumaPluginData,
	type ManifestRecord,
	type StoredTokens,
} from "./settings";
import { FetchHttpClient, HttpError } from "./client/http";
import { AuthClient, runDevicePollLoop } from "./client/auth";
import { VaultApiClient } from "./client/vault-api";
import { TokenManager } from "./sync/token-manager";
import { SyncEngine, type EngineState } from "./sync/engine";
import { HumaSettingsTab } from "./ui/settings-tab";
import { attachStatusBar, type StatusBarHandle } from "./ui/status-bar";
import { AuditLogModal } from "./ui/audit-log-modal";
import { MobileStatusModal } from "./ui/mobile-status-modal";
import { listConflictFiles } from "./sync/conflict";
import { scanVaultForTokens } from "./security/vault-token-scan";
import { pushAuditMany } from "./audit/ring";
import { parseFile } from "./sync/frontmatter";
import { sha256Hex } from "./sync/hash";
import { SelfWriteTracker } from "./sync/self-write-tracker";
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
	private currentState: EngineState | { kind: "signed-out" } = { kind: "signed-out" };
	private readonly selfWriteTracker = new SelfWriteTracker();

	async onload(): Promise<void> {
		await this.loadAll();
		this.rebuildClients();
		// Status bar is desktop-only per Obsidian's status bar docs. On mobile
		// we render feedback through a ribbon icon + state modal instead.
		if (!Platform.isMobile) {
			const statusBarEl = this.addStatusBarItem();
			this.statusBar = attachStatusBar(statusBarEl);
			this.statusBar.onClick((state) => {
				if (state.kind === "error" || state.kind === "conflict") {
					this.openAuditLog();
				} else {
					new Notice(
						"Huma: open the plugin settings to manage sync.",
						4000,
					);
				}
			});
		} else {
			this.addRibbonIcon("refresh-cw", "Huma sync", () => {
				this.openMobileStatus();
			});
		}

		this.addSettingTab(new HumaSettingsTab(this.app, this));
		this.registerCommands();

		// Vault event handlers must register inside onLayoutReady — see
		// "Optimize plugin load time" docs: at cold start Obsidian fires
		// `create` for every existing file, which would falsely schedule a
		// sync per file before the workspace is ready.
		this.app.workspace.onLayoutReady(() => {
			this.registerVaultEventHooks();
			void this.startup();
		});

		// Self-write tracker entries can leak if a recorded write doesn't
		// produce a matching modify event (Obsidian sometimes coalesces).
		// Periodic prune is cheap and bounds memory.
		this.registerInterval(
			window.setInterval(() => this.selfWriteTracker.pruneExpired(), 60_000),
		);

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
			tracker: this.selfWriteTracker,
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
		if (state.kind !== "blocked") this.currentState = state;
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
		// Manifest, lastSince, and audit ring describe local sync state, not
		// auth state. Preserve them across sign-out so re-signing-in is a fast
		// no-op rather than a full vault rehash. Use the
		// "huma:reset-local-state" command to wipe them explicitly.
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

	async resetLocalState(): Promise<void> {
		this.data.manifest = [];
		this.data.lastSince = null;
		this.data.auditRing = [];
		await this.saveAll();
		new Notice("Huma: local sync state cleared.", 3000);
	}

	async runFullSync(): Promise<void> {
		if (!this.engine || !this.data.tokens || this.startupBlocked) return;
		try {
			await this.engine.runSync();
		} catch (err) {
			new Notice(classifyErrorForUser(err), 6000);
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
		this.registerEvent(
			this.app.vault.on("modify", (f: TAbstractFile) => {
				void this.handleModifyEvent(f, debounce);
			}),
		);
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

	private async handleModifyEvent(
		f: TAbstractFile,
		debounce: () => void,
	): Promise<void> {
		if (!(f instanceof TFile) || f.extension !== "md") {
			debounce();
			return;
		}
		// Hot path: most modify events come from the user, not us. Skip
		// reading + hashing unless the tracker has a pending write recorded
		// for this exact path.
		if (!this.selfWriteTracker.hasPath(f.path)) {
			debounce();
			return;
		}
		const text = await this.app.vault.cachedRead(f);
		const { body } = parseFile(text);
		const hash = await sha256Hex(body);
		if (this.selfWriteTracker.consume(f.path, hash)) return;
		debounce();
	}

	private registerCommands(): void {
		// Plugin guidelines: command ids must NOT include the plugin id prefix —
		// Obsidian prepends it automatically (final id is e.g.
		// "huma-vault-sync:sync-now"). UI text uses sentence case.
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.runFullSync(),
		});
		this.addCommand({
			id: "sign-in",
			name: "Sign in",
			checkCallback: (checking: boolean) => {
				if (this.data.tokens) return false;
				if (!checking) {
					void this.signIn().catch((err) =>
						new Notice(classifyErrorForUser(err), 6000),
					);
				}
				return true;
			},
		});
		this.addCommand({
			id: "sign-out",
			name: "Sign out",
			checkCallback: (checking: boolean) => {
				if (!this.data.tokens) return false;
				if (!checking) {
					void this.signOut().catch((err) =>
						new Notice(classifyErrorForUser(err), 6000),
					);
				}
				return true;
			},
		});
		this.addCommand({
			id: "resolve-conflicts",
			name: "Resolve conflicts",
			checkCallback: (checking: boolean) => {
				const has = listConflictFiles(this.app).length > 0;
				if (!has) return false;
				if (!checking) void this.openNextConflict();
				return true;
			},
		});
		this.addCommand({
			id: "show-sync-log",
			name: "Show sync log",
			callback: () => this.openAuditLog(),
		});
		this.addCommand({
			id: "reset-local-state",
			name: "Reset local sync state",
			callback: () => void this.resetLocalState(),
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

	private openMobileStatus(): void {
		new MobileStatusModal(this.app, {
			getState: () => this.currentState,
			getLastSyncedAt: () => this.lastSyncedAt,
			getConflictCount: () => listConflictFiles(this.app).length,
			onSyncNow: () => void this.runFullSync(),
			onResolveConflicts: () => void this.openNextConflict(),
			onOpenLog: () => this.openAuditLog(),
		}).open();
	}
}

// Maps raw errors from the sync engine into user-facing messages. Keep the
// classification narrow — anything unrecognized falls back to the generic
// "Huma sync failed" so we never silently swallow a real failure.
export function classifyErrorForUser(err: unknown): string {
	if (err instanceof HttpError) {
		if (err.status === 401 || err.apiError?.error === "invalid_token") {
			return "Huma: signed out — please sign in again.";
		}
		if (err.status >= 500) {
			return "Huma: server error, will retry.";
		}
		return `Huma: ${err.message}`;
	}
	if (err instanceof TypeError && /fetch/i.test(err.message)) {
		return "Huma: server unreachable.";
	}
	const message = err instanceof Error ? err.message : String(err);
	return `Huma sync failed: ${message}`;
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
