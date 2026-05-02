import { describe, expect, it } from "vitest";
import {
	conflictPathFor,
	emitConflict,
	formatConflictBody,
	listConflictFiles,
} from "../../src/sync/conflict";
import { SelfWriteTracker } from "../../src/sync/self-write-tracker";
import { createMockApp, type MockApp } from "../../__mocks__/obsidian";

describe("conflict", () => {
	it("formats bodies between git-style markers", () => {
		const out = formatConflictBody("local body", "server body");
		expect(out).toContain("<<<<<<< local");
		expect(out).toContain("=======");
		expect(out).toContain(">>>>>>> server");
		const lines = out.split("\n");
		expect(lines.indexOf("<<<<<<< local")).toBeLessThan(
			lines.indexOf("======="),
		);
		expect(lines.indexOf("=======")).toBeLessThan(
			lines.indexOf(">>>>>>> server"),
		);
	});

	it("computes a sibling .conflict.md path", () => {
		expect(conflictPathFor("notes/a.md")).toBe("notes/a.conflict.md");
		expect(conflictPathFor("a.md")).toBe("a.conflict.md");
		expect(conflictPathFor("a")).toBe("a.conflict.md");
	});

	it("normalizes path traversal attempts on the conflict path", () => {
		// Guards against a hostile server returning a path that escapes vault root.
		expect(conflictPathFor("///../foo.md")).toBe("../foo.conflict.md");
		expect(conflictPathFor("a\\b\\c.md")).toBe("a/b/c.conflict.md");
	});

	it("emits a conflict file and replaces the original with the server body", async () => {
		const app = createMockApp();
		app.vault.addFile("notes/x.md", "local content");
		const tracker = new SelfWriteTracker();
		await emitConflict(
			app as unknown as Parameters<typeof emitConflict>[0],
			{
				id: "uuid-1",
				path: "notes/x.md",
				localBody: "local content",
				serverBody: "server content",
				serverFrontmatter: { title: "X" },
			},
			tracker,
		);
		const conflict = app.vault.getFileContents("notes/x.conflict.md");
		expect(conflict).toContain("local content");
		expect(conflict).toContain("server content");
		const original = app.vault.getFileContents("notes/x.md");
		expect(original).toContain("server content");
		expect(original).toContain("huma_uuid: uuid-1");
		expect(original).toContain("title: X");
	});

	it("listConflictFiles returns only *.conflict.md", () => {
		const app = createMockApp();
		app.vault.addFile("a.md", "");
		app.vault.addFile("a.conflict.md", "");
		app.vault.addFile("nested/b.conflict.md", "");
		const list = listConflictFiles(app as unknown as Parameters<typeof listConflictFiles>[0]);
		expect(list.map((f) => f.path).sort()).toEqual([
			"a.conflict.md",
			"nested/b.conflict.md",
		]);
	});
});

// Compile-time use to keep MockApp import non-orphan when tsc -noEmit runs.
const _typecheck: MockApp | null = null;
void _typecheck;
