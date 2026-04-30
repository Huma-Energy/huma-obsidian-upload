import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
	MockFileManager,
	MockVault,
	type MockApp,
} from "../../__mocks__/obsidian";
import { scanVault } from "../../src/sync/scan";

const FIXTURE_ROOT = join(__dirname, "..", "fixtures", "vault");

function loadFixtureVault(): MockApp {
	const vault = new MockVault();
	for (const path of walkMarkdown(FIXTURE_ROOT)) {
		const rel = relative(FIXTURE_ROOT, path).split(sep).join("/");
		const content = readFileSync(path, "utf8");
		vault.addFile(rel, content);
	}
	return {
		vault,
		fileManager: new MockFileManager(vault),
		workspace: {
			onLayoutReady() {},
			on() {
				return { unload() {} };
			},
			getLeaf() {
				return { async openFile() {} };
			},
		},
	};
}

function* walkMarkdown(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const s = statSync(full);
		if (s.isDirectory()) yield* walkMarkdown(full);
		else if (name.endsWith(".md")) yield full;
	}
}

describe("scanVault", () => {
	it("scans the fixture vault and produces one entry per markdown file", async () => {
		const app = loadFixtureVault();
		const result = await scanVault(app as unknown as Parameters<typeof scanVault>[0]);
		const paths = result.map((r) => r.path).sort();
		expect(paths).toContain("01-plain-prose.md");
		expect(paths).toContain("11-with-uuid.md");
		expect(paths).toContain("13-nested/nested-note.md");
		expect(result.length).toBeGreaterThanOrEqual(15);
	});

	it("flags files without huma_uuid for first-push", async () => {
		const app = loadFixtureVault();
		const result = await scanVault(app as unknown as Parameters<typeof scanVault>[0]);
		const noUuid = result.filter((r) => r.uuid === null).map((r) => r.path);
		expect(noUuid).toContain("01-plain-prose.md");
		expect(noUuid).not.toContain("11-with-uuid.md");
	});

	it("extracts huma_uuid for already-synced files", async () => {
		const app = loadFixtureVault();
		const result = await scanVault(app as unknown as Parameters<typeof scanVault>[0]);
		const withUuid = result.find((r) => r.path === "11-with-uuid.md");
		expect(withUuid?.uuid).toBe("7c1c6b86-f3aa-4c4b-9e10-7ddc3f2fce91");
	});

	it("hash stays stable across two scan passes of the same content", async () => {
		const app = loadFixtureVault();
		const a = await scanVault(app as unknown as Parameters<typeof scanVault>[0]);
		const b = await scanVault(app as unknown as Parameters<typeof scanVault>[0]);
		const aByPath = new Map(a.map((r) => [r.path, r.hash]));
		for (const r of b) expect(aByPath.get(r.path)).toBe(r.hash);
	});

	it("excludes *.conflict.md files from the scan", async () => {
		const vault = new MockVault();
		vault.addFile("a.md", "alpha");
		vault.addFile("a.conflict.md", "<<<<<<< local\nx\n=======\ny\n>>>>>>> server\n");
		vault.addFile("nested/b.conflict.md", "");
		const app: MockApp = {
			vault,
			fileManager: new MockFileManager(vault),
			workspace: {
				onLayoutReady() {},
				on() { return { unload() {} }; },
				getLeaf() { return { async openFile() {} }; },
			},
		};
		const result = await scanVault(app as unknown as Parameters<typeof scanVault>[0]);
		const paths = result.map((r) => r.path);
		expect(paths).toEqual(["a.md"]);
	});
});
