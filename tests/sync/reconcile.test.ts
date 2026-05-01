import { describe, expect, it } from "vitest";
import { reconcile } from "../../src/sync/reconcile";
import type { ManifestEntry } from "../../src/types";
import type { ManifestRecord } from "../../src/settings";
import type { ScannedFile } from "../../src/sync/scan";

function serverEntry(p: Partial<ManifestEntry>): ManifestEntry {
	return {
		id: "id-1",
		path: "a.md",
		version: 1,
		hash: "h-server",
		deleted_at: null,
		...p,
	};
}

function localRecord(p: Partial<ManifestRecord>): ManifestRecord {
	return {
		id: "id-1",
		path: "a.md",
		version: 1,
		hash: "h-local",
		lastSyncedAt: "2026-04-01T00:00:00Z",
		...p,
	};
}

function scanned(p: Partial<ScannedFile>): ScannedFile {
	return {
		uuid: "id-1",
		path: "a.md",
		hash: "h-local",
		body: "body",
		frontmatter: {},
		mtime: 0,
		...p,
	};
}

describe("reconcile", () => {
	it("emits a pull when the server has a newer version and locally unchanged", () => {
		const out = reconcile({
			serverManifest: [serverEntry({ version: 2 })],
			localManifest: [localRecord({ version: 1 })],
			scanned: [scanned({})],
		});
		expect(out.actions.map((a) => a.kind)).toEqual(["pull"]);
		expect(out.stats).toMatchObject({ pull: 1, push: 0, conflict: 0 });
	});

	it("emits a push when the local file diverges from the manifest", () => {
		const out = reconcile({
			serverManifest: [serverEntry({ version: 1 })],
			localManifest: [localRecord({ version: 1, hash: "h-orig" })],
			scanned: [scanned({ hash: "h-edited" })],
		});
		expect(out.actions.map((a) => a.kind)).toEqual(["push"]);
		expect(out.stats.conflict).toBe(0);
	});

	it("emits a push and counts a conflict when both sides diverged", () => {
		const out = reconcile({
			serverManifest: [serverEntry({ version: 2, hash: "h-server-new" })],
			localManifest: [localRecord({ version: 1, hash: "h-orig" })],
			scanned: [scanned({ hash: "h-local-new" })],
		});
		expect(out.actions.map((a) => a.kind)).toEqual(["push"]);
		expect(out.stats.conflict).toBe(1);
	});

	it("emits an add for a scanned file with no huma_uuid", () => {
		const out = reconcile({
			serverManifest: [],
			localManifest: [],
			scanned: [scanned({ uuid: null, path: "new.md" })],
		});
		expect(out.actions).toEqual([
			{ kind: "add", id: "add:new.md", path: "new.md" },
		]);
	});

	it("emits a stale-local-delete when the file vanished locally", () => {
		const out = reconcile({
			serverManifest: [serverEntry({ id: "id-2", path: "gone.md" })],
			localManifest: [localRecord({ id: "id-2", path: "gone.md" })],
			scanned: [],
		});
		expect(out.actions.map((a) => a.kind)).toEqual(["stale-local-delete"]);
	});

	it("emits server-deleted for tombstoned server entries", () => {
		const out = reconcile({
			serverManifest: [
				serverEntry({ id: "id-3", deleted_at: "2026-04-15T00:00:00Z" }),
			],
			localManifest: [localRecord({ id: "id-3" })],
			scanned: [scanned({ uuid: "id-3" })],
		});
		expect(out.actions.map((a) => a.kind)).toEqual(["server-deleted"]);
	});

	it("emits a push with previous_path when the local file was renamed", () => {
		const out = reconcile({
			serverManifest: [serverEntry({ id: "id-4", path: "old.md" })],
			localManifest: [localRecord({ id: "id-4", path: "old.md" })],
			scanned: [
				scanned({ uuid: "id-4", path: "new.md", hash: "h-local" }),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "push",
				id: "push:id-4",
				serverId: "id-4",
				path: "new.md",
				previousPath: "old.md",
			},
		]);
	});

	it("orders pulls before pushes before adds", () => {
		const out = reconcile({
			serverManifest: [
				serverEntry({ id: "p1", path: "p1.md", version: 2 }),
				serverEntry({ id: "p2", path: "p2.md", version: 1, hash: "x" }),
			],
			localManifest: [
				localRecord({ id: "p1", path: "p1.md", version: 1 }),
				localRecord({ id: "p2", path: "p2.md", version: 1, hash: "p2-old" }),
			],
			scanned: [
				scanned({ uuid: "p1", path: "p1.md", hash: "h-local" }),
				scanned({ uuid: "p2", path: "p2.md", hash: "p2-edited" }),
				scanned({ uuid: null, path: "fresh.md" }),
			],
		});
		const kinds = out.actions.map((a) => a.kind);
		expect(kinds.indexOf("pull")).toBeLessThan(kinds.indexOf("push"));
		expect(kinds.indexOf("push")).toBeLessThan(kinds.indexOf("add"));
	});

	it("produces stable action ids deterministically across runs", () => {
		const input = {
			serverManifest: [serverEntry({ version: 2 })],
			localManifest: [localRecord({ version: 1 })],
			scanned: [scanned({})],
		};
		const a = reconcile(input);
		const b = reconcile(input);
		expect(a.actions.map((x) => x.id)).toEqual(b.actions.map((x) => x.id));
	});

	it("emits no actions for server entries inside an excluded folder", () => {
		const out = reconcile({
			serverManifest: [
				serverEntry({ id: "id-x", path: "drafts/secret.md", version: 5 }),
			],
			localManifest: [
				localRecord({ id: "id-x", path: "drafts/secret.md", version: 4 }),
			],
			scanned: [],
			excludedFolders: ["drafts"],
		});
		expect(out.actions).toEqual([]);
		expect(out.stats).toMatchObject({
			pull: 0,
			push: 0,
			staleLocalDelete: 0,
			serverDeleted: 0,
		});
	});

	it("does not push a scanned file inside an excluded folder", () => {
		const out = reconcile({
			serverManifest: [],
			localManifest: [],
			scanned: [scanned({ uuid: null, path: "drafts/new.md" })],
			excludedFolders: ["drafts"],
		});
		expect(out.actions).toEqual([]);
	});

	it("emits rename-local when server moved a file the user did not", () => {
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "id-r",
					path: "Habitats/KLP/testklp.md",
					version: 2,
					hash: "h-local",
				}),
			],
			localManifest: [
				localRecord({
					id: "id-r",
					path: "testklp.md",
					version: 2,
					hash: "h-local",
				}),
			],
			scanned: [
				scanned({ uuid: "id-r", path: "testklp.md", hash: "h-local" }),
			],
		});
		expect(out.actions).toHaveLength(1);
		expect(out.actions[0]).toEqual({
			kind: "rename-local",
			id: "rename-local:id-r",
			serverId: "id-r",
			fromPath: "testklp.md",
			toPath: "Habitats/KLP/testklp.md",
		});
		expect(out.stats.renameLocal).toBe(1);
	});

	it("rename-local plus pull when server renamed and bumped version", () => {
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "id-r",
					path: "new/path.md",
					version: 3,
					hash: "h-new",
				}),
			],
			localManifest: [
				localRecord({
					id: "id-r",
					path: "old/path.md",
					version: 2,
					hash: "h-local",
				}),
			],
			scanned: [
				// User hasn't edited locally — scan hash matches local manifest.
				scanned({ uuid: "id-r", path: "old/path.md", hash: "h-local" }),
			],
		});
		const kinds = out.actions.map((a) => a.kind);
		expect(kinds).toEqual(["rename-local", "pull"]);
		const pullAction = out.actions.find((a) => a.kind === "pull")!;
		// Pull targets the post-rename path so the same-cycle write lands at
		// the (now-existing) renamed file.
		expect((pullAction as { path: string }).path).toBe("new/path.md");
	});

	it("dedupes scanned files that share a huma_uuid — last occurrence wins", () => {
		// Corrupted-import case: two vault files carry the same huma_uuid (e.g.
		// user copy-pasted a synced note). scannedByUuid stores the second one
		// over the first; the first is silently skipped. Locking this in so a
		// future refactor of the dedupe map can't regress behavior without
		// the test surfacing it.
		const out = reconcile({
			serverManifest: [serverEntry({ id: "dup", path: "a.md", hash: "h-local" })],
			localManifest: [localRecord({ id: "dup", path: "a.md", hash: "h-local" })],
			scanned: [
				// First occurrence: in-sync at "a.md" — would be a no-op on its own.
				scanned({ uuid: "dup", path: "a.md", hash: "h-local" }),
				// Second occurrence: at "b.md" — would produce a push-rename on its own.
				scanned({ uuid: "dup", path: "b.md", hash: "h-local" }),
			],
		});
		expect(out.actions).toHaveLength(1);
		expect(out.actions[0]).toEqual({
			kind: "push",
			id: "push:dup",
			serverId: "dup",
			path: "b.md",
			previousPath: "a.md",
		});
	});

	it("does not emit plugin-side push-rename when scan path matches local", () => {
		// Server-renamed scenario; ensure we don't ALSO produce a push that
		// would try to rename the server back to the old path.
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "id-r",
					path: "new.md",
					version: 1,
					hash: "h-local",
				}),
			],
			localManifest: [
				localRecord({
					id: "id-r",
					path: "old.md",
					version: 1,
					hash: "h-local",
				}),
			],
			scanned: [
				scanned({ uuid: "id-r", path: "old.md", hash: "h-local" }),
			],
		});
		const kinds = out.actions.map((a) => a.kind);
		expect(kinds).toEqual(["rename-local"]);
	});
});
