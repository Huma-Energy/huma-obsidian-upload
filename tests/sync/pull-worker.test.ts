// Pull-worker integration tests, focused on the not_found drop loop.
// runPullWorker must remove ids the server reports as not_found from the
// local manifest and continue with the rest of the batch instead of
// looping on stale ids forever. These tests stub VaultApiClient.pull and
// drive the worker against the in-repo Obsidian mock.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createMockApp,
	type MockApp,
	MockVault,
} from "../../__mocks__/obsidian";
import { HttpError } from "../../src/client/http";
import type { VaultApiClient } from "../../src/client/vault-api";
import { runPullWorker } from "../../src/sync/pull-worker";
import { SelfWriteTracker } from "../../src/sync/self-write-tracker";
import type { ManifestRecord } from "../../src/settings";
import type { PullFile, PullResponse } from "../../src/types";

function notFoundError(id: string): HttpError {
	return new HttpError(404, { error: "not_found", id }, {
		error: "not_found",
		id,
	});
}

function pullFile(p: Partial<PullFile>): PullFile {
	return {
		id: "id-keep",
		path: "keep.md",
		version: 1,
		body: "body",
		frontmatter: null,
		...p,
	};
}

function manifestRow(p: Partial<ManifestRecord>): ManifestRecord {
	return {
		id: "id-keep",
		path: "keep.md",
		version: 0,
		hash: "h-old",
		lastSyncedAt: "2026-04-01T00:00:00Z",
		...p,
	};
}

describe("runPullWorker — not_found handling", () => {
	let app: MockApp;
	let tracker: SelfWriteTracker;

	beforeEach(() => {
		app = createMockApp();
		tracker = new SelfWriteTracker();
	});

	afterEach(() => {
		tracker.pruneExpired();
	});

	it("drops a not_found id from the manifest and pulls the survivors", async () => {
		const calls: string[][] = [];
		const api = {
			pull: async (ids: string[]): Promise<PullResponse> => {
				calls.push([...ids]);
				if (ids.includes("id-gone")) throw notFoundError("id-gone");
				return {
					files: ids.map((id) =>
						pullFile({ id, path: `${id}.md`, version: 5, body: "body" }),
					),
				};
			},
		} as unknown as VaultApiClient;

		const initialManifest: ManifestRecord[] = [
			manifestRow({ id: "id-a", path: "id-a.md" }),
			manifestRow({ id: "id-gone", path: "ghost.md" }),
			manifestRow({ id: "id-b", path: "id-b.md" }),
		];

		const result = await runPullWorker(
			api,
			app as unknown as Parameters<typeof runPullWorker>[1],
			["id-a", "id-gone", "id-b"],
			initialManifest,
			tracker,
		);

		expect(result.dropped.map((d) => d.id)).toEqual(["id-gone"]);
		expect(result.dropped[0]?.path).toBe("ghost.md");
		const remainingIds = result.updatedManifest.map((r) => r.id).sort();
		expect(remainingIds).toEqual(["id-a", "id-b"]);
		expect(result.written).toBe(2);
		expect(result.errors).toEqual([]);
		// Two requests: first 404s, second succeeds with survivors.
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual(["id-a", "id-b"]);
	});

	it("treats a not_found whose id was not in the batch as a generic error", async () => {
		// Defensive: a misbehaving server names an id outside the batch. Worker
		// must not loop forever — it falls through to generic error handling
		// and records the failure for every id in the batch.
		const api = {
			pull: async (_ids: string[]): Promise<PullResponse> => {
				throw notFoundError("id-foreign");
			},
		} as unknown as VaultApiClient;

		const result = await runPullWorker(
			api,
			app as unknown as Parameters<typeof runPullWorker>[1],
			["id-a", "id-b"],
			[manifestRow({ id: "id-a" }), manifestRow({ id: "id-b" })],
			tracker,
		);

		expect(result.dropped).toEqual([]);
		expect(result.errors.map((e) => e.id).sort()).toEqual(["id-a", "id-b"]);
		// Manifest preserved — no spurious drops on a non-applicable error.
		expect(result.updatedManifest.map((r) => r.id).sort()).toEqual([
			"id-a",
			"id-b",
		]);
	});

	it("peels successive not_found ids one at a time", async () => {
		const api = {
			pull: async (ids: string[]): Promise<PullResponse> => {
				if (ids.includes("id-gone-1")) throw notFoundError("id-gone-1");
				if (ids.includes("id-gone-2")) throw notFoundError("id-gone-2");
				return {
					files: ids.map((id) =>
						pullFile({ id, path: `${id}.md`, version: 1 }),
					),
				};
			},
		} as unknown as VaultApiClient;

		const result = await runPullWorker(
			api,
			app as unknown as Parameters<typeof runPullWorker>[1],
			["id-gone-1", "id-keep", "id-gone-2"],
			[
				manifestRow({ id: "id-gone-1", path: "g1.md" }),
				manifestRow({ id: "id-keep" }),
				manifestRow({ id: "id-gone-2", path: "g2.md" }),
			],
			tracker,
		);

		expect(result.dropped.map((d) => d.id).sort()).toEqual([
			"id-gone-1",
			"id-gone-2",
		]);
		expect(result.updatedManifest.map((r) => r.id)).toEqual(["id-keep"]);
		expect(result.errors).toEqual([]);
	});
});

// Ensures the test file actually exercises a writable mock — surfaces if
// the createMockApp signature changes underneath this file.
describe("runPullWorker — mock sanity", () => {
	it("can construct a vault instance", () => {
		const v = new MockVault();
		expect(v.listFilePaths()).toEqual([]);
	});
});
