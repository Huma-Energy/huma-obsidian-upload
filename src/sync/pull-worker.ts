import type { App, TFile } from "obsidian";
import type { VaultApiClient } from "../client/vault-api";
import type { ManifestRecord } from "../settings";
import type { PullFile } from "../types";
import { stringifyFile, withHumaUuid } from "./frontmatter";
import { sha256Hex } from "./hash";

export const PULL_BATCH_SIZE = 50;

export interface PullProgress {
	completed: number;
	total: number;
	lastError: string | null;
}

export interface PullWorkerHandlers {
	onProgress?(p: PullProgress): void;
}

export interface PullResult {
	updatedManifest: ManifestRecord[];
	written: number;
	errors: Array<{ id: string; error: string }>;
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
	handlers: PullWorkerHandlers = {},
): Promise<PullResult> {
	const manifestById = new Map<string, ManifestRecord>();
	for (const r of currentManifest) manifestById.set(r.id, r);

	const errors: PullResult["errors"] = [];
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
				const record = await writePulledFile(app, file);
				manifestById.set(record.id, record);
				written++;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push({ id: file.id, error: message });
			}
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
	};
}

async function writePulledFile(
	app: App,
	file: PullFile,
): Promise<ManifestRecord> {
	const frontmatter = withHumaUuid(file.frontmatter ?? {}, file.id);
	const text = stringifyFile(file.body, frontmatter);
	const existing = app.vault.getAbstractFileByPath(file.path);

	if (existing && isMarkdownTFile(existing)) {
		await app.vault.modify(existing, text);
	} else if (existing) {
		throw new Error(
			`Vault path ${file.path} is not a markdown file; refusing to overwrite.`,
		);
	} else {
		await ensureParentFolder(app, file.path);
		await app.vault.create(file.path, text);
	}

	const hash = await sha256Hex(file.body);
	return {
		id: file.id,
		path: file.path,
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
