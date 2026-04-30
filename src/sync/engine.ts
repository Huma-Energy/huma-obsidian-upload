import type { App } from "obsidian";
import type { VaultApiClient } from "../client/vault-api";
import type { ManifestRecord } from "../settings";
import type { ManifestEntry, AuditEntry } from "../types";
import { runPullWorker, type PullResult } from "./pull-worker";
import {
	runPushWorker,
	type PushAttemptInput,
	type PushOutcome,
	type PushWorkerResult,
} from "./push-worker";
import { reconcile, type SyncAction } from "./reconcile";
import { scanVault, type ScannedFile } from "./scan";
import { listConflictFiles } from "./conflict";
import type { SelfWriteTracker } from "./self-write-tracker";

export interface SyncEngineCallbacks {
	onState(state: EngineState): void;
}

export type EngineState =
	| { kind: "idle"; lastSyncedAt: string | null }
	| { kind: "syncing"; pending: number }
	| { kind: "error"; message: string }
	| { kind: "conflict"; conflicts: number; stale: number };

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
	callbacks?: SyncEngineCallbacks;
}

export class SyncEngine {
	private readonly deps: SyncEngineDeps;
	private inflight: Promise<SyncRunResult> | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

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
			const serverManifest = await fetchEntireManifest(api, this.deps.getLastSince());
			const scanned = await scanVault(app, excludedFolders);
			const localManifest = this.deps.getManifest();
			const { actions, stats } = reconcile({
				serverManifest: serverManifest.entries,
				localManifest,
				scanned,
				excludedFolders,
			});
			callbacks?.onState({ kind: "syncing", pending: actions.length });

			const scannedByPath = new Map<string, ScannedFile>();
			for (const f of scanned) scannedByPath.set(f.path, f);
			const localById = new Map<string, ManifestRecord>();
			for (const r of localManifest) localById.set(r.id, r);

			const pullIds: string[] = [];
			const pushInputs: PushAttemptInput[] = [];
			for (const action of actions) {
				if (action.kind === "pull") pullIds.push(action.serverId);
				else if (action.kind === "push" || action.kind === "add") {
					const scannedFile = scannedByPath.get(action.path);
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

			// Drop manifest entries the server has tombstoned.
			const tombstones = new Set(
				serverManifest.entries
					.filter((e) => e.deleted_at !== null)
					.map((e) => e.id),
			);
			if (tombstones.size > 0) {
				manifestSnapshot = manifestSnapshot.filter(
					(r) => !tombstones.has(r.id),
				);
			}

			const audit: AuditEntry[] = collectAudit(
				pushResult?.outcomes ?? [],
				pullResult?.audit ?? [],
				stats,
			);

			await this.deps.saveManifest(manifestSnapshot);
			if (audit.length > 0) await this.deps.appendAudit(audit);
			await this.deps.saveLastSince(serverManifest.serverTime);

			const conflicts = listConflictFiles(app).length;
			const finishedAt = new Date().toISOString();

			if (conflicts > 0 || stats.staleLocalDelete > 0) {
				callbacks?.onState({
					kind: "conflict",
					conflicts,
					stale: stats.staleLocalDelete,
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
