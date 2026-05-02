import type { ManifestEntry } from "../types";
import type { ManifestRecord } from "../settings";
import type { ScannedFile } from "./scan";
import { isExcludedPath } from "./exclusion";

export type SyncAction =
	| AddAction
	| PullAction
	| PushAction
	| RenameLocalAction
	| StaleLocalDeleteAction
	| ServerDeletedAction;

export interface AddAction { kind: "add"; id: string; path: string; }
export interface PullAction {
	kind: "pull"; id: string; serverId: string;
	path: string; conflictedLocally: boolean;
}
export interface PushAction {
	kind: "push"; id: string; serverId: string | null;
	path: string; previousPath: string | null;
}
// Server-side rename. Ordered before pulls so a same-cycle pull writes at
// the post-rename path. Engine moves via app.fileManager.renameFile.
export interface RenameLocalAction {
	kind: "rename-local"; id: string; serverId: string;
	fromPath: string; toPath: string;
}
export interface StaleLocalDeleteAction {
	kind: "stale-local-delete"; id: string; serverId: string; path: string;
}
export interface ServerDeletedAction {
	kind: "server-deleted"; id: string; serverId: string; path: string;
}

export interface ReconcileInput {
	serverManifest: readonly ManifestEntry[];
	localManifest: readonly ManifestRecord[];
	scanned: readonly ScannedFile[];
	excludedFolders?: readonly string[];
}

export interface DuplicateUuid { uuid: string; paths: string[]; }

export interface ReconcileOutput {
	actions: SyncAction[];
	stats: {
		add: number; pull: number; push: number; renameLocal: number;
		conflict: number; staleLocalDelete: number;
		serverDeleted: number; duplicateUuid: number;
	};
	duplicateUuids: DuplicateUuid[];
}

// Reconciles three views (server delta + local manifest + vault scan) into an
// ordered, deterministic action list. Order: server-deletes → rename-local →
// pulls → pushes → adds → stale-local-deletes. Action ids are stable across
// runs so a post-crash replay produces the same ids for residual work.
export function reconcile(input: ReconcileInput): ReconcileOutput {
	const excluded = input.excludedFolders ?? [];

	// Step A: filter excluded paths from all three views.
	const serverManifest = input.serverManifest.filter(
		(e) => !isExcludedPath(e.path, excluded),
	);
	const localManifest = input.localManifest.filter(
		(r) => !isExcludedPath(r.path, excluded),
	);
	const scannedFiles = input.scanned.filter(
		(f) => !isExcludedPath(f.path, excluded),
	);

	const serverById = new Map<string, ManifestEntry>();
	for (const e of serverManifest) serverById.set(e.id, e);
	const localById = new Map<string, ManifestRecord>();
	for (const r of localManifest) localById.set(r.id, r);

	// Step B: detect duplicate huma_uuid (corruption — refuse to act).
	const scannedByUuidAll = new Map<string, ScannedFile[]>();
	const scannedNoUuid: ScannedFile[] = [];
	for (const f of scannedFiles) {
		if (f.uuid) {
			const existing = scannedByUuidAll.get(f.uuid);
			if (existing) existing.push(f);
			else scannedByUuidAll.set(f.uuid, [f]);
		} else scannedNoUuid.push(f);
	}
	const scannedByUuid = new Map<string, ScannedFile>();
	const duplicateUuids: DuplicateUuid[] = [];
	for (const [uuid, files] of scannedByUuidAll) {
		if (files.length === 1) scannedByUuid.set(uuid, files[0]!);
		else duplicateUuids.push({ uuid, paths: files.map((f) => f.path) });
	}
	const duplicateUuidSet = new Set(duplicateUuids.map((d) => d.uuid));

	// Step C: synthetic-server-entry promotion. Delta omits unchanged rows;
	// promote local-tracked UUIDs so edits/renames since lastSince reconcile.
	const serverByIdEffective = new Map<string, ManifestEntry>(serverById);
	for (const local of localManifest) {
		if (serverByIdEffective.has(local.id)) continue;
		serverByIdEffective.set(local.id, {
			id: local.id,
			path: local.path,
			version: local.version,
			hash: local.hash,
			deleted_at: null,
		});
	}

	// Step D: dispatch decide() over the union of UUIDs across all views.
	const uuidUnion = new Set<string>();
	for (const id of serverByIdEffective.keys()) uuidUnion.add(id);
	for (const id of localById.keys()) uuidUnion.add(id);
	for (const id of scannedByUuid.keys()) uuidUnion.add(id);

	const pulls: PullAction[] = [];
	const pushes: PushAction[] = [];
	const renamesLocal: RenameLocalAction[] = [];
	const staleDeletes: StaleLocalDeleteAction[] = [];
	const serverDeletes: ServerDeletedAction[] = [];
	let conflictCount = 0;

	for (const uuid of uuidUnion) {
		const serverPeek = serverByIdEffective.get(uuid) ?? null;
		// Guard B — duplicate-uuid skip. Tombstones still process.
		if (
			duplicateUuidSet.has(uuid) &&
			(!serverPeek || serverPeek.deleted_at === null)
		) continue;

		const server = serverPeek;
		const local = localById.get(uuid) ?? null;
		const scan = scannedByUuid.get(uuid) ?? null;

		// Server-side rename: emit rename-local separately, then rebind both
		// scan and local to server.path so decide produces the same-cycle
		// pull/push at the post-rename path WITHOUT firing the plugin-side
		// rename branch. Keeps decide() at 3 args.
		let effectiveScan: ScannedFile | null = scan;
		let effectiveLocal: ManifestRecord | null = local;
		if (
			server && local && scan &&
			server.deleted_at === null &&
			server.path !== local.path && scan.path === local.path
		) {
			renamesLocal.push({
				kind: "rename-local",
				id: actionId("rename-local", server.id),
				serverId: server.id,
				fromPath: local.path, toPath: server.path,
			});
			effectiveScan = { ...scan, path: server.path };
			effectiveLocal = { ...local, path: server.path };
		}

		const action = decide(server, effectiveLocal, effectiveScan);
		if (!action) continue;

		if (
			action.kind === "push" &&
			server && local && scan &&
			server.version > local.version &&
			scan.hash !== local.hash
		) conflictCount++;

		switch (action.kind) {
			case "pull": pulls.push(action); break;
			case "push": pushes.push(action); break;
			case "stale-local-delete": staleDeletes.push(action); break;
			case "server-deleted": serverDeletes.push(action); break;
			case "rename-local": renamesLocal.push(action); break;
			case "add": break;
		}
	}

	// Step E: trivial adds loop — scanned files with no huma_uuid.
	const adds: AddAction[] = scannedNoUuid.map((scan) => ({
		kind: "add",
		id: actionId("add", scan.path),
		path: scan.path,
	}));

	const actions: SyncAction[] = [
		...serverDeletes, ...renamesLocal, ...pulls,
		...pushes, ...adds, ...staleDeletes,
	];

	return {
		actions,
		stats: {
			add: adds.length, pull: pulls.length, push: pushes.length,
			renameLocal: renamesLocal.length, conflict: conflictCount,
			staleLocalDelete: staleDeletes.length,
			serverDeleted: serverDeletes.length,
			duplicateUuid: duplicateUuids.length,
		},
		duplicateUuids,
	};
}

// Pure per-UUID decision. Caller handles excluded-folder filtering,
// duplicate-uuid skipping, synthetic-server-entry promotion, and server-side
// rename emission (with scan-/local-shim path=server.path). Locked to 3
// parameters per ROADMAP success criterion #1. Returns null when no action.
export function decide(
	server: ManifestEntry | null,
	local: ManifestRecord | null,
	scan: ScannedFile | null,
): SyncAction | null {
	if (server && server.deleted_at !== null) {
		if (!local && !scan) return null;
		return {
			kind: "server-deleted",
			id: actionId("server-deleted", server.id),
			serverId: server.id,
			path: scan?.path ?? local?.path ?? server.path,
		};
	}

	if (server && !scan) {
		if (local) return {
			kind: "stale-local-delete",
			id: actionId("stale-local-delete", server.id),
			serverId: server.id,
			path: server.path,
		};
		return {
			kind: "pull",
			id: actionId("pull", server.id),
			serverId: server.id,
			path: server.path,
			conflictedLocally: false,
		};
	}

	if (!server && scan) {
		// no UUID → adds-loop handles it; local present → impossible after promotion.
		if (!scan.uuid || local) return null;
		return {
			kind: "push",
			id: actionId("push", scan.uuid),
			serverId: null,
			path: scan.path,
			previousPath: null,
		};
	}

	// server live, scan present — sub-matrix #6. serverRenamed handled upstream.
	if (!server || !scan) return null;
	const localEdited = local !== null && local.hash !== scan.hash;
	const serverNewer = local === null || server.version > local.version;

	if (serverNewer && !localEdited) return {
		kind: "pull",
		id: actionId("pull", server.id),
		serverId: server.id,
		path: scan.path,
		conflictedLocally: false,
	};
	if (localEdited) return {
		kind: "push",
		id: actionId("push", server.id),
		serverId: server.id,
		path: scan.path,
		previousPath: local && local.path !== scan.path ? local.path : null,
	};
	if (local && local.path !== scan.path) return {
		kind: "push",
		id: actionId("push", server.id),
		serverId: server.id,
		path: scan.path,
		previousPath: local.path,
	};
	return null;
}

function actionId(kind: string, key: string): string {
	return `${kind}:${key}`;
}
