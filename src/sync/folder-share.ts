// Folder-share rule logic: membership, coverage, and fan-out application of a
// standing FolderShareRule to the synced notes under a vault folder. Pure
// helpers (folder membership, uncovered-set, collaborator diff, destructive-
// edit detection) plus an injected-API orchestration layer so both the passive
// post-sync pass (additive, new notes only) and deliberate rule-edit
// propagation (reconcile, whole folder) are unit-testable without Obsidian.

import type {
	ShareAssignableRole,
	ShareStateResponse,
	ShareVisibility,
} from "../types";
import type { FolderShareCollaborator, FolderShareRule } from "../settings";
import { isExcludedPath } from "./exclusion";

// A vault note as far as folder sharing cares: its current path and its
// huma_uuid (null when the note has never synced, so has no document to share).
export interface FolderNote {
	path: string;
	uuid: string | null;
}

// Visibility is a total order for "narrowing" detection: private < tenant <
// public. Role is ordered for downgrade detection: viewer < commenter < editor.
const VISIBILITY_RANK: Record<ShareVisibility, number> = {
	private: 0,
	tenant: 1,
	public: 2,
};
const ROLE_RANK: Record<ShareAssignableRole, number> = {
	viewer: 0,
	commenter: 1,
	editor: 2,
};

// A file sits under a folder when its path is prefixed by "<folder>/". The
// empty string denotes the vault root, which contains every note.
export function isUnderFolder(filePath: string, folderPath: string): boolean {
	if (folderPath === "") return true;
	return filePath.startsWith(folderPath + "/");
}

// Notes under a folder (recursive), minus anything in an excluded folder —
// excluded notes never sync, so they can never carry a shareable document.
export function notesUnderFolder(
	notes: readonly FolderNote[],
	folderPath: string,
	excludedFolders: readonly string[],
): FolderNote[] {
	return notes.filter(
		(n) =>
			isUnderFolder(n.path, folderPath) &&
			!isExcludedPath(n.path, excludedFolders),
	);
}

// Notes this rule governs: under its folder, not excluded, and NOT also under a
// more-specific rule (one whose folderPath is longer and still contains the
// note). Most-specific-folder wins, so a rule on a parent folder does not fight
// a rule on a child folder over the child's notes.
export function notesGovernedByRule(
	notes: readonly FolderNote[],
	rule: FolderShareRule,
	allRules: readonly FolderShareRule[],
	excludedFolders: readonly string[],
): FolderNote[] {
	const moreSpecific = allRules.filter(
		(r) => r !== rule && isUnderFolder(r.folderPath, rule.folderPath),
	);
	return notesUnderFolder(notes, rule.folderPath, excludedFolders).filter(
		(n) => !moreSpecific.some((r) => isUnderFolder(n.path, r.folderPath)),
	);
}

// UUIDs of synced notes not yet covered by the rule at its current version.
// De-duplicated: a corrupted vault with two files sharing a uuid yields one.
export function uncoveredSyncedUuids(
	notes: readonly FolderNote[],
	coveredUuids: readonly string[],
): string[] {
	const covered = new Set(coveredUuids);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const n of notes) {
		if (!n.uuid || covered.has(n.uuid) || seen.has(n.uuid)) continue;
		seen.add(n.uuid);
		out.push(n.uuid);
	}
	return out;
}

export function isNarrowing(from: ShareVisibility, to: ShareVisibility): boolean {
	return VISIBILITY_RANK[to] < VISIBILITY_RANK[from];
}

function isRoleDowngrade(from: ShareAssignableRole, to: ShareAssignableRole): boolean {
	return ROLE_RANK[to] < ROLE_RANK[from];
}

// A deliberate edit is "destructive" when re-applying it can reduce access:
// visibility narrowed, tenant role downgraded (while staying tenant), or a
// collaborator removed / downgraded. The panel confirms before propagating
// these across every note in the folder.
export function isDestructiveEdit(
	before: FolderShareRule,
	after: FolderShareRule,
): boolean {
	if (isNarrowing(before.visibility, after.visibility)) return true;
	if (
		before.visibility === "tenant" &&
		after.visibility === "tenant" &&
		isRoleDowngrade(before.tenantRole, after.tenantRole)
	) {
		return true;
	}
	const afterById = new Map(after.collaborators.map((c) => [c.userId, c.role]));
	for (const b of before.collaborators) {
		const a = afterById.get(b.userId);
		if (a === undefined) return true;
		if (isRoleDowngrade(b.role, a)) return true;
	}
	return false;
}

export interface CollaboratorDiff {
	toAdd: FolderShareCollaborator[];
	toUpdate: FolderShareCollaborator[];
	toRemove: string[];
}

// Diff a note's current collaborators against the rule's desired set. The owner
// is never a collaborator, so it is excluded from both sides defensively.
export function diffCollaborators(
	current: readonly { userId: string; role: ShareAssignableRole }[],
	desired: readonly FolderShareCollaborator[],
	ownerId: string | null,
): CollaboratorDiff {
	const currentById = new Map(
		current.filter((c) => c.userId !== ownerId).map((c) => [c.userId, c.role]),
	);
	const desiredIds = new Set<string>();
	const toAdd: FolderShareCollaborator[] = [];
	const toUpdate: FolderShareCollaborator[] = [];
	for (const d of desired) {
		if (d.userId === ownerId) continue;
		desiredIds.add(d.userId);
		const cur = currentById.get(d.userId);
		if (cur === undefined) toAdd.push(d);
		else if (cur !== d.role) toUpdate.push(d);
	}
	const toRemove = [...currentById.keys()].filter((id) => !desiredIds.has(id));
	return { toAdd, toUpdate, toRemove };
}

// ---- Application (injected API) ----
// Matches VaultApiClient's sharing method shapes. addCollaborator takes an
// identifier; a zitadelSub is a valid identifier the server resolves.
export interface ShareApi {
	getShareState(uuid: string): Promise<ShareStateResponse>;
	setVisibility(uuid: string, visibility: ShareVisibility): Promise<unknown>;
	setTenantRole(uuid: string, role: ShareAssignableRole): Promise<unknown>;
	addCollaborator(
		uuid: string,
		identifier: string,
		role: ShareAssignableRole,
	): Promise<unknown>;
	updateCollaboratorRole(
		uuid: string,
		userId: string,
		role: ShareAssignableRole,
	): Promise<unknown>;
	removeCollaborator(uuid: string, userId: string): Promise<unknown>;
}

export type ApplyMode = "additive" | "reconcile";

export interface NoteApplyResult {
	uuid: string;
	status: "applied" | "skipped-not-owner" | "error";
	// Server truth after the mutations, for the caller's frontmatter mirror.
	// Present only when status === "applied".
	finalState?: ShareStateResponse;
	error?: string;
}

// A 403 from the share endpoint means the caller is not the note's owner —
// mutations are owner-only. Duck-typed so this module needn't import HttpError.
function isForbidden(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { status?: number }).status === 403
	);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// Apply the rule to a single note.
//   additive  — set visibility/tenant-role + add the rule's collaborators.
//               For new (uncovered) notes: they start owner-only, so nothing is
//               removed. Idempotent server-side, so a re-run is harmless.
//   reconcile — read current state and make it MATCH the rule, including
//               removing/downgrading collaborators not in the rule. Used only
//               for deliberate, user-confirmed propagation of a rule edit.
export async function applyRule(
	api: ShareApi,
	uuid: string,
	rule: FolderShareRule,
	mode: ApplyMode,
): Promise<NoteApplyResult> {
	try {
		if (mode === "reconcile") {
			const state = await api.getShareState(uuid);
			if (!state.isOwner) return { uuid, status: "skipped-not-owner" };
			if (state.visibility !== rule.visibility) {
				await api.setVisibility(uuid, rule.visibility);
			}
			if (
				rule.visibility === "tenant" &&
				state.tenantRole !== rule.tenantRole
			) {
				await api.setTenantRole(uuid, rule.tenantRole);
			}
			const diff = diffCollaborators(
				state.collaborators,
				rule.collaborators,
				state.ownerId,
			);
			for (const c of diff.toAdd) await api.addCollaborator(uuid, c.userId, c.role);
			for (const c of diff.toUpdate) {
				await api.updateCollaboratorRole(uuid, c.userId, c.role);
			}
			for (const id of diff.toRemove) await api.removeCollaborator(uuid, id);
		} else {
			// setVisibility first so a non-owner note fails fast (403) before
			// any collaborator writes.
			await api.setVisibility(uuid, rule.visibility);
			if (rule.visibility === "tenant") {
				await api.setTenantRole(uuid, rule.tenantRole);
			}
			for (const c of rule.collaborators) {
				await api.addCollaborator(uuid, c.userId, c.role);
			}
		}
		const finalState = await api.getShareState(uuid);
		return { uuid, status: "applied", finalState };
	} catch (err) {
		if (isForbidden(err)) return { uuid, status: "skipped-not-owner" };
		return { uuid, status: "error", error: errorMessage(err) };
	}
}

// Apply the rule to many notes sequentially (bounded, predictable ordering so
// the caller can update coverage + mirrors as it goes). Folder shares are tens
// of notes, not thousands; sequential keeps request pressure low.
export async function applyRuleToNotes(
	api: ShareApi,
	uuids: readonly string[],
	rule: FolderShareRule,
	mode: ApplyMode,
	onResult?: (result: NoteApplyResult) => void,
): Promise<NoteApplyResult[]> {
	const results: NoteApplyResult[] = [];
	for (const uuid of uuids) {
		const result = await applyRule(api, uuid, rule, mode);
		results.push(result);
		onResult?.(result);
	}
	return results;
}
