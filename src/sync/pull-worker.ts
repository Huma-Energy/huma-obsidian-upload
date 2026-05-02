import { normalizePath, type App, type TFile } from "obsidian";
import { HttpError } from "../client/http";
import type { VaultApiClient } from "../client/vault-api";
import type { ManifestRecord } from "../settings";
import type { PullFile } from "../types";
import {
	parseFile,
	replaceFileBody,
	stringifyFile,
	withHumaUuid,
} from "./frontmatter";
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
	// Ids the server reported as not_found and that the plugin removed from
	// the local manifest. Engine emits a `pull_drop` audit per entry.
	dropped: PullDropEntry[];
}

export interface PullAuditEntry {
	id: string;
	path: string;
	version: number;
	timestamp: string;
}

export interface PullDropEntry {
	id: string;
	// Path the manifest had for the dropped id, if any. May be null if the
	// row was never present locally (e.g. row #3 of the master matrix where
	// the server fed an id we'd never seen).
	path: string | null;
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
	const dropped: PullDropEntry[] = [];
	let written = 0;
	const total = ids.length;

	for (let i = 0; i < ids.length; i += PULL_BATCH_SIZE) {
		const initialBatch = ids.slice(i, i + PULL_BATCH_SIZE);
		// Per-batch retry loop. The server fails an entire pull batch with
		// 404 { error: "not_found", id: <uuid> } when any one id is unknown.
		// Drop that id from the manifest, then re-issue with the survivors.
		// Cap the loop at batch.length so a misbehaving server (e.g. naming
		// an id that was never in the batch) can't spin forever.
		let remaining = initialBatch;
		let response: Awaited<ReturnType<typeof api.pull>> | null = null;
		let lastError: string | null = null;
		for (let attempt = 0; attempt < initialBatch.length + 1; attempt++) {
			if (remaining.length === 0) break;
			try {
				response = await api.pull(remaining);
				lastError = null;
				break;
			} catch (err) {
				const notFoundId = extractNotFoundId(err, remaining);
				if (notFoundId === null) {
					const message = err instanceof Error ? err.message : String(err);
					for (const id of remaining) errors.push({ id, error: message });
					lastError = message;
					response = null;
					break;
				}
				const existingPath = manifestById.get(notFoundId)?.path ?? null;
				manifestById.delete(notFoundId);
				dropped.push({
					id: notFoundId,
					path: existingPath,
					timestamp: new Date().toISOString(),
				});
				remaining = remaining.filter((id) => id !== notFoundId);
			}
		}

		if (response) {
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
		}

		if (handlers.onManifestUpdate) {
			await handlers.onManifestUpdate(Array.from(manifestById.values()));
		}

		handlers.onProgress?.({
			completed: Math.min(i + PULL_BATCH_SIZE, total),
			total,
			lastError,
		});
	}

	return {
		updatedManifest: Array.from(manifestById.values()),
		written,
		errors,
		audit,
		dropped,
	};
}

// Returns the id named in a `not_found` API error if the error matches the
// documented shape AND the id was actually in the requested batch; otherwise
// null so the caller falls through to generic error handling. The
// in-batch check guards against a misbehaving server naming a foreign id,
// which would otherwise loop until the safety cap.
function extractNotFoundId(
	err: unknown,
	batch: readonly string[],
): string | null {
	if (!(err instanceof HttpError)) return null;
	if (err.status !== 404) return null;
	if (err.apiError?.error !== "not_found") return null;
	const id = err.apiError.id;
	if (typeof id !== "string" || id.length === 0) return null;
	if (!batch.includes(id)) return null;
	return id;
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
	// Hash the body as parseFile would extract it from `text`, NOT the raw
	// `file.body`. gray-matter's empty-body round-trip emits a trailing "\n"
	// that scan would parse back; storing the raw-body hash here would make
	// the next scan falsely flag the file as locally-edited every cycle.
	const onDiskBody = parseFile(text).body;
	const hash = await sha256Hex(onDiskBody);

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
