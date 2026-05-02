import type { App } from "obsidian";
import type { VaultApiClient } from "../client/vault-api";
import type { ManifestRecord } from "../settings";
import type { ManifestEntry, AuditEntry } from "../types";
import {
	advancePolicy,
	initialPolicyState,
	shouldFullFetch,
	type ManifestFetchPolicyState,
} from "./manifest-fetch-policy";
import { runPullWorker, type PullResult } from "./pull-worker";
import {
	runPushWorker,
	type PushAttemptInput,
	type PushOutcome,
	type PushWorkerResult,
} from "./push-worker";
import {
	reconcile,
	type RenameLocalAction,
	type StaleLocalDeleteAction,
	type SyncAction,
} from "./reconcile";
import { scanVault, type ScannedFile } from "./scan";
import { listConflictFiles } from "./conflict";
import { applyRenameToManifest, processRenameLocal } from "./rename-local";
import type { SelfWriteTracker } from "./self-write-tracker";

export interface SyncEngineCallbacks {
	onState(state: EngineState): void;
}

export type EngineState =
	| { kind: "idle"; lastSyncedAt: string | null }
	| { kind: "syncing"; pending: number }
	| { kind: "error"; message: string }
	| {
			kind: "conflict";
			conflicts: number;
			stale: number;
			// Vault files with shared huma_uuid frontmatter; sync is paused for
			// these UUIDs until the user removes one of the duplicates.
			duplicates: number;
	  };

export interface SyncRunResult {
	pull: PullResult | null;
	push: PushWorkerResult | null;
	actions: SyncAction[];
	audit: AuditEntry[];
	conflicts: number;
	stale: number;
	finishedAt: string;
}

export interface SyncEngineDeps {
	api: VaultApiClient;
	app: App;
	tracker: SelfWriteTracker;
	getManifest(): readonly ManifestRecord[];
	saveManifest(records: ManifestRecord[]): Promise<void>;
	appendAudit(entries: AuditEntry[]): Promise<void>;
	getLastSince(): string | null;
	saveLastSince(iso: string): Promise<void>;
	getExcludedFolders(): readonly string[];
	// User-chosen set of UUIDs to suppress stale-local-delete surfacing for.
	// Reconcile still emits the actions; engine filters them post-reconcile.
	// `saveIgnoredStaleIds` is called when the engine cleans up entries the
	// server has tombstoned (so the set doesn't grow unbounded).
	getIgnoredStaleIds(): readonly string[];
	saveIgnoredStaleIds(ids: string[]): Promise<void>;
	callbacks?: SyncEngineCallbacks;
}

export class SyncEngine {
	private readonly deps: SyncEngineDeps;
	private inflight: Promise<SyncRunResult> | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	// In-memory only. Plugin reload resets this to `firstCycle: true`, which
	// is exactly the recovery path: a stale `lastSince` persisted across
	// sign-out cannot mask backfilled rows on the next session because the
	// first cycle always full-fetches.
	private fetchPolicyState: ManifestFetchPolicyState = initialPolicyState();

	constructor(deps: SyncEngineDeps) {
		this.deps = deps;
	}

	// Coalesces concurrent runSync calls onto the inflight promise. The plan
	// requires per-action atomicity, not per-cycle isolation; running two
	// reconciles concurrently would race the manifest writes.
	runSync(): Promise<SyncRunResult> {
		if (this.inflight) return this.inflight;
		this.inflight = this.runOnce().finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	// Awaits the in-flight sync if one is running; resolves immediately
	// otherwise. Used by out-of-band manifest writes (e.g. stale-delete
	// restore) that need to ensure no concurrent saveManifest can clobber
	// their update without forcing a fresh cycle to run.
	async awaitInflight(): Promise<void> {
		if (!this.inflight) return;
		try {
			await this.inflight;
		} catch {
			// Errors are surfaced via onState; we just need the slot clear.
		}
	}

	scheduleDebouncedSync(delayMs: number = 5_000): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			void this.runSync().catch(() => {
				// errors surface via callbacks; debounce path swallows.
			});
		}, delayMs);
	}

	private async runOnce(): Promise<SyncRunResult> {
		const { api, app, callbacks } = this.deps;
		callbacks?.onState({ kind: "syncing", pending: 0 });

		try {
			const excludedFolders = this.deps.getExcludedFolders();
			// Cold-start full fetch + periodic re-baseline: standard delta-sync
			// recovery practice. Stale `lastSince` (preserved across sign-out)
			// cannot hide rows the server backfilled with timestamps older
			// than the persisted cursor — the first cycle re-fetches them all.
			const doFullFetch = shouldFullFetch(this.fetchPolicyState);
			const sinceForFetch = doFullFetch ? null : this.deps.getLastSince();
			const serverManifest = await fetchEntireManifest(api, sinceForFetch);
			const scanned = await scanVault(app, excludedFolders);
			const localManifest = this.deps.getManifest();
			const reconciled = reconcile({
				serverManifest: serverManifest.entries,
				localManifest,
				scanned,
				excludedFolders,
			});
			// User-policy filter: suppress stale-local-delete actions for
			// UUIDs the user has chosen to ignore. Reconcile stays a pure
			// spec; the policy lives outside it. `stats.staleLocalDelete`
			// is updated to match so the audit + status-bar surface the
			// true post-filter counts.
			const ignoredStaleIds = new Set(this.deps.getIgnoredStaleIds());
			let actions = reconciled.actions;
			let stats = reconciled.stats;
			const duplicateUuids = reconciled.duplicateUuids;
			if (ignoredStaleIds.size > 0) {
				const beforeStale = stats.staleLocalDelete;
				actions = actions.filter(
					(a) =>
						!(
							a.kind === "stale-local-delete" &&
							ignoredStaleIds.has(a.serverId)
						),
				);
				const afterStale = actions.filter(
					(a) => a.kind === "stale-local-delete",
				).length;
				stats = { ...stats, staleLocalDelete: afterStale };
				void beforeStale;
			}
			callbacks?.onState({ kind: "syncing", pending: actions.length });

			const scannedByPath = new Map<string, ScannedFile>();
			for (const f of scanned) scannedByPath.set(f.path, f);
			const localById = new Map<string, ManifestRecord>();
			for (const r of localManifest) localById.set(r.id, r);

			const renameLocals: RenameLocalAction[] = [];
			const pullIds: string[] = [];
			const pushInputs: PushAttemptInput[] = [];
			const staleLocalDeletes: StaleLocalDeleteAction[] = [];
			for (const action of actions) {
				if (action.kind === "rename-local") renameLocals.push(action);
				else if (action.kind === "pull") pullIds.push(action.serverId);
				else if (action.kind === "stale-local-delete")
					staleLocalDeletes.push(action);
				else if (action.kind === "push" || action.kind === "add") {
					const lookupPath =
						action.kind === "push" && action.serverId
							? localById.get(action.serverId)?.path ?? action.path
							: action.path;
					const scannedFile = scannedByPath.get(lookupPath);
					if (!scannedFile) continue;
					const local =
						action.kind === "push" && action.serverId
							? localById.get(action.serverId) ?? null
							: null;
					pushInputs.push({ action, scanned: scannedFile, localManifest: local });
				}
			}

			let pullResult: PullResult | null = null;
			let manifestSnapshot: ManifestRecord[] = [...localManifest];

			// Process server-side renames first — reconcile already ordered
			// them ahead of pulls so a same-cycle pull writes the body at the
			// post-rename path.
			const renameAuditEntries: AuditEntry[] = [];
			for (const action of renameLocals) {
				const outcome = await processRenameLocal(app, action, this.deps.tracker);
				if (outcome.result.kind === "renamed") {
					manifestSnapshot = applyRenameToManifest(manifestSnapshot, action);
					renameAuditEntries.push({
						timestamp: new Date().toISOString(),
						event: "path_change",
						path: action.toPath,
						id: action.serverId,
						detail: `renamed from ${action.fromPath}`,
					});
				}
			}
			if (renameAuditEntries.length > 0) {
				await this.deps.saveManifest(manifestSnapshot);
			}

			if (pullIds.length > 0) {
				pullResult = await runPullWorker(
					api,
					app,
					pullIds,
					manifestSnapshot,
					this.deps.tracker,
					{
						onManifestUpdate: (m) => this.deps.saveManifest(m),
					},
				);
				manifestSnapshot = pullResult.updatedManifest;
			}

			let pushResult: PushWorkerResult | null = null;
			if (pushInputs.length > 0) {
				pushResult = await runPushWorker(
					api,
					app,
					pushInputs,
					manifestSnapshot,
					this.deps.tracker,
					{
						onManifestUpdate: (m) => this.deps.saveManifest(m),
					},
				);
				manifestSnapshot = pushResult.updatedManifest;
			}

			// Drop manifest entries the server has tombstoned. Each drop emits
			// a `server_deleted` audit so the user can trace why a row vanished
			// (and find the on-disk file the plugin intentionally left behind).
			const tombstoneAuditEntries: AuditEntry[] = [];
			const tombstones = new Set(
				serverManifest.entries
					.filter((e) => e.deleted_at !== null)
					.map((e) => e.id),
			);
			if (tombstones.size > 0) {
				const droppedRows = manifestSnapshot.filter((r) => tombstones.has(r.id));
				for (const row of droppedRows) {
					tombstoneAuditEntries.push({
						timestamp: new Date().toISOString(),
						event: "server_deleted",
						path: row.path,
						id: row.id,
					});
				}
				manifestSnapshot = manifestSnapshot.filter(
					(r) => !tombstones.has(r.id),
				);
				// Cleanup: any tombstoned id that was in the ignored-stale
				// set no longer needs to be there (server propagated the
				// delete; the matching local row just got dropped). Keeps
				// the set bounded.
				if (ignoredStaleIds.size > 0) {
					let changed = false;
					for (const row of droppedRows) {
						if (ignoredStaleIds.delete(row.id)) changed = true;
					}
					if (changed) {
						await this.deps.saveIgnoredStaleIds(
							Array.from(ignoredStaleIds),
						);
					}
				}
			}

			const pullDropAuditEntries: AuditEntry[] = (pullResult?.dropped ?? []).map(
				(d) => ({
					timestamp: d.timestamp,
					event: "pull_drop",
					path: d.path ?? "(unknown)",
					id: d.id,
					detail: "server reported not_found; manifest row dropped",
				}),
			);

			const duplicateAuditEntries: AuditEntry[] = duplicateUuids.map((d) => ({
				timestamp: new Date().toISOString(),
				event: "duplicate_uuid",
				path: d.paths.join(", "),
				id: d.uuid,
				detail: `${d.paths.length} files share huma_uuid ${d.uuid}; sync skipped until resolved`,
			}));

			// Stale-local-delete: file is in the local manifest but absent from
			// the vault scan while still live on the server. Plugin does NOT
			// auto-delete server-side (delete-sync is v1.1) — surfaces via the
			// status bar's `conflict` state with `staleCount`. Logged here so the
			// user can trace which file produced the warning.
			const staleLocalDeleteAuditEntries: AuditEntry[] = staleLocalDeletes.map(
				(a) => ({
					timestamp: new Date().toISOString(),
					event: "stale_local_delete",
					path: a.path,
					id: a.serverId,
					detail: "local file missing while server entry is live; no auto-action (delete-sync deferred)",
				}),
			);

			const audit: AuditEntry[] = [
				...renameAuditEntries,
				...tombstoneAuditEntries,
				...pullDropAuditEntries,
				...duplicateAuditEntries,
				...staleLocalDeleteAuditEntries,
				...collectAudit(
					pushResult?.outcomes ?? [],
					pullResult?.audit ?? [],
					stats,
				),
			];

			await this.deps.saveManifest(manifestSnapshot);
			if (audit.length > 0) await this.deps.appendAudit(audit);
			await this.deps.saveLastSince(serverManifest.serverTime);
			// Only advance the fetch policy on a fully successful cycle —
			// errors thrown above skip this and the next cycle re-tries the
			// same fetch mode, preserving cold-start guarantee on retry.
			this.fetchPolicyState = advancePolicy(
				this.fetchPolicyState,
				doFullFetch,
			);

			const conflicts = listConflictFiles(app).length;
			const finishedAt = new Date().toISOString();

			if (
				conflicts > 0 ||
				stats.staleLocalDelete > 0 ||
				stats.duplicateUuid > 0
			) {
				callbacks?.onState({
					kind: "conflict",
					conflicts,
					stale: stats.staleLocalDelete,
					duplicates: stats.duplicateUuid,
				});
			} else {
				callbacks?.onState({ kind: "idle", lastSyncedAt: finishedAt });
			}

			return {
				pull: pullResult,
				push: pushResult,
				actions,
				audit,
				conflicts,
				stale: stats.staleLocalDelete,
				finishedAt,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			callbacks?.onState({ kind: "error", message });
			throw err;
		}
	}
}

interface ManifestSnapshot {
	entries: ManifestEntry[];
	serverTime: string;
}

async function fetchEntireManifest(
	api: VaultApiClient,
	since: string | null,
): Promise<ManifestSnapshot> {
	const entries: ManifestEntry[] = [];
	let cursor: string | undefined = undefined;
	let serverTime = new Date().toISOString();
	do {
		const res = await api.fetchManifest({
			cursor,
			since: since ?? undefined,
		});
		entries.push(...res.files);
		serverTime = res.server_time;
		cursor = res.next_cursor ?? undefined;
	} while (cursor);
	return { entries, serverTime };
}

function collectAudit(
	outcomes: readonly PushOutcome[],
	pullAudit: readonly { id: string; path: string; timestamp: string }[],
	stats: { add: number; pull: number; push: number },
): AuditEntry[] {
	void stats;
	const pullEntries: AuditEntry[] = pullAudit.map((p) => ({
		timestamp: p.timestamp,
		event: "pull_apply",
		path: p.path,
		id: p.id,
	}));
	return [...pullEntries, ...outcomes.map((o) => o.audit)];
}
