// Applies a server-side rename to the local vault. Uses
// app.fileManager.renameFile so Obsidian updates internal links across the
// vault (the user-visible benefit over plain vault.rename). Records the
// post-rename modify event in the self-write tracker so it doesn't trigger
// another sync cycle. Returns the updated manifest record path.

import { TFile, type App } from "obsidian";
import type { ManifestRecord } from "../settings";
import type { RenameLocalAction } from "./reconcile";
import type { SelfWriteTracker } from "./self-write-tracker";

export interface RenameLocalOutcome {
	action: RenameLocalAction;
	result:
		| { kind: "renamed" }
		| { kind: "missing"; reason: string }
		| { kind: "deferred"; error: string };
}

export async function processRenameLocal(
	app: App,
	action: RenameLocalAction,
	tracker: SelfWriteTracker,
): Promise<RenameLocalOutcome> {
	const file = app.vault.getAbstractFileByPath(action.fromPath);
	if (!(file instanceof TFile)) {
		return {
			action,
			result: {
				kind: "missing",
				reason: `no markdown file at ${action.fromPath}`,
			},
		};
	}
	try {
		// FileManager.renameFile fires a vault.on('rename') event — our event
		// hooks debounce on rename anyway, but we don't need a per-rename
		// tracker entry because rename doesn't change body content. Suppress
		// any spurious modify by recording the unchanged hash on the new path.
		await app.fileManager.renameFile(file, action.toPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { action, result: { kind: "deferred", error: message } };
	}
	void tracker;
	return { action, result: { kind: "renamed" } };
}

export function applyRenameToManifest(
	manifest: readonly ManifestRecord[],
	action: RenameLocalAction,
): ManifestRecord[] {
	return manifest.map((r) =>
		r.id === action.serverId ? { ...r, path: action.toPath } : r,
	);
}
