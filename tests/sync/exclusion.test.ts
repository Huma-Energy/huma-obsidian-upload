import { describe, expect, it } from "vitest";
import {
	isExcludedPath,
	normalizeExcludedFolders,
} from "../../src/sync/exclusion";

describe("normalizeExcludedFolders", () => {
	it("trims whitespace and strips leading/trailing slashes", () => {
		expect(normalizeExcludedFolders([" drafts ", "/business/", "//x//"])).toEqual([
			"drafts",
			"business",
			"x",
		]);
	});

	it("drops empty and duplicate entries", () => {
		expect(normalizeExcludedFolders(["", "  ", "drafts", "drafts", " drafts "])).toEqual([
			"drafts",
		]);
	});
});

describe("isExcludedPath", () => {
	it("matches exact folder paths and descendants", () => {
		expect(isExcludedPath("drafts/note.md", ["drafts"])).toBe(true);
		expect(isExcludedPath("drafts/sub/note.md", ["drafts"])).toBe(true);
		expect(isExcludedPath("drafts", ["drafts"])).toBe(true);
	});

	it("does not match siblings whose name starts with the prefix", () => {
		expect(isExcludedPath("drafts2/note.md", ["drafts"])).toBe(false);
		expect(isExcludedPath("drafts.md", ["drafts"])).toBe(false);
	});

	it("returns false for an empty exclusion list", () => {
		expect(isExcludedPath("drafts/note.md", [])).toBe(false);
	});
});
