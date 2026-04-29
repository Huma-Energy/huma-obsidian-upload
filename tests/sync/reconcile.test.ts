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
});
