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

	it("master row #2: pushes with id=null when scan has a UUID neither side knows (pre-registration import)", () => {
		// Server-unknown UUID. Plugin treats as adopt-or-allocate via a push
		// with id=null; server either recognises the UUID or mints a new one.
		const out = reconcile({
			serverManifest: [],
			localManifest: [],
			scanned: [scanned({ uuid: "stranger-uuid", path: "imported.md" })],
		});
		expect(out.actions).toEqual([
			{
				kind: "push",
				id: "push:stranger-uuid",
				serverId: null,
				path: "imported.md",
				previousPath: null,
			},
		]);
	});

	it("master row #3: pulls first-time when server has a row neither local manifest nor scan has", () => {
		const out = reconcile({
			serverManifest: [serverEntry({ id: "fresh", path: "fresh.md", version: 1 })],
			localManifest: [],
			scanned: [],
		});
		expect(out.actions).toEqual([
			{
				kind: "pull",
				id: "pull:fresh",
				serverId: "fresh",
				path: "fresh.md",
				conflictedLocally: false,
			},
		]);
	});

	it("master row #4: pulls to recover when data.json was wiped (local manifest absent, file still on disk)", () => {
		// data.json got cleared / fresh install while a previously synced file
		// still sits on disk. Server returns the row; local manifest is empty.
		// Reconcile must still pull so we re-establish the manifest hash and
		// version baseline. Same code path as a clean pull but with no local row.
		const out = reconcile({
			serverManifest: [
				serverEntry({ id: "wiped", path: "kept.md", version: 7, hash: "h-server" }),
			],
			localManifest: [],
			scanned: [scanned({ uuid: "wiped", path: "kept.md", hash: "h-on-disk" })],
		});
		expect(out.actions).toEqual([
			{
				kind: "pull",
				id: "pull:wiped",
				serverId: "wiped",
				path: "kept.md",
				conflictedLocally: false,
			},
		]);
	});

	it("master row #7 (no-op): emits no actions when server, local, and scan all agree", () => {
		const out = reconcile({
			serverManifest: [
				serverEntry({ id: "calm", path: "calm.md", version: 3, hash: "h-x" }),
			],
			localManifest: [
				localRecord({ id: "calm", path: "calm.md", version: 3, hash: "h-x" }),
			],
			scanned: [scanned({ uuid: "calm", path: "calm.md", hash: "h-x" })],
		});
		expect(out.actions).toEqual([]);
		expect(out.stats).toMatchObject({
			pull: 0,
			push: 0,
			renameLocal: 0,
			conflict: 0,
		});
	});

	it("sub-matrix ✓ ✗ – ✓: emits a single push with previousPath for plugin-side rename + local edit", () => {
		// Server hasn't moved (server.path === local.path). User both renamed
		// AND edited the file locally. One push action with previousPath set
		// covers both: server applies the rename and the body update atomically.
		const out = reconcile({
			serverManifest: [
				serverEntry({ id: "id-x", path: "old.md", version: 1, hash: "h-x" }),
			],
			localManifest: [
				localRecord({ id: "id-x", path: "old.md", version: 1, hash: "h-x" }),
			],
			scanned: [
				scanned({ uuid: "id-x", path: "new.md", hash: "h-edited" }),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "push",
				id: "push:id-x",
				serverId: "id-x",
				path: "new.md",
				previousPath: "old.md",
			},
		]);
		// Body diverged from manifest, so localEdited was true; not a conflict
		// because server didn't bump version.
		expect(out.stats.conflict).toBe(0);
	});

	it("sub-matrix ✗ ✗ – –: concurrent rename-rename to different paths — client-side rename wins, push to scan path", () => {
		// Best-effort branch when server.path, local.path, and scan.path all
		// differ. `serverRenamed` requires `scanned.path === local.path`, so
		// this case bypasses rename-local entirely and falls into the
		// push-with-previousPath branch: plugin tells the server to rename to
		// the scan path. Server's competing rename to its own path is lost
		// (this is the "lossy" branch the matrix flags as out of scope for v1).
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "id-3way",
					path: "server/path.md",
					version: 2,
					hash: "h-mismatch",
				}),
			],
			localManifest: [
				localRecord({
					id: "id-3way",
					path: "local/path.md",
					version: 1,
					hash: "h-old",
				}),
			],
			scanned: [
				scanned({ uuid: "id-3way", path: "scan/path.md", hash: "h-edited" }),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "push",
				id: "push:id-3way",
				serverId: "id-3way",
				path: "scan/path.md",
				previousPath: "local/path.md",
			},
		]);
		// Server bumped version AND user edited locally → conflict counter ticks.
		expect(out.stats.conflict).toBe(1);
	});

	it("delta hides server entry, file edited locally → pushes via synthetic server entry", () => {
		// Live repro: AnotherTest.md was created+pushed (server allocated UUID),
		// then renamed and body edited. Delta manifest excludes the row because
		// the server hasn't changed it since `lastSince`. Pass 2 skips because
		// the UUID is locally tracked. Without the synthetic-server-entry
		// promotion, no action fires and the plugin reports "synced" while the
		// edits never reach the server.
		const out = reconcile({
			serverManifest: [], // delta omitted the row
			localManifest: [
				localRecord({
					id: "id-edit",
					path: "Untitled.md",
					version: 1,
					hash: "h-empty",
				}),
			],
			scanned: [
				scanned({
					uuid: "id-edit",
					path: "Habitats/KLP/AnotherTest.md",
					hash: "h-edited",
				}),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "push",
				id: "push:id-edit",
				serverId: "id-edit",
				path: "Habitats/KLP/AnotherTest.md",
				previousPath: "Untitled.md",
			},
		]);
		expect(out.stats.push).toBe(1);
	});

	it("delta hides server entry, file deleted locally → emits stale-local-delete", () => {
		// Locally-tracked row, file gone from disk, delta omitted server view.
		// Without the synthetic entry, this slipped through; with it, Pass 1's
		// existing stale-delete branch fires.
		const out = reconcile({
			serverManifest: [],
			localManifest: [
				localRecord({ id: "id-gone", path: "removed.md" }),
			],
			scanned: [],
		});
		expect(out.actions.map((a) => a.kind)).toEqual(["stale-local-delete"]);
		expect(out.stats.staleLocalDelete).toBe(1);
	});

	it("does not re-push a locally-known file absent from a delta server manifest", () => {
		// Regression: Pass 2 used to push every UUID that wasn't in the
		// (delta-mode) server manifest. Locally-known unchanged files fall
		// outside `?since=lastSince` and were re-pushed every cycle. The fix
		// requires Pass 2 to also skip UUIDs that already exist in localById.
		const out = reconcile({
			serverManifest: [], // delta returned no rows for unchanged files
			localManifest: [localRecord({ id: "id-1", path: "a.md", hash: "h-x" })],
			scanned: [scanned({ uuid: "id-1", path: "a.md", hash: "h-x" })],
		});
		expect(out.actions).toEqual([]);
		expect(out.stats.push).toBe(0);
	});

	it("still emits a first-push when the UUID is unknown to both server and local manifest", () => {
		// Pre-registration bulk import: the file carries a huma_uuid neither
		// side has seen. Pass 2 must still emit a push so the server can
		// allocate or recognise the id.
		const out = reconcile({
			serverManifest: [],
			localManifest: [],
			scanned: [scanned({ uuid: "stranger", path: "x.md", hash: "h-x" })],
		});
		expect(out.actions).toEqual([
			{
				kind: "push",
				id: "push:stranger",
				serverId: null,
				path: "x.md",
				previousPath: null,
			},
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

	it("refuses to act when two scanned files share a huma_uuid", () => {
		// Corruption case (e.g. user copy-pasted a synced note keeping its
		// frontmatter). Pushing the "winner" as a rename of the other would
		// tell the server the original moved, while the loser stays on disk —
		// next pull could clobber content the user still has locally. Reconcile
		// must skip the UUID entirely and return it for the engine to surface.
		const out = reconcile({
			serverManifest: [serverEntry({ id: "dup", path: "a.md", hash: "h-local" })],
			localManifest: [localRecord({ id: "dup", path: "a.md", hash: "h-local" })],
			scanned: [
				scanned({ uuid: "dup", path: "a.md", hash: "h-local" }),
				scanned({ uuid: "dup", path: "b.md", hash: "h-local" }),
			],
		});
		expect(out.actions).toEqual([]);
		expect(out.duplicateUuids).toEqual([
			{ uuid: "dup", paths: ["a.md", "b.md"] },
		]);
		expect(out.stats.duplicateUuid).toBe(1);
	});

	it("still emits server-deleted for a duplicate-uuid file the server has tombstoned", () => {
		// Tombstoning is safe regardless of local duplication — the manifest
		// row should still be dropped. The vault files are left alone.
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "dup",
					path: "a.md",
					deleted_at: "2026-04-15T00:00:00Z",
				}),
			],
			localManifest: [localRecord({ id: "dup", path: "a.md" })],
			scanned: [
				scanned({ uuid: "dup", path: "a.md" }),
				scanned({ uuid: "dup", path: "b.md" }),
			],
		});
		expect(out.actions.map((a) => a.kind)).toEqual(["server-deleted"]);
		expect(out.duplicateUuids).toEqual([
			{ uuid: "dup", paths: ["a.md", "b.md"] },
		]);
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

// Property fixture mirroring docs/CONFLICT-MATRIX.md. Each row is labelled
// with its master-matrix # or sub-matrix coordinates so a maintainer can
// grep from the doc to a failing test in one hop. The post-refactor
// dispatch in src/sync/reconcile.ts (Step A–E) is the unit under test;
// these rows pass against both the pre- and post-refactor implementations
// because they assert externally observable reconcile() output.
describe("decide() property matrix", () => {
	it("master row #1: emits add for scan-only file with no UUID", () => {
		// server absent, local absent, scan present (no UUID).
		const out = reconcile({
			serverManifest: [],
			localManifest: [],
			scanned: [scanned({ uuid: null, path: "fresh.md" })],
		});
		expect(out.actions).toEqual([
			{ kind: "add", id: "add:fresh.md", path: "fresh.md" },
		]);
		expect(out.stats).toMatchObject({ add: 1, pull: 0, push: 0 });
	});

	it("master row #2: pushes with serverId=null when scan has UUID and neither server nor local know it", () => {
		// server absent, local absent, scan present (with UUID).
		const out = reconcile({
			serverManifest: [],
			localManifest: [],
			scanned: [
				scanned({ uuid: "uuid-m2", path: "imported.md", hash: "h-m2" }),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "push",
				id: "push:uuid-m2",
				serverId: null,
				path: "imported.md",
				previousPath: null,
			},
		]);
	});

	it("master row #3: emits first-time pull when server has a row neither local nor scan know", () => {
		// server live, local absent, scan absent.
		const out = reconcile({
			serverManifest: [
				serverEntry({ id: "uuid-m3", path: "remote.md", version: 4 }),
			],
			localManifest: [],
			scanned: [],
		});
		expect(out.actions).toEqual([
			{
				kind: "pull",
				id: "pull:uuid-m3",
				serverId: "uuid-m3",
				path: "remote.md",
				conflictedLocally: false,
			},
		]);
	});

	it("master row #4: emits pull when local manifest is wiped but vault file still exists", () => {
		// server live, local absent, scan present (same UUID — data.json recovery).
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "uuid-m4",
					path: "kept.md",
					version: 9,
					hash: "h-server",
				}),
			],
			localManifest: [],
			scanned: [
				scanned({ uuid: "uuid-m4", path: "kept.md", hash: "h-on-disk" }),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "pull",
				id: "pull:uuid-m4",
				serverId: "uuid-m4",
				path: "kept.md",
				conflictedLocally: false,
			},
		]);
	});

	it("master row #5: emits stale-local-delete when local manifest tracks a file that vanished from disk", () => {
		// server live, local present, scan absent.
		const out = reconcile({
			serverManifest: [
				serverEntry({ id: "uuid-m5", path: "lost.md", version: 2 }),
			],
			localManifest: [
				localRecord({ id: "uuid-m5", path: "lost.md", version: 2 }),
			],
			scanned: [],
		});
		expect(out.actions).toEqual([
			{
				kind: "stale-local-delete",
				id: "stale-local-delete:uuid-m5",
				serverId: "uuid-m5",
				path: "lost.md",
			},
		]);
		expect(out.stats.staleLocalDelete).toBe(1);
	});

	it("master row #6: delegates to sub-matrix — in-sync no-op when all three views agree", () => {
		// server live, local present, scan present — representative in-sync cell.
		// The 8 sub-matrix #6 cells below cover the full boolean cube.
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "uuid-m6",
					path: "calm.md",
					version: 5,
					hash: "h-m6",
				}),
			],
			localManifest: [
				localRecord({
					id: "uuid-m6",
					path: "calm.md",
					version: 5,
					hash: "h-m6",
				}),
			],
			scanned: [
				scanned({ uuid: "uuid-m6", path: "calm.md", hash: "h-m6" }),
			],
		});
		expect(out.actions).toEqual([]);
	});

	it("master row #7: emits no action for tombstoned server entry the local side never tracked", () => {
		// server tombstoned, local absent, scan absent.
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "uuid-m7",
					path: "ghost.md",
					deleted_at: "2026-04-15T00:00:00Z",
				}),
			],
			localManifest: [],
			scanned: [],
		});
		expect(out.actions).toEqual([]);
		expect(out.stats.serverDeleted).toBe(0);
	});

	it("master row #8: emits server-deleted when server is tombstoned and the local side has anything", () => {
		// server tombstoned, local present (scan also present here for coverage).
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "uuid-m8",
					path: "tomb.md",
					deleted_at: "2026-04-20T00:00:00Z",
				}),
			],
			localManifest: [localRecord({ id: "uuid-m8", path: "tomb.md" })],
			scanned: [
				scanned({ uuid: "uuid-m8", path: "tomb.md", hash: "h-m8" }),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "server-deleted",
				id: "server-deleted:uuid-m8",
				serverId: "uuid-m8",
				path: "tomb.md",
			},
		]);
		expect(out.stats.serverDeleted).toBe(1);
	});

	it("sub-matrix #6 ✓ ✓ ✗ ✗: emits no action when all three paths align and neither side moved", () => {
		// pathsAlign-server-local=✓, pathsAlign-scan-local=✓, serverNewer=✗, localEdited=✗.
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "id-66a",
					path: "p66a.md",
					version: 3,
					hash: "h-66a",
				}),
			],
			localManifest: [
				localRecord({
					id: "id-66a",
					path: "p66a.md",
					version: 3,
					hash: "h-66a",
				}),
			],
			scanned: [
				scanned({ uuid: "id-66a", path: "p66a.md", hash: "h-66a" }),
			],
		});
		expect(out.actions).toEqual([]);
	});

	it("sub-matrix #6 ✓ ✓ ✓ ✗: emits clean pull when server bumped version and local is unchanged", () => {
		// pathsAlign-server-local=✓, pathsAlign-scan-local=✓, serverNewer=✓, localEdited=✗.
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "id-66b",
					path: "p66b.md",
					version: 4,
					hash: "h-66b-new",
				}),
			],
			localManifest: [
				localRecord({
					id: "id-66b",
					path: "p66b.md",
					version: 3,
					hash: "h-66b-old",
				}),
			],
			scanned: [
				scanned({ uuid: "id-66b", path: "p66b.md", hash: "h-66b-old" }),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "pull",
				id: "pull:id-66b",
				serverId: "id-66b",
				path: "p66b.md",
				conflictedLocally: false,
			},
		]);
		expect(out.stats.conflict).toBe(0);
	});

	it("sub-matrix #6 ✓ ✓ ✗ ✓: emits clean push when only the local body diverged", () => {
		// pathsAlign-server-local=✓, pathsAlign-scan-local=✓, serverNewer=✗, localEdited=✓.
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "id-66c",
					path: "p66c.md",
					version: 2,
					hash: "h-66c",
				}),
			],
			localManifest: [
				localRecord({
					id: "id-66c",
					path: "p66c.md",
					version: 2,
					hash: "h-66c",
				}),
			],
			scanned: [
				scanned({
					uuid: "id-66c",
					path: "p66c.md",
					hash: "h-66c-edited",
				}),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "push",
				id: "push:id-66c",
				serverId: "id-66c",
				path: "p66c.md",
				previousPath: null,
			},
		]);
		expect(out.stats.conflict).toBe(0);
	});

	it("sub-matrix #6 ✓ ✓ ✓ ✓: emits push and increments conflict counter when both sides diverged", () => {
		// pathsAlign-server-local=✓, pathsAlign-scan-local=✓, serverNewer=✓, localEdited=✓.
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "id-66d",
					path: "p66d.md",
					version: 5,
					hash: "h-66d-server",
				}),
			],
			localManifest: [
				localRecord({
					id: "id-66d",
					path: "p66d.md",
					version: 4,
					hash: "h-66d-orig",
				}),
			],
			scanned: [
				scanned({
					uuid: "id-66d",
					path: "p66d.md",
					hash: "h-66d-local-new",
				}),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "push",
				id: "push:id-66d",
				serverId: "id-66d",
				path: "p66d.md",
				previousPath: null,
			},
		]);
		expect(out.stats.conflict).toBe(1);
	});

	it("sub-matrix #6 ✓ ✗ – ✗: emits push with previousPath for plugin-side rename without body change", () => {
		// pathsAlign-server-local=✓, pathsAlign-scan-local=✗, localEdited=✗.
		// Server agrees with local on path; user moved file locally; body unchanged.
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "id-66e",
					path: "old66e.md",
					version: 1,
					hash: "h-66e",
				}),
			],
			localManifest: [
				localRecord({
					id: "id-66e",
					path: "old66e.md",
					version: 1,
					hash: "h-66e",
				}),
			],
			scanned: [
				scanned({ uuid: "id-66e", path: "new66e.md", hash: "h-66e" }),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "push",
				id: "push:id-66e",
				serverId: "id-66e",
				path: "new66e.md",
				previousPath: "old66e.md",
			},
		]);
	});

	it("sub-matrix #6 ✓ ✗ – ✓: emits one push with previousPath for plugin-side rename plus local edit", () => {
		// pathsAlign-server-local=✓, pathsAlign-scan-local=✗, localEdited=✓.
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "id-66f",
					path: "old66f.md",
					version: 2,
					hash: "h-66f-orig",
				}),
			],
			localManifest: [
				localRecord({
					id: "id-66f",
					path: "old66f.md",
					version: 2,
					hash: "h-66f-orig",
				}),
			],
			scanned: [
				scanned({
					uuid: "id-66f",
					path: "new66f.md",
					hash: "h-66f-edited",
				}),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "push",
				id: "push:id-66f",
				serverId: "id-66f",
				path: "new66f.md",
				previousPath: "old66f.md",
			},
		]);
		expect(out.stats.conflict).toBe(0);
	});

	it("sub-matrix #6 ✗ ✓ – –: emits rename-local plus pull when the server moved the file and bumped version", () => {
		// pathsAlign-server-local=✗, pathsAlign-scan-local=✓ (scan still at local path).
		// Dispatch detects server-side rename, emits rename-local, then decide
		// sees the scan-shim with path=server.path and produces the pull.
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "id-66g",
					path: "moved66g.md",
					version: 3,
					hash: "h-66g-new",
				}),
			],
			localManifest: [
				localRecord({
					id: "id-66g",
					path: "old66g.md",
					version: 2,
					hash: "h-66g-old",
				}),
			],
			scanned: [
				scanned({ uuid: "id-66g", path: "old66g.md", hash: "h-66g-old" }),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "rename-local",
				id: "rename-local:id-66g",
				serverId: "id-66g",
				fromPath: "old66g.md",
				toPath: "moved66g.md",
			},
			{
				kind: "pull",
				id: "pull:id-66g",
				serverId: "id-66g",
				path: "moved66g.md",
				conflictedLocally: false,
			},
		]);
		expect(out.stats.renameLocal).toBe(1);
	});

	it("sub-matrix #6 ✗ ✗ – –: emits a single push at scan.path when all three paths disagree (lossy by design)", () => {
		// pathsAlign-server-local=✗, pathsAlign-scan-local=✗.
		// `serverRenamed` requires scan.path === local.path so this case bypasses
		// rename-local and falls into plugin-side rename branch. Server's
		// competing rename is lost — see docs/CONFLICT-MATRIX.md § "Out of scope".
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "id-66h",
					path: "server66h.md",
					version: 2,
					hash: "h-66h-server",
				}),
			],
			localManifest: [
				localRecord({
					id: "id-66h",
					path: "local66h.md",
					version: 1,
					hash: "h-66h-orig",
				}),
			],
			scanned: [
				scanned({
					uuid: "id-66h",
					path: "scan66h.md",
					hash: "h-66h-edited",
				}),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "push",
				id: "push:id-66h",
				serverId: "id-66h",
				path: "scan66h.md",
				previousPath: "local66h.md",
			},
		]);
		expect(out.stats.conflict).toBe(1);
	});

	it("duplicate huma_uuid refusal: emits no actions and surfaces duplicateUuids", () => {
		// Two scanned files share the same UUID; server has a live row.
		// Reconcile must refuse to push/pull/rename and report the dup set.
		const out = reconcile({
			serverManifest: [
				serverEntry({ id: "dup", path: "a.md", hash: "h-dup" }),
			],
			localManifest: [
				localRecord({ id: "dup", path: "a.md", hash: "h-dup" }),
			],
			scanned: [
				scanned({ uuid: "dup", path: "a.md", hash: "h-dup" }),
				scanned({ uuid: "dup", path: "b.md", hash: "h-dup" }),
			],
		});
		expect(out.actions).toEqual([]);
		expect(out.stats.duplicateUuid).toBe(1);
		expect(out.duplicateUuids).toEqual([
			{ uuid: "dup", paths: ["a.md", "b.md"] },
		]);
	});

	it("duplicate huma_uuid plus tombstoned server: still emits server-deleted and surfaces duplicateUuids", () => {
		// Tombstone-drop is safe regardless of local duplication; the engine
		// still needs the dup-uuid alert so it can surface the local corruption.
		const out = reconcile({
			serverManifest: [
				serverEntry({
					id: "dup",
					path: "a.md",
					deleted_at: "2026-04-22T00:00:00Z",
				}),
			],
			localManifest: [localRecord({ id: "dup", path: "a.md" })],
			scanned: [
				scanned({ uuid: "dup", path: "a.md" }),
				scanned({ uuid: "dup", path: "b.md" }),
			],
		});
		expect(out.actions[0]?.kind).toBe("server-deleted");
		expect(out.stats.duplicateUuid).toBe(1);
		expect(out.duplicateUuids).toEqual([
			{ uuid: "dup", paths: ["a.md", "b.md"] },
		]);
	});

	it("synthetic-server-entry: pushes with serverId and previousPath when delta hides server row but scan diverges", () => {
		// Server delta omits the row (serverManifest empty); local manifest has
		// the UUID at "previous.md"; scan has the UUID at "current.md" with a
		// different hash. Asserting BOTH serverId and previousPath populated is
		// what makes Guard A (synthetic-server-entry promotion) removable
		// detectable: without promotion, decide is invoked with server=null and
		// emits push with serverId=null/previousPath=null instead.
		const out = reconcile({
			serverManifest: [],
			localManifest: [
				localRecord({
					id: "uuid-syn",
					path: "previous.md",
					version: 1,
					hash: "h-prev",
				}),
			],
			scanned: [
				scanned({
					uuid: "uuid-syn",
					path: "current.md",
					hash: "h-current",
				}),
			],
		});
		expect(out.actions).toEqual([
			{
				kind: "push",
				id: "push:uuid-syn",
				serverId: "uuid-syn", // CRITICAL: not null — Guard A enforces this
				path: "current.md",
				previousPath: "previous.md", // CRITICAL: not null
			},
		]);
		expect(out.stats.push).toBe(1);
	});

	it("synthetic-server-entry: emits stale-local-delete when delta hides row and scan is absent", () => {
		// Server delta omits row; local has UUID; scan has no entry for that UUID.
		// Synthetic entry's deleted_at=null routes through stale-local-delete.
		const out = reconcile({
			serverManifest: [],
			localManifest: [
				localRecord({
					id: "uuid-syn-gone",
					path: "removed.md",
					version: 1,
					hash: "h-removed",
				}),
			],
			scanned: [],
		});
		expect(out.actions).toEqual([
			{
				kind: "stale-local-delete",
				id: "stale-local-delete:uuid-syn-gone",
				serverId: "uuid-syn-gone",
				path: "removed.md",
			},
		]);
		expect(out.stats.staleLocalDelete).toBe(1);
	});

	it("Pass-2 protection: emits no action when local and scan agree and server delta omits the row", () => {
		// Documents the no-spurious-push invariant: with synthetic-entry
		// promotion intact, decide(synthetic-server, local, scan) sees in-sync
		// state and returns null. Complements the synthetic-entry edit row
		// above; this row alone does not fail under Guard A removal because
		// decide(null, local, scan) with same hash/path also returns null —
		// Guard A's verifiable failure is via the synthetic-entry edit row.
		const out = reconcile({
			serverManifest: [],
			localManifest: [
				localRecord({
					id: "uuid-pass2",
					path: "stable.md",
					version: 1,
					hash: "h-stable",
				}),
			],
			scanned: [
				scanned({
					uuid: "uuid-pass2",
					path: "stable.md",
					hash: "h-stable",
				}),
			],
		});
		expect(out.actions).toEqual([]);
		expect(out.stats.push).toBe(0);
	});

	// Verify-by-deletion procedure (run by hand; do NOT commit either deletion).
	// Both removals target dispatch-level guards in src/sync/reconcile.ts that
	// exist AFTER the Step A–E refactor (Plan 01-01 Task 2). Pre-refactor symbol
	// names like `scannedByUuid loop` no longer apply.
	//
	// Guard A — synthetic-server-entry promotion (Step C in dispatch).
	//   Location: the loop `for (const local of localManifest) { if (!serverByIdEffective.has(local.id)) serverByIdEffective.set(local.id, { ...synthetic }); }`.
	//   Removal effect: delta-omitted UUIDs reach decide() with server=null.
	//   Expected fixture failure: "synthetic-server-entry: pushes with serverId
	//   and previousPath when delta hides server row but scan diverges"
	//     — actual action is push with serverId=null, previousPath=null
	//     — assertion fails on serverId (expected "uuid-syn", received null).
	//   Also expected to fail: "synthetic-server-entry: emits stale-local-delete
	//   when delta hides row and scan is absent" — without promotion, dispatch's
	//   union still includes the UUID via local, but decide(null, local, null)
	//   returns null instead of stale-local-delete.
	//
	// Guard B — duplicate-uuid skip (Step D dispatch loop).
	//   Location: the line `if (duplicateUuidSet.has(uuid) && (!server || server.deleted_at === null)) continue;`.
	//   Removal effect: dispatch calls decide for both files of a duplicate set,
	//   emitting real push actions instead of skipping.
	//   Expected fixture failure: "duplicate huma_uuid refusal: emits no
	//   actions and surfaces duplicateUuids" — actual actions array is non-empty
	//   (one push per duplicate file).
	//
	// Both verifications must produce concrete failing assertions before this
	// refactor is considered complete. SUMMARY MUST quote the verbatim vitest
	// failure output (test name + assertion message) for both guards.
});
