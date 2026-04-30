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
	};
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

	const scannedByUuid = new Map<string, ScannedFile>();
	const scannedNoUuid: ScannedFile[] = [];
	for (const f of scannedFiles) {
		if (f.uuid) scannedByUuid.set(f.uuid, f);
		else scannedNoUuid.push(f);
	}

	const pulls: PullAction[] = [];
	const pushes: PushAction[] = [];
	const adds: AddAction[] = [];
	const renamesLocal: RenameLocalAction[] = [];
	const staleDeletes: StaleLocalDeleteAction[] = [];
	const serverDeletes: ServerDeletedAction[] = [];
	let conflictCount = 0;

	// Pass 1: every server-known file.
	for (const serverEntry of serverManifest) {
		const local = localById.get(serverEntry.id);
		const scanned = scannedByUuid.get(serverEntry.id);

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

	// Pass 2: scanned files with a huma_uuid the server doesn't know about.
	// Treat as adds — server will reject if the UUID conflicts.
	for (const [uuid, scanned] of scannedByUuid) {
		if (serverById.has(uuid)) continue;
		// The scanner saw a UUID frontmatter, but neither the server nor
		// local manifest knows it. Two cases: (a) bulk import wrote the UUID
		// before the server registered it, (b) UUID frontmatter is stale
		// from a previous deleted-then-recreated file. Either way the server
		// is the authority — push and let it allocate or recognise.
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
		},
	};
}

function actionId(kind: string, key: string): string {
	return `${kind}:${key}`;
}
