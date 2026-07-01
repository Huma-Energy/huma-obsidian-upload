// Unit tests for folder-share rule logic: folder membership + exclusion,
// most-specific-rule governance for nested folders, uncovered-set computation,
// destructive-edit detection, collaborator diffing, and the injected-API
// application layer (additive vs reconcile, owner-gating, call ordering). No
// Obsidian or network — the API is a recording stub.

import { describe, expect, it } from "vitest";
import type { FolderShareRule } from "../../src/settings";
import type { ShareStateResponse } from "../../src/types";
import {
	type ShareApi,
	applyRule,
	applyRuleToNotes,
	diffCollaborators,
	isDestructiveEdit,
	isNarrowing,
	isUnderFolder,
	notesGovernedByRule,
	notesUnderFolder,
	uncoveredSyncedUuids,
} from "../../src/sync/folder-share";

function rule(partial: Partial<FolderShareRule> = {}): FolderShareRule {
	return {
		folderPath: "projects",
		visibility: "private",
		tenantRole: "editor",
		collaborators: [],
		updatedAt: "2026-01-01T00:00:00.000Z",
		coveredUuids: [],
		...partial,
	};
}

function state(partial: Partial<ShareStateResponse> = {}): ShareStateResponse {
	return {
		ok: true,
		isOwner: true,
		callerRole: "owner",
		ownerId: "owner-1",
		owner: null,
		tenantId: "tenant-1",
		visibility: "private",
		publicSlug: null,
		tenantRole: "editor",
		collaborators: [],
		...partial,
	};
}

interface StubOptions {
	state?: ShareStateResponse;
	throwOn?: { method: keyof ShareApi; error: unknown };
}

function makeApi(opts: StubOptions = {}): { api: ShareApi; calls: string[] } {
	const calls: string[] = [];
	const resolved = opts.state ?? state();
	const guard = (method: keyof ShareApi) => {
		if (opts.throwOn && opts.throwOn.method === method) throw opts.throwOn.error;
	};
	const api: ShareApi = {
		async getShareState(uuid) {
			calls.push(`get:${uuid}`);
			guard("getShareState");
			return resolved;
		},
		async setVisibility(uuid, v) {
			calls.push(`vis:${uuid}:${v}`);
			guard("setVisibility");
		},
		async setTenantRole(uuid, r) {
			calls.push(`trole:${uuid}:${r}`);
			guard("setTenantRole");
		},
		async addCollaborator(uuid, id, r) {
			calls.push(`add:${uuid}:${id}:${r}`);
			guard("addCollaborator");
		},
		async updateCollaboratorRole(uuid, id, r) {
			calls.push(`upd:${uuid}:${id}:${r}`);
			guard("updateCollaboratorRole");
		},
		async removeCollaborator(uuid, id) {
			calls.push(`rem:${uuid}:${id}`);
			guard("removeCollaborator");
		},
	};
	return { api, calls };
}

describe("folder membership", () => {
	it("isUnderFolder matches only true path descendants", () => {
		expect(isUnderFolder("projects/a.md", "projects")).toBe(true);
		expect(isUnderFolder("projects/sub/a.md", "projects")).toBe(true);
		expect(isUnderFolder("projects.md", "projects")).toBe(false);
		// Sibling prefix must not match ("projects-old" is not under "projects").
		expect(isUnderFolder("projects-old/a.md", "projects")).toBe(false);
		// Empty path is the vault root — contains everything.
		expect(isUnderFolder("anything/a.md", "")).toBe(true);
	});

	it("notesUnderFolder drops excluded notes", () => {
		const notes = [
			{ path: "projects/a.md", uuid: "a" },
			{ path: "projects/secret/b.md", uuid: "b" },
			{ path: "other/c.md", uuid: "c" },
		];
		const result = notesUnderFolder(notes, "projects", ["projects/secret"]);
		expect(result.map((n) => n.path)).toEqual(["projects/a.md"]);
	});

	it("notesGovernedByRule yields child notes to a more-specific rule", () => {
		const notes = [
			{ path: "projects/a.md", uuid: "a" },
			{ path: "projects/alpha/b.md", uuid: "b" },
		];
		const parent = rule({ folderPath: "projects" });
		const child = rule({ folderPath: "projects/alpha" });
		const all = [parent, child];
		expect(
			notesGovernedByRule(notes, parent, all, []).map((n) => n.uuid),
		).toEqual(["a"]);
		expect(
			notesGovernedByRule(notes, child, all, []).map((n) => n.uuid),
		).toEqual(["b"]);
	});
});

describe("uncoveredSyncedUuids", () => {
	it("returns synced, uncovered, de-duplicated uuids", () => {
		const notes = [
			{ path: "a.md", uuid: "u1" },
			{ path: "b.md", uuid: null }, // unsynced
			{ path: "c.md", uuid: "u2" }, // already covered
			{ path: "d.md", uuid: "u1" }, // duplicate uuid
		];
		expect(uncoveredSyncedUuids(notes, ["u2"])).toEqual(["u1"]);
	});
});

describe("isDestructiveEdit", () => {
	it("flags narrowed visibility", () => {
		expect(
			isDestructiveEdit(
				rule({ visibility: "public" }),
				rule({ visibility: "tenant" }),
			),
		).toBe(true);
	});

	it("flags a downgraded tenant role while staying tenant", () => {
		expect(
			isDestructiveEdit(
				rule({ visibility: "tenant", tenantRole: "editor" }),
				rule({ visibility: "tenant", tenantRole: "viewer" }),
			),
		).toBe(true);
	});

	it("flags a removed or downgraded collaborator", () => {
		const before = rule({ collaborators: [{ userId: "x", role: "editor" }] });
		expect(isDestructiveEdit(before, rule({ collaborators: [] }))).toBe(true);
		expect(
			isDestructiveEdit(
				before,
				rule({ collaborators: [{ userId: "x", role: "viewer" }] }),
			),
		).toBe(true);
	});

	it("does not flag widening or additions", () => {
		expect(
			isDestructiveEdit(
				rule({ visibility: "private", collaborators: [] }),
				rule({
					visibility: "tenant",
					collaborators: [{ userId: "x", role: "editor" }],
				}),
			),
		).toBe(false);
	});
});

describe("isNarrowing", () => {
	it("orders private < tenant < public", () => {
		expect(isNarrowing("public", "private")).toBe(true);
		expect(isNarrowing("private", "public")).toBe(false);
		expect(isNarrowing("tenant", "tenant")).toBe(false);
	});
});

describe("diffCollaborators", () => {
	it("computes add / update / remove and excludes the owner", () => {
		const current = [
			{ userId: "keep", role: "viewer" as const },
			{ userId: "drop", role: "editor" as const },
			{ userId: "owner-1", role: "editor" as const }, // stray owner row
		];
		const desired = [
			{ userId: "keep", role: "editor" as const }, // role change
			{ userId: "new", role: "commenter" as const }, // add
			{ userId: "owner-1", role: "viewer" as const }, // owner ignored
		];
		const diff = diffCollaborators(current, desired, "owner-1");
		expect(diff.toAdd).toEqual([{ userId: "new", role: "commenter" }]);
		expect(diff.toUpdate).toEqual([{ userId: "keep", role: "editor" }]);
		expect(diff.toRemove).toEqual(["drop"]);
	});
});

describe("applyRule additive", () => {
	it("sets visibility, tenant role, and adds collaborators in order", async () => {
		const { api, calls } = makeApi();
		const r = rule({
			visibility: "tenant",
			tenantRole: "commenter",
			collaborators: [{ userId: "alice", role: "editor" }],
		});
		const result = await applyRule(api, "u1", r, "additive");
		expect(result.status).toBe("applied");
		expect(result.finalState).toBeDefined();
		expect(calls).toEqual([
			"vis:u1:tenant",
			"trole:u1:commenter",
			"add:u1:alice:editor",
			"get:u1",
		]);
	});

	it("skips a note the caller does not own and does not write collaborators", async () => {
		const { api, calls } = makeApi({
			throwOn: { method: "setVisibility", error: { status: 403 } },
		});
		const r = rule({ collaborators: [{ userId: "alice", role: "editor" }] });
		const result = await applyRule(api, "u1", r, "additive");
		expect(result.status).toBe("skipped-not-owner");
		expect(calls).toEqual(["vis:u1:private"]);
	});

	it("reports a non-403 failure as an error", async () => {
		const { api } = makeApi({
			throwOn: { method: "setVisibility", error: new Error("boom") },
		});
		const result = await applyRule(api, "u1", rule(), "additive");
		expect(result.status).toBe("error");
		expect(result.error).toBe("boom");
	});
});

describe("applyRule reconcile", () => {
	it("makes the note match the rule, removing extra collaborators", async () => {
		const { api, calls } = makeApi({
			state: state({
				visibility: "private",
				tenantRole: "viewer",
				collaborators: [
					{ userId: "bob", role: "viewer", addedAt: "x", user: null },
				],
			}),
		});
		const r = rule({
			visibility: "tenant",
			tenantRole: "editor",
			collaborators: [{ userId: "alice", role: "editor" }],
		});
		const result = await applyRule(api, "u1", r, "reconcile");
		expect(result.status).toBe("applied");
		expect(calls).toEqual([
			"get:u1",
			"vis:u1:tenant",
			"trole:u1:editor",
			"add:u1:alice:editor",
			"rem:u1:bob",
			"get:u1",
		]);
	});

	it("skips when the caller is not the owner (no mutations)", async () => {
		const { api, calls } = makeApi({ state: state({ isOwner: false }) });
		const result = await applyRule(api, "u1", rule(), "reconcile");
		expect(result.status).toBe("skipped-not-owner");
		expect(calls).toEqual(["get:u1"]);
	});
});

describe("applyRuleToNotes", () => {
	it("applies the rule to each uuid and returns one result per note in order", async () => {
		const { api } = makeApi();
		const results = await applyRuleToNotes(api, ["u1", "u2"], rule(), "additive");
		expect(results.map((r) => r.uuid)).toEqual(["u1", "u2"]);
		expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
	});
});
