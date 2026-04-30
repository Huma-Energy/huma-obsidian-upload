import { normalizePath, type App, type TFile } from "obsidian";
import type { VaultApiClient } from "../client/vault-api";
import type { ManifestRecord } from "../settings";
import type { PullFile } from "../types";
import { replaceFileBody, stringifyFile, withHumaUuid } from "./frontmatter";
import { sha256Hex } from "./hash";
import type { SelfWriteTracker } from "./self-write-tracker";

export const PULL_BATCH_SIZE = 50;

export interface PullProgress {
	completed: number;
	total: number;
	lastError: string | null;
}

export interface PullWorkerHandlers {
	onProgress?(p: PullProgress): void;
	// Called after each batch with the running manifest snapshot. Lets the
	// engine persist progress incrementally so a mid-cycle crash doesn't lose
	// files that were already written to the vault.
	onManifestUpdate?: (manifest: ManifestRecord[]) => Promise<void>;
}

export interface PullResult {
	updatedManifest: ManifestRecord[];
	written: number;
	errors: Array<{ id: string; error: string }>;
	audit: PullAuditEntry[];
}

export interface PullAuditEntry {
	id: string;
	path: string;
	version: number;
	timestamp: string;
}

// Pulls a list of UUIDs from the server in batches of 50, writes each file
// to the vault, and returns an updated manifest delta. Existing manifest
// entries are merged with the new versions; UUIDs not present in the input
// are passed through unchanged.
export async function runPullWorker(
	api: VaultApiClient,
	app: App,
	ids: readonly string[],
	currentManifest: readonly ManifestRecord[],
	tracker: SelfWriteTracker,
	handlers: PullWorkerHandlers = {},
): Promise<PullResult> {
	const manifestById = new Map<string, ManifestRecord>();
	for (const r of currentManifest) manifestById.set(r.id, r);

	const errors: PullResult["errors"] = [];
	const audit: PullAuditEntry[] = [];
	let written = 0;
	const total = ids.length;

	for (let i = 0; i < ids.length; i += PULL_BATCH_SIZE) {
		const batch = ids.slice(i, i + PULL_BATCH_SIZE);
		let response;
		try {
			response = await api.pull(batch);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			for (const id of batch) errors.push({ id, error: message });
			handlers.onProgress?.({
				completed: i + batch.length,
				total,
				lastError: message,
			});
			continue;
		}

		for (const file of response.files) {
			try {
				const record = await writePulledFile(app, file, tracker);
				manifestById.set(record.id, record);
				written++;
				audit.push({
					id: record.id,
					path: record.path,
					version: record.version,
					timestamp: record.lastSyncedAt,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push({ id: file.id, error: message });
			}
		}

		if (handlers.onManifestUpdate) {
			await handlers.onManifestUpdate(Array.from(manifestById.values()));
		}

		handlers.onProgress?.({
			completed: Math.min(i + PULL_BATCH_SIZE, total),
			total,
			lastError: null,
		});
	}

	return {
		updatedManifest: Array.from(manifestById.values()),
		written,
		errors,
		audit,
	};
}

async function writePulledFile(
	app: App,
	file: PullFile,
	tracker: SelfWriteTracker,
): Promise<ManifestRecord> {
	// Server-provided paths must be normalized before any vault op — guards
	// against accidental traversal segments and platform-mixed slashes.
	const safePath = normalizePath(file.path);
	const frontmatter = withHumaUuid(file.frontmatter ?? {}, file.id);
	const text = stringifyFile(file.body, frontmatter);
	const existing = app.vault.getAbstractFileByPath(safePath);
	const hash = await sha256Hex(file.body);

	tracker.record(safePath, hash);
	if (existing && isMarkdownTFile(existing)) {
		await replaceFileBody(app, existing, text);
	} else if (existing) {
		throw new Error(
			`Vault path ${safePath} is not a markdown file; refusing to overwrite.`,
		);
	} else {
		await ensureParentFolder(app, safePath);
		await app.vault.create(safePath, text);
	}

	return {
		id: file.id,
		path: safePath,
		version: file.version,
		hash,
		lastSyncedAt: new Date().toISOString(),
	};
}

function isMarkdownTFile(file: unknown): file is TFile {
	return (
		typeof file === "object" &&
		file !== null &&
		"stat" in file &&
		"extension" in (file as { extension?: unknown }) &&
		(file as { extension?: unknown }).extension === "md"
	);
}

async function ensureParentFolder(app: App, path: string): Promise<void> {
	const lastSlash = path.lastIndexOf("/");
	if (lastSlash <= 0) return;
	const folder = path.slice(0, lastSlash);
	if (app.vault.getAbstractFileByPath(folder)) return;
	await app.vault.createFolder(folder);
}
