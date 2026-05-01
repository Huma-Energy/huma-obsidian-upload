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

export interface AddAction {
	kind: "add";
	id: string;
	path: string;
}
export interface PullAction {
	kind: "pull";
	id: string;
	serverId: string;
	path: string;
	conflictedLocally: boolean;
}
export interface PushAction {
	kind: "push";
	id: string;
	serverId: string | null;
	path: string;
	previousPath: string | null;
}
// Server-side rename: same UUID exists locally but the server's path field
// differs from our manifest's path (and the file hasn't been moved locally).
// Plugin renames the local file via app.fileManager.renameFile so the next
// scan agrees with the server. Ordered before pulls so a same-cycle pull
// writes the new body at the (now-existing) renamed path.
export interface RenameLocalAction {
	kind: "rename-local";
	id: string;
	serverId: string;
	fromPath: string;
	toPath: string;
}
export interface StaleLocalDeleteAction {
	kind: "stale-local-delete";
	id: string;
	serverId: string;
	path: string;
}
export interface ServerDeletedAction {
	kind: "server-deleted";
	id: string;
	serverId: string;
	path: string;
}

export interface ReconcileInput {
	serverManifest: readonly ManifestEntry[];
	localManifest: readonly ManifestRecord[];
	scanned: readonly ScannedFile[];
	excludedFolders?: readonly string[];
}

export interface DuplicateUuid {
	uuid: string;
	paths: string[];
}

export interface ReconcileOutput {
	actions: SyncAction[];
	// Diagnostic counters surfaced via the status bar / audit log.
	stats: {
		add: number;
		pull: number;
		push: number;
		renameLocal: number;
		conflict: number;
		staleLocalDelete: number;
		serverDeleted: number;
		duplicateUuid: number;
	};
	// Vault files that share a huma_uuid. Reconcile refuses to push, pull, or
	// rename for these UUIDs; pushing the "winner" would tell the server to
	// rename the original (still on disk) and the next pull could clobber
	// content the user still has locally. Engine surfaces these via audit
	// + conflict status until the user removes the duplicate frontmatter.
	duplicateUuids: DuplicateUuid[];
}

// Reconciles three views of the vault into a deterministic ordered action list.
//
// Action ordering invariant: pulls before pushes before adds. Pulls first so
// the local manifest is up-to-date before any push uses base_version; pushes
// before adds so existing-file edits propagate before brand-new files (which
// are server-side allocations) compete for the same path.
//
// Each action carries a stable id (action.id) so the engine can resume after
// a partial failure: replaying reconcile after a crash produces the same
// action ids for the same residual work.
export function reconcile(input: ReconcileInput): ReconcileOutput {
	const excluded = input.excludedFolders ?? [];

	// Excluded folders drop out of all three views before reconcile sees them:
	// server entries don't pull, local manifest rows don't go stale, and
	// scanned files don't push. Files already on the server stay frozen at
	// their last-synced version until the user archives them manually.
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
	for (const e of localManifest) localById.set(e.id, e);

	// Group scanned files by UUID so we can detect duplicates: the same
	// huma_uuid appearing on more than one file is a corruption case (e.g.
	// user copy-pasted a synced note). Acting on it would push one file as
	// a rename of the other, with the loser still on disk — a real
	// data-loss path. Skip both files entirely until the user resolves it.
	const scannedByUuidAll = new Map<string, ScannedFile[]>();
	const scannedNoUuid: ScannedFile[] = [];
	for (const f of scannedFiles) {
		if (f.uuid) {
			const existing = scannedByUuidAll.get(f.uuid);
			if (existing) existing.push(f);
			else scannedByUuidAll.set(f.uuid, [f]);
		} else {
			scannedNoUuid.push(f);
		}
	}
	const scannedByUuid = new Map<string, ScannedFile>();
	const duplicateUuids: DuplicateUuid[] = [];
	for (const [uuid, files] of scannedByUuidAll) {
		if (files.length === 1) {
			scannedByUuid.set(uuid, files[0]!);
		} else {
			duplicateUuids.push({
				uuid,
				paths: files.map((f) => f.path),
			});
		}
	}

	const duplicateUuidSet = new Set(duplicateUuids.map((d) => d.uuid));

	const pulls: PullAction[] = [];
	const pushes: PushAction[] = [];
	const adds: AddAction[] = [];
	const renamesLocal: RenameLocalAction[] = [];
	const staleDeletes: StaleLocalDeleteAction[] = [];
	const serverDeletes: ServerDeletedAction[] = [];
	let conflictCount = 0;

	// Effective server view: the delta-mode manifest plus a synthetic entry
	// for every locally-tracked UUID the delta omitted. The omission means
	// the server hasn't changed that row since `lastSince`, so its
	// last-known state is exactly what local manifest stores. Without this,
	// a file the user has edited or renamed since the last sync would never
	// reconcile when delta mode hides its server row — Pass 1 would skip it
	// (not in delta) and Pass 2 would skip it (locally-known UUID per the
	// dedupe protection). The synthetic entry routes those cases through
	// Pass 1's existing rename / edit / stale-delete branches.
	const serverByIdEffective = new Map<string, ManifestEntry>(serverById);
	for (const local of localManifest) {
		if (serverByIdEffective.has(local.id)) continue;
		serverByIdEffective.set(local.id, {
			id: local.id,
			path: local.path,
			version: local.version,
			hash: local.hash,
			// If the server had tombstoned this row, the delta would have
			// returned it — absence implies still alive at the cached state.
			deleted_at: null,
		});
	}

	// Pass 1: every server-known file (delta + synthesised).
	for (const serverEntry of serverByIdEffective.values()) {
		const local = localById.get(serverEntry.id);
		const scanned = scannedByUuid.get(serverEntry.id);

		// Duplicate huma_uuid: refuse to act on a non-tombstoned server entry
		// whose id appears on more than one local file. Tombstones still
		// process normally — dropping the manifest row is safe regardless of
		// how many vault files claim the id.
		if (
			serverEntry.deleted_at === null &&
			duplicateUuidSet.has(serverEntry.id)
		) {
			continue;
		}

		if (serverEntry.deleted_at !== null) {
			// Server-side tombstone. Plugin drops the local manifest row; the
			// vault file (if any) is left alone — user decides what to do.
			if (local || scanned) {
				serverDeletes.push({
					kind: "server-deleted",
					id: actionId("server-deleted", serverEntry.id),
					serverId: serverEntry.id,
					path: scanned?.path ?? local?.path ?? serverEntry.path,
				});
			}
			continue;
		}

		if (!scanned) {
			if (local) {
				// Locally deleted but server still has it. Delete sync is
				// deferred to v1.1 — surface as stale.
				staleDeletes.push({
					kind: "stale-local-delete",
					id: actionId("stale-local-delete", serverEntry.id),
					serverId: serverEntry.id,
					path: serverEntry.path,
				});
			} else {
				// Server has it, plugin has never seen it. Pull.
				pulls.push({
					kind: "pull",
					id: actionId("pull", serverEntry.id),
					serverId: serverEntry.id,
					path: serverEntry.path,
					conflictedLocally: false,
				});
			}
			continue;
		}

		const localHashMatchesManifest =
			local !== undefined && local.hash === scanned.hash;
		const localEdited = local !== undefined && !localHashMatchesManifest;
		const serverNewer =
			local === undefined || serverEntry.version > local.version;

		// Server-side rename: server's path differs from our manifest, and
		// the file hasn't been moved locally (scan still at manifest path).
		// Emit rename-local; subsequent push/pull use the server path so they
		// operate on the post-rename file.
		const serverRenamed =
			local !== undefined &&
			serverEntry.path !== local.path &&
			scanned.path === local.path;
		if (serverRenamed && local !== undefined) {
			renamesLocal.push({
				kind: "rename-local",
				id: actionId("rename-local", serverEntry.id),
				serverId: serverEntry.id,
				fromPath: local.path,
				toPath: serverEntry.path,
			});
		}
		const logicalPath = serverRenamed ? serverEntry.path : scanned.path;

		if (serverNewer && !localEdited) {
			// Clean pull case.
			pulls.push({
				kind: "pull",
				id: actionId("pull", serverEntry.id),
				serverId: serverEntry.id,
				path: logicalPath,
				conflictedLocally: false,
			});
		} else if (serverNewer && localEdited) {
			// Both sides moved. Push will trigger server-side three-way merge;
			// reconcile emits a push and lets the push worker (task 6) decide
			// accept / merge_clean / merge_dirty.
			conflictCount++;
			pushes.push({
				kind: "push",
				id: actionId("push", serverEntry.id),
				serverId: serverEntry.id,
				path: logicalPath,
				previousPath:
					!serverRenamed && local && local.path !== scanned.path
						? local.path
						: null,
			});
		} else if (localEdited) {
			pushes.push({
				kind: "push",
				id: actionId("push", serverEntry.id),
				serverId: serverEntry.id,
				path: logicalPath,
				previousPath:
					!serverRenamed && local && local.path !== scanned.path
						? local.path
						: null,
			});
		} else if (
			!serverRenamed &&
			local !== undefined &&
			local.path !== scanned.path
		) {
			// Plugin-side rename — no body change but the local user moved
			// the file. Push the rename so the server's path field catches up.
			pushes.push({
				kind: "push",
				id: actionId("push", serverEntry.id),
				serverId: serverEntry.id,
				path: scanned.path,
				previousPath: local.path,
			});
		}
		// else: in-sync (or rename-local handles it alone), no further action.
	}

	// Pass 2: scanned files with a huma_uuid neither the server nor the
	// local manifest knows about. Two cases: (a) bulk import wrote the UUID
	// before the server registered it, (b) UUID frontmatter is stale from
	// a previous deleted-then-recreated file. Either way the server is the
	// authority — push and let it allocate or recognise.
	//
	// CRITICAL: we must skip UUIDs that ARE in the local manifest. The
	// server manifest is fetched in delta mode (`?since=lastSince`) and
	// returns only files modified inside that window; locally-known files
	// the user hasn't touched fall outside the window and are therefore
	// absent from `serverById`. Without the localById guard, every cycle
	// would re-push every previously-synced file as a "first push".
	for (const [uuid, scanned] of scannedByUuid) {
		if (serverById.has(uuid)) continue;
		if (localById.has(uuid)) continue;
		pushes.push({
			kind: "push",
			id: actionId("push", uuid),
			serverId: null,
			path: scanned.path,
			previousPath: null,
		});
	}

	// Pass 3: scanned files with no UUID at all — first-push adds.
	for (const scanned of scannedNoUuid) {
		adds.push({
			kind: "add",
			id: actionId("add", scanned.path),
			path: scanned.path,
		});
	}

	// Order: server-deletes, then rename-local (so a same-cycle pull lands at
	// the post-rename path), then pulls, pushes, adds, stale-deletes.
	const actions: SyncAction[] = [
		...serverDeletes,
		...renamesLocal,
		...pulls,
		...pushes,
		...adds,
		...staleDeletes,
	];

	return {
		actions,
		stats: {
			add: adds.length,
			pull: pulls.length,
			push: pushes.length,
			renameLocal: renamesLocal.length,
			conflict: conflictCount,
			staleLocalDelete: staleDeletes.length,
			serverDeleted: serverDeletes.length,
			duplicateUuid: duplicateUuids.length,
		},
		duplicateUuids,
	};
}

function actionId(kind: string, key: string): string {
	return `${kind}:${key}`;
}
