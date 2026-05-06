import { Notice, Platform, Plugin, TFile, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_PLUGIN_DATA,
	type HumaPluginData,
	type ManifestRecord,
	type StoredTokens,
} from "./settings";
import { FetchHttpClient, HttpError } from "./client/http";
import { AuthClient } from "./client/auth";
import { VaultApiClient } from "./client/vault-api";
import { TokenManager } from "./sync/token-manager";
import { SyncEngine, type EngineState } from "./sync/engine";
import { HumaSettingsTab } from "./ui/settings-tab";
import { attachStatusBar, type StatusBarHandle } from "./ui/status-bar";
import { AuditLogModal } from "./ui/audit-log-modal";
import { SignInModal } from "./ui/sign-in-modal";
import { WelcomeModal } from "./ui/welcome-modal";
import {
	StaleResolutionModal,
	type StaleEntryView,
} from "./ui/stale-resolution-modal";
import {
	ServerDeletedResolutionModal,
	type ServerDeletedEntryView,
} from "./ui/server-deleted-resolution-modal";
import {
	DuplicateUuidResolutionModal,
	type DuplicateUuidEntryView,
} from "./ui/duplicate-uuid-resolution-modal";
import { MobileStatusModal } from "./ui/mobile-status-modal";
import type {
	DuplicateUuid,
	ServerDeletedAction,
	StaleLocalDeleteAction,
} from "./sync/reconcile";
import type { PendingServerDelete } from "./settings";
import { listConflictFiles } from "./sync/conflict";
import { normalizeExcludedFolders } from "./sync/exclusion";
import { runPullWorker } from "./sync/pull-worker";
import { scanVaultForTokens } from "./security/vault-token-scan";
import { pushAuditMany } from "./audit/ring";
import { parseFile } from "./sync/frontmatter";
import { sha256Hex } from "./sync/hash";
import { SelfWriteTracker } from "./sync/self-write-tracker";
import { isUnrecoverableAuthError } from "./sync/token-manager";
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
	private lastStaleEntries: readonly StaleLocalDeleteAction[] = [];
	private lastDuplicateUuids: readonly DuplicateUuid[] = [];

	async onload(): Promise<void> {
		await this.loadAll();
		this.rebuildClients();
		// Status bar is desktop-only per Obsidian's status bar docs. On mobile
		// we render feedback through a ribbon icon + state modal instead.
		if (!Platform.isMobile) {
			const statusBarEl = this.addStatusBarItem();
			this.statusBar = attachStatusBar(statusBarEl);
			this.statusBar.onClick((state) => {
				if (state.kind === "conflict") {
					// Route directly to a resolution modal when only one
					// kind of issue is outstanding. Otherwise fall back to
					// the audit log so the user can see all the noise at
					// once.
					const onlyServerDeleted =
						state.serverDeletedCount > 0 &&
						state.conflictCount === 0 &&
						state.staleCount === 0 &&
						state.duplicateCount === 0;
					const onlyStale =
						state.staleCount > 0 &&
						state.conflictCount === 0 &&
						state.serverDeletedCount === 0 &&
						state.duplicateCount === 0;
					const onlyDuplicate =
						state.duplicateCount > 0 &&
						state.conflictCount === 0 &&
						state.staleCount === 0 &&
						state.serverDeletedCount === 0;
					if (onlyServerDeleted) {
						this.openServerDeletedResolutionModal();
					} else if (onlyStale) {
						this.openStaleResolutionModal();
					} else if (onlyDuplicate) {
						this.openDuplicateUuidResolutionModal();
					} else {
						this.openAuditLog();
					}
				} else if (state.kind === "error") {
					this.openAuditLog();
				} else if (state.kind === "idle") {
					// No warnings outstanding — clicking the bar triggers
					// a manual sync. Equivalent to the command-palette
					// "Sync now" action and the ribbon icon.
					void this.runFullSync();
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

	// Obsidian's Plugin types declare onunload as `void`-returning, but the
	// runtime awaits the result if a Promise is returned. Returning a
	// Promise is the correct pattern here: we need saveAll to finish before
	// the plugin instance is destroyed, otherwise the cleared-tokens state
	// can be lost.
	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	async onunload(): Promise<void> {
		this.stopPolling();
		// Conservative: clear only OAuth tokens so disabling the plugin
		// does not leave credentials at rest in data.json. Sync state
		// (manifest, audit ring, lastSince, ignored ids, pending server
		// deletes, welcomeSeenAt) is preserved so re-enable resumes
		// without a full re-pull. The Reset local sync state command
		// wipes the rest.
		if (this.data.tokens !== null) {
			this.data.tokens = null;
			await this.saveAll();
		}
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
			getExcludedFolders: () => this.data.settings.excludedFolders,
			getIgnoredStaleIds: () => this.data.ignoredStaleIds,
			saveIgnoredStaleIds: async (ids) => {
				this.data.ignoredStaleIds = ids;
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
					duplicateCount: state.duplicates,
					serverDeletedCount: this.countPendingServerDeletes(),
				});
				return;
		}
	}

	// If the engine just settled into idle/error but there are server-
	// deleted files awaiting review, force the status bar into conflict
	// state so the count is surfaced. Engine state alone wouldn't surface
	// this — pendingServerDeletes is plugin-side state, not reconcile-state.
	private renderStatusBarPostSync(): void {
		if (!this.statusBar) return;
		if (this.countPendingServerDeletes() === 0) return;
		// Pull current conflict / stale / duplicate counts from the most
		// recent engine state if it was already a conflict; otherwise zero
		// them out. Either way, the server-deleted count alone is enough
		// to keep the bar in conflict.
		const current = this.currentState;
		const conflictBase =
			current.kind === "conflict"
				? current
				: { conflicts: 0, stale: 0, duplicates: 0 };
		this.statusBar.render({
			kind: "conflict",
			conflictCount: conflictBase.conflicts,
			staleCount: conflictBase.stale,
			duplicateCount: conflictBase.duplicates,
			serverDeletedCount: this.countPendingServerDeletes(),
		});
	}

	private countPendingServerDeletes(): number {
		// Active count = pending entries whose vault files still exist.
		// Files the user manually deleted between cycles auto-clear from
		// the surface (they're cleaned up on next viewPendingServerDeletes
		// access; here we just count what's currently visible).
		return this.data.pendingServerDeletes.filter((p) =>
			this.app.vault.getAbstractFileByPath(p.path) instanceof TFile
				? true
				: false,
		).length;
	}

	private async recordServerDeletedActions(
		actions: readonly ServerDeletedAction[],
	): Promise<void> {
		if (actions.length === 0) return;
		const existing = new Set(
			this.data.pendingServerDeletes.map((p) => p.id),
		);
		const now = new Date().toISOString();
		const additions: PendingServerDelete[] = [];
		for (const a of actions) {
			if (existing.has(a.serverId)) continue;
			additions.push({ id: a.serverId, path: a.path, firstSeenAt: now });
		}
		if (additions.length === 0) return;
		this.data.pendingServerDeletes = [
			...this.data.pendingServerDeletes,
			...additions,
		];
		await this.saveAll();
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
			return;
		}
		this.renderStatusBar({ kind: "signed-out" });
		// First-run welcome trigger: no tokens AND welcome never seen.
		// The modal walks the user through Sign in → first sync; sets
		// welcomeSeenAt only after Step 3's "Get started" button.
		if (this.data.welcomeSeenAt === null) {
			this.openWelcomeModal();
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
			const paths = result.suspicious.map((h) => h.path);
			const previewPaths = paths.slice(0, 3).join(", ");
			new Notice(
				`Huma Vault Sync warning: ${result.suspicious.length} file(s) contain token-shaped strings (${previewPaths}${
					result.suspicious.length > 3 ? ", …" : ""
				}). See Show sync log for the full list. If these are not your tokens, you can ignore this notice.`,
				8000,
			);
			pushAuditMany(this.data.auditRing, [
				{
					timestamp: new Date().toISOString(),
					event: "token_scan_warning",
					path: "(vault scan)",
					id: null,
					detail: `${paths.length} file(s): ${paths.join(", ")}`,
				},
			]);
			await this.saveAll();
		}
	}

	async signIn(): Promise<void> {
		if (this.startupBlocked) {
			throw new Error(
				"Sign-in blocked because a token-shaped string was found in the vault.",
			);
		}
		if (!this.auth) throw new Error("Auth client not initialised.");

		// The modal owns the entire device-flow lifecycle (display, polling,
		// cancel, retry). The plugin just wires up auth-client deps + the
		// post-success token-persist via finishSignIn.
		return new Promise<void>((resolve, reject) => {
			new SignInModal(this.app, {
				startDeviceFlow: () => {
					if (!this.auth) {
						return Promise.reject(
							new Error("Auth client not initialised."),
						);
					}
					return this.auth.startDeviceFlow();
				},
				poll: (sessionId) => {
					if (!this.auth) {
						return Promise.reject(new Error("Auth client gone."));
					}
					return this.auth.pollDeviceToken(sessionId);
				},
				onSuccess: async (tokens) => {
					await this.finishSignIn(tokens);
					resolve();
				},
				onCancel: () => resolve(),
				onError: (err) =>
					reject(err instanceof Error ? err : new Error(String(err))),
			}).open();
		});
	}

	private async finishSignIn(tokens: StoredTokens): Promise<void> {
		this.data.tokens = tokens;
		await this.saveAll();
		new Notice("Huma: signed in.", 3000);
		void this.runFullSync();
		this.startPolling();
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
		this.data.welcomeSeenAt = null;
		await this.saveAll();
		new Notice("Huma: local sync state cleared.", 3000);
	}

	async runFullSync(): Promise<void> {
		if (!this.engine || !this.data.tokens || this.startupBlocked) return;
		try {
			const result = await this.engine.runSync();
			this.lastStaleEntries = result.actions.filter(
				(a): a is StaleLocalDeleteAction =>
					a.kind === "stale-local-delete",
			);
			await this.recordServerDeletedActions(
				result.actions.filter(
					(a): a is ServerDeletedAction =>
						a.kind === "server-deleted",
				),
			);
			// Hide duplicates whose UUID is already on the server-deleted
			// pending list — those resolve through the server-deleted modal,
			// and showing them in both surfaces would let the user mutate
			// frontmatter for a UUID the engine is about to drop anyway.
			const tombstoned = new Set(
				this.data.pendingServerDeletes.map((p) => p.id),
			);
			this.lastDuplicateUuids = result.duplicateUuids.filter(
				(d) => !tombstoned.has(d.uuid),
			);
			this.renderStatusBarPostSync();
		} catch (err) {
			new Notice(classifyErrorForUser(err), 6000);
			// Auth-class failures: TokenManager has already cleared stored
			// tokens (see token-manager.ts:refresh). Persist that state, log
			// to the audit ring, and stop the polling loop so the plugin
			// doesn't keep retrying with the (now-cleared) credentials.
			if (isUnrecoverableAuthError(err)) {
				const code =
					err instanceof HttpError
						? err.apiError?.error ?? `HTTP ${err.status}`
						: "unknown";
				pushAuditMany(this.data.auditRing, [
					{
						timestamp: new Date().toISOString(),
						event: "auth_error",
						path: "(auth)",
						id: null,
						detail: code,
					},
				]);
				await this.saveAll();
				this.stopPolling();
				this.renderStatusBar({ kind: "signed-out" });
			}
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
		new AuditLogModal(
			this.app,
			this.data.auditRing,
			() => this.clearAuditLog(),
			{
				onResolveStale: () => this.openStaleResolutionModal(),
				hasStale: () => this.lastStaleEntries.length > 0,
				onResolveServerDeleted: () =>
					this.openServerDeletedResolutionModal(),
				hasServerDeleted: () =>
					this.countPendingServerDeletes() > 0,
				onResolveDuplicate: () =>
					this.openDuplicateUuidResolutionModal(),
				hasDuplicate: () => this.lastDuplicateUuids.length > 0,
			},
		).open();
	}

	openAuditLogModal(): void {
		this.openAuditLog();
	}

	async clearAuditLog(): Promise<void> {
		this.data.auditRing.length = 0;
		await this.saveAll();
	}

	openStaleResolutionModal(): void {
		new StaleResolutionModal(this.app, {
			getEntries: () => this.viewStaleEntries(),
			restore: (serverId) => this.restoreStaleDeletion(serverId),
			ignore: (serverId) => this.ignoreStaleDeletion(serverId),
		}).open();
	}

	private viewStaleEntries(): StaleEntryView[] {
		const manifestById = new Map<string, ManifestRecord>();
		for (const r of this.data.manifest) manifestById.set(r.id, r);
		return this.lastStaleEntries.map((e) => {
			const m = manifestById.get(e.serverId);
			return {
				serverId: e.serverId,
				path: e.path,
				lastSyncedAt: m?.lastSyncedAt ?? null,
			};
		});
	}

	async restoreStaleDeletion(serverId: string): Promise<void> {
		// Direct pull via pull-worker, bypassing reconcile + sync cycle.
		// Going through `runFullSync` is racy: if a sync is already inflight
		// when restore is invoked, `engine.runSync()` coalesces our call onto
		// the inflight promise. That cycle was reading the manifest before
		// our drop, and its end-of-cycle `saveManifest` overwrites our drop
		// — leaving the manifest in its pre-restore state and forcing the
		// user to wait for the next polling cycle (≥ 30 s). The direct path
		// is also simpler: one API call + one file write, no reconcile.
		if (!this.vaultApi || !this.engine) {
			throw new Error("not signed in");
		}
		// Wait for any inflight polling cycle to finish before we mutate the
		// manifest out-of-band. Without this guard, the inflight cycle's
		// end-of-cycle `saveManifest` would overwrite our update.
		await this.engine.awaitInflight();
		const result = await runPullWorker(
			this.vaultApi,
			this.app,
			[serverId],
			this.data.manifest,
			this.selfWriteTracker,
		);
		if (result.errors.length > 0) {
			throw new Error(result.errors[0]!.error);
		}
		if (result.written === 0) {
			throw new Error(
				"Server returned no file for that id (it may have been tombstoned since the last sync).",
			);
		}

		this.data.manifest = result.updatedManifest;
		const auditEntries: AuditEntry[] = result.audit.map((p) => ({
			timestamp: p.timestamp,
			event: "pull_apply",
			path: p.path,
			id: p.id,
		}));
		pushAuditMany(this.data.auditRing, auditEntries);
		await this.saveAll();

		// Drop the resolved entry from the cached stale list so the modal
		// re-renders without it. The status-bar count is canonical from the
		// engine's last reconcile; trigger a background sync (no await) so
		// the bar refreshes on its own without blocking the user-visible
		// restore-then-reveal flow.
		this.lastStaleEntries = this.lastStaleEntries.filter(
			(e) => e.serverId !== serverId,
		);
		void this.runFullSync();

		// Open the restored file so the File Explorer reveals it. The
		// pulled record's path is authoritative (server may have renamed
		// the file since the local-delete).
		const restoredPath = result.audit[0]?.path;
		if (!restoredPath) return;
		const file = this.app.vault.getAbstractFileByPath(restoredPath);
		if (!(file instanceof TFile)) return;
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		// Best-effort reveal in the file-explorer side panel. The
		// command is shipped by core; if disabled, openFile already
		// activated the leaf which is enough for the user to spot it.
		// `commands` is not in the public types but is stable on the
		// app object at runtime — community-plugin convention.
		const commands = (
			this.app as unknown as {
				commands?: {
					executeCommandById?: (id: string) => boolean;
				};
			}
		).commands;
		commands?.executeCommandById?.("file-explorer:reveal-active-file");
	}

	openServerDeletedResolutionModal(): void {
		new ServerDeletedResolutionModal(this.app, {
			getEntries: () => this.viewServerDeletedEntries(),
			deleteLocally: (id) => this.deleteServerDeletedFile(id),
			keepLocally: (id) => this.keepServerDeletedFile(id),
		}).open();
	}

	openDuplicateUuidResolutionModal(): void {
		new DuplicateUuidResolutionModal(this.app, {
			getEntries: () => this.viewDuplicateUuidEntries(),
			keepUuid: (uuid, keepPath) =>
				this.resolveDuplicateUuid(uuid, keepPath),
		}).open();
	}

	private viewDuplicateUuidEntries(): DuplicateUuidEntryView[] {
		// Auto-prune sets where one of the listed paths no longer exists on
		// disk (user manually deleted between cycles) — if only one path
		// survives, the duplicate is degenerate and the next reconcile will
		// drop it. Render only sets that still have ≥2 surviving files.
		const visible: DuplicateUuidEntryView[] = [];
		for (const d of this.lastDuplicateUuids) {
			const surviving = d.paths.filter((p) => {
				const f = this.app.vault.getAbstractFileByPath(p);
				return f instanceof TFile;
			});
			if (surviving.length >= 2) {
				visible.push({ uuid: d.uuid, paths: surviving });
			}
		}
		return visible;
	}

	async resolveDuplicateUuid(uuid: string, keepPath: string): Promise<void> {
		const entry = this.lastDuplicateUuids.find((d) => d.uuid === uuid);
		if (!entry) {
			throw new Error("Duplicate set not found.");
		}
		if (!entry.paths.includes(keepPath)) {
			throw new Error("Keep path is not part of this duplicate set.");
		}
		// Wait for any inflight polling cycle. Without this guard, a
		// concurrent cycle's end-of-cycle saveManifest could race with our
		// frontmatter mutations and write a stale view of the world.
		// See restoreStaleDeletion for the same pattern.
		if (this.engine) await this.engine.awaitInflight();

		const stripped: string[] = [];
		const errors: { path: string; message: string }[] = [];
		for (const path of entry.paths) {
			if (path === keepPath) continue;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				// Non-fatal: file vanished between modal-open and click.
				continue;
			}
			try {
				await this.app.fileManager.processFrontMatter(
					file,
					(fm: Record<string, unknown>) => {
						delete fm.huma_uuid;
					},
				);
				stripped.push(path);
			} catch (err) {
				errors.push({
					path,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}

		if (stripped.length > 0) {
			const now = new Date().toISOString();
			pushAuditMany(
				this.data.auditRing,
				stripped.map((path) => ({
					timestamp: now,
					event: "duplicate_uuid_resolved" as const,
					path,
					id: uuid,
					detail: `kept ${keepPath}`,
				})),
			);
			await this.saveAll();
		}

		// Drop the resolved set from cache so a re-render of the modal
		// excludes it. The next runFullSync re-derives the canonical state.
		this.lastDuplicateUuids = this.lastDuplicateUuids.filter(
			(d) => d.uuid !== uuid,
		);
		this.renderStatusBarPostSync();
		void this.runFullSync();

		if (errors.length > 0) {
			const first = errors[0]!;
			throw new Error(
				`Stripped ${stripped.length} of ${entry.paths.length - 1} file(s); failed on ${first.path}: ${first.message}`,
			);
		}
	}

	private viewServerDeletedEntries(): ServerDeletedEntryView[] {
		// Auto-clear pending entries whose files no longer exist (user
		// deleted manually between cycles). Returns only entries whose
		// vault file is still on disk.
		const visible: ServerDeletedEntryView[] = [];
		const survivors: PendingServerDelete[] = [];
		let changed = false;
		for (const p of this.data.pendingServerDeletes) {
			const file = this.app.vault.getAbstractFileByPath(p.path);
			if (file instanceof TFile) {
				visible.push({
					id: p.id,
					path: p.path,
					firstSeenAt: p.firstSeenAt,
				});
				survivors.push(p);
			} else {
				changed = true;
			}
		}
		if (changed) {
			this.data.pendingServerDeletes = survivors;
			void this.saveAll();
		}
		return visible;
	}

	async deleteServerDeletedFile(serverId: string): Promise<void> {
		const pending = this.data.pendingServerDeletes.find(
			(p) => p.id === serverId,
		);
		if (!pending) {
			throw new Error("Pending entry not found.");
		}
		const file = this.app.vault.getAbstractFileByPath(pending.path);
		if (!(file instanceof TFile)) {
			// File already gone — just clear the pending entry.
			await this.clearPendingServerDelete(serverId);
			return;
		}
		// `fileManager.trashFile` respects the user's "Files & links →
		// Deleted files" setting (system trash, Obsidian's .trash/, or
		// permanent). Using vault.trash directly would force a choice
		// and ignore the preference.
		await this.app.fileManager.trashFile(file);
		await this.clearPendingServerDelete(serverId);
	}

	async keepServerDeletedFile(serverId: string): Promise<void> {
		const pending = this.data.pendingServerDeletes.find(
			(p) => p.id === serverId,
		);
		if (!pending) {
			throw new Error("Pending entry not found.");
		}
		const file = this.app.vault.getAbstractFileByPath(pending.path);
		if (!(file instanceof TFile)) {
			await this.clearPendingServerDelete(serverId);
			return;
		}
		// Strip huma_uuid from frontmatter so the file becomes an
		// untracked local copy. processFrontMatter is atomic over the
		// frontmatter region — the body is untouched. After this, scan
		// will route the file through scannedNoUuid; if the user later
		// edits + the plugin pushes, it'll allocate a fresh UUID
		// server-side. The original tombstoned UUID remains orphaned.
		await this.app.fileManager.processFrontMatter(
			file,
			(fm: Record<string, unknown>) => {
				delete fm.huma_uuid;
			},
		);
		await this.clearPendingServerDelete(serverId);
	}

	private async clearPendingServerDelete(serverId: string): Promise<void> {
		this.data.pendingServerDeletes = this.data.pendingServerDeletes.filter(
			(p) => p.id !== serverId,
		);
		await this.saveAll();
		this.renderStatusBarPostSync();
		// Re-render against current engine state if no more pending; the
		// engine's last state is correct in that case.
		if (this.data.pendingServerDeletes.length === 0) {
			this.renderStatusBar(this.currentState);
		}
	}

	async ignoreStaleDeletion(serverId: string): Promise<void> {
		// Adds the UUID to the ignored set so future reconcile cycles
		// suppress the stale-local-delete action for it. Manifest row is
		// preserved (re-creating the file at the same uuid stays linked
		// to the server entry). The set is auto-cleaned when the server
		// tombstones the file (see engine's tombstone block).
		if (this.data.ignoredStaleIds.includes(serverId)) return;
		this.data.ignoredStaleIds = [...this.data.ignoredStaleIds, serverId];
		await this.saveAll();
		this.lastStaleEntries = this.lastStaleEntries.filter(
			(e) => e.serverId !== serverId,
		);
		// Refresh the engine's view so the status-bar count updates.
		void this.runFullSync();
	}

	private openWelcomeModal(): void {
		new WelcomeModal(this.app, {
			getServerUrl: () => this.data.settings.serverBaseUrl,
			setServerUrl: async (url) => {
				const trimmed = url.trim().replace(/\/+$/, "");
				this.data.settings.serverBaseUrl = trimmed;
				await this.saveAll();
				this.rebuildHttpClient();
			},
			getExcludedFolders: () => this.data.settings.excludedFolders,
			setExcludedFolders: async (folders) => {
				this.data.settings.excludedFolders =
					normalizeExcludedFolders(folders);
				await this.saveAll();
			},
			startSignIn: (welcomeCallbacks) => {
				if (!this.auth) {
					welcomeCallbacks.onError(
						new Error("Auth client not initialised."),
					);
					return;
				}
				new SignInModal(this.app, {
					startDeviceFlow: () => {
						if (!this.auth) {
							return Promise.reject(
								new Error("Auth client not initialised."),
							);
						}
						return this.auth.startDeviceFlow();
					},
					poll: (sessionId) => {
						if (!this.auth) {
							return Promise.reject(
								new Error("Auth client gone."),
							);
						}
						return this.auth.pollDeviceToken(sessionId);
					},
					onSuccess: async (tokens) => {
						await this.finishSignIn(tokens);
						await welcomeCallbacks.onSuccess();
					},
					onCancel: () => welcomeCallbacks.onCancel(),
					onError: (err) => welcomeCallbacks.onError(err),
				}).open();
			},
			runFirstSync: async () => {
				if (!this.engine) return null;
				try {
					return await this.engine.runSync();
				} catch {
					// Surface to the modal via lastError handling.
					return null;
				}
			},
			markWelcomeSeen: async () => {
				this.data.welcomeSeenAt = new Date().toISOString();
				await this.saveAll();
			},
		}).open();
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
		if (isUnrecoverableAuthError(err) || err.status === 401) {
			return "Huma: refresh token rejected — please sign in again.";
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
		ignoredStaleIds: stored.ignoredStaleIds ?? base.ignoredStaleIds,
		pendingServerDeletes:
			stored.pendingServerDeletes ?? base.pendingServerDeletes,
		welcomeSeenAt: stored.welcomeSeenAt ?? base.welcomeSeenAt,
	};
}
