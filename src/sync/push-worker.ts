import type { App, TFile } from "obsidian";
import type { VaultApiClient } from "../client/vault-api";
import type { ManifestRecord } from "../settings";
import type { AuditEntry, PushRequest, PushResponse } from "../types";
import { emitConflict } from "./conflict";
import { stringifyFile, withHumaUuid } from "./frontmatter";
import { sha256Hex } from "./hash";
import type { ScannedFile } from "./scan";
import type { PushAction, AddAction } from "./reconcile";

export const PUSH_MAX_RETRIES = 3;
export const PUSH_INITIAL_BACKOFF_MS = 500;

export interface PushAttemptInput {
	action: PushAction | AddAction;
	scanned: ScannedFile;
	localManifest: ManifestRecord | null;
}

export interface PushOutcome {
	action: PushAttemptInput["action"];
	result:
		| { kind: "accept"; record: ManifestRecord }
		| { kind: "merge_clean"; record: ManifestRecord }
		| {
				kind: "merge_dirty";
				record: ManifestRecord;
				conflictPath: string;
		  }
		| { kind: "deferred"; error: string };
	audit: AuditEntry;
}

export interface PushWorkerHandlers {
	onProgress?(p: { completed: number; total: number }): void;
	sleep?: (ms: number) => Promise<void>;
}

export interface PushWorkerResult {
	updatedManifest: ManifestRecord[];
	outcomes: PushOutcome[];
}

// Drives push actions serially. Each action retries up to PUSH_MAX_RETRIES
// with exponential backoff on transient errors before being marked deferred
// (visible in the status bar count, retried on the next sync cycle).
export async function runPushWorker(
	api: VaultApiClient,
	app: App,
	inputs: readonly PushAttemptInput[],
	currentManifest: readonly ManifestRecord[],
	handlers: PushWorkerHandlers = {},
): Promise<PushWorkerResult> {
	const sleep = handlers.sleep ?? defaultSleep;
	const manifestById = new Map<string, ManifestRecord>();
	for (const r of currentManifest) manifestById.set(r.id, r);

	const outcomes: PushOutcome[] = [];

	for (let i = 0; i < inputs.length; i++) {
		const input = inputs[i]!;
		const outcome = await pushOne(api, app, input, sleep);
		outcomes.push(outcome);
		if (outcome.result.kind !== "deferred") {
			manifestById.set(outcome.result.record.id, outcome.result.record);
		}
		handlers.onProgress?.({ completed: i + 1, total: inputs.length });
	}

	return {
		updatedManifest: Array.from(manifestById.values()),
		outcomes,
	};
}

async function pushOne(
	api: VaultApiClient,
	app: App,
	input: PushAttemptInput,
	sleep: (ms: number) => Promise<void>,
): Promise<PushOutcome> {
	const req = buildRequest(input);
	let lastErr: unknown = null;
	for (let attempt = 0; attempt < PUSH_MAX_RETRIES; attempt++) {
		try {
			const response = await api.push(req);
			return await applyResponse(app, input, response);
		} catch (err) {
			lastErr = err;
			if (attempt < PUSH_MAX_RETRIES - 1) {
				await sleep(PUSH_INITIAL_BACKOFF_MS * 2 ** attempt);
			}
		}
	}
	const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
	return {
		action: input.action,
		result: { kind: "deferred", error: message },
		audit: {
			timestamp: new Date().toISOString(),
			event: "push_reject",
			path: input.scanned.path,
			id: actionUuid(input.action),
			detail: message,
		},
	};
}

function buildRequest(input: PushAttemptInput): PushRequest {
	const { action, scanned, localManifest } = input;
	const isAdd = action.kind === "add";
	return {
		id: isAdd ? null : (action as PushAction).serverId ?? null,
		base_version: localManifest?.version ?? null,
		path: scanned.path,
		previous_path: isAdd ? null : (action as PushAction).previousPath,
		body: scanned.body,
		frontmatter: emptyToNull(scanned.frontmatter),
		client_mtime: new Date(scanned.mtime || Date.now()).toISOString(),
	};
}

async function applyResponse(
	app: App,
	input: PushAttemptInput,
	response: PushResponse,
): Promise<PushOutcome> {
	const path = input.scanned.path;
	switch (response.action) {
		case "accept": {
			// First-push: write huma_uuid back into the file's frontmatter so
			// the next scan sees it. For non-first-push accepts the UUID is
			// already in frontmatter; rewrite is a no-op text-wise but we
			// recompute the body hash either way.
			await ensureUuidInVault(app, path, input.scanned, response.id);
			const hash = await sha256Hex(input.scanned.body);
			const record: ManifestRecord = {
				id: response.id,
				path,
				version: response.version,
				hash,
				lastSyncedAt: new Date().toISOString(),
			};
			return {
				action: input.action,
				result: { kind: "accept", record },
				audit: {
					timestamp: record.lastSyncedAt,
					event: "push_accept",
					path,
					id: response.id,
				},
			};
		}
		case "merge_clean": {
			const frontmatter = withHumaUuid(
				response.frontmatter ?? input.scanned.frontmatter,
				response.id,
			);
			const text = stringifyFile(response.body, frontmatter);
			await writeMarkdown(app, path, text);
			const hash = await sha256Hex(response.body);
			const record: ManifestRecord = {
				id: response.id,
				path,
				version: response.version,
				hash,
				lastSyncedAt: new Date().toISOString(),
			};
			return {
				action: input.action,
				result: { kind: "merge_clean", record },
				audit: {
					timestamp: record.lastSyncedAt,
					event: "merge_clean",
					path,
					id: response.id,
				},
			};
		}
		case "merge_dirty": {
			const emission = await emitConflict(app, {
				id: response.id,
				path,
				localBody: input.scanned.body,
				serverBody: response.server_body,
				serverFrontmatter: response.server_frontmatter,
			});
			const hash = await sha256Hex(response.server_body);
			const record: ManifestRecord = {
				id: response.id,
				path,
				version: response.server_version,
				hash,
				lastSyncedAt: new Date().toISOString(),
			};
			return {
				action: input.action,
				result: {
					kind: "merge_dirty",
					record,
					conflictPath: emission.conflictPath,
				},
				audit: {
					timestamp: record.lastSyncedAt,
					event: "merge_dirty",
					path,
					id: response.id,
					detail: emission.conflictPath,
				},
			};
		}
	}
}

async function ensureUuidInVault(
	app: App,
	path: string,
	scanned: ScannedFile,
	uuid: string,
): Promise<void> {
	if (scanned.frontmatter["huma_uuid"] === uuid) return;
	const frontmatter = withHumaUuid(scanned.frontmatter, uuid);
	const text = stringifyFile(scanned.body, frontmatter);
	await writeMarkdown(app, path, text);
}

async function writeMarkdown(
	app: App,
	path: string,
	text: string,
): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing && isMarkdownTFile(existing)) {
		await app.vault.modify(existing, text);
	} else if (!existing) {
		await app.vault.create(path, text);
	} else {
		throw new Error(
			`Vault path ${path} is not a markdown file; refusing to overwrite.`,
		);
	}
}

function isMarkdownTFile(file: unknown): file is TFile {
	return (
		typeof file === "object" &&
		file !== null &&
		"extension" in (file as { extension?: unknown }) &&
		(file as { extension?: unknown }).extension === "md"
	);
}

function emptyToNull(
	fm: Record<string, unknown>,
): Record<string, unknown> | null {
	return Object.keys(fm).length === 0 ? null : fm;
}

function actionUuid(action: PushAttemptInput["action"]): string | null {
	if (action.kind === "add") return null;
	return action.serverId;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
