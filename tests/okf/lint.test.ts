import { describe, expect, it } from "vitest";
import {
	OKF_DEFAULT_TYPE,
	lintForOkf,
	withOkfType,
} from "../../src/okf/lint";

describe("lintForOkf", () => {
	it("flags a missing type", () => {
		const r = lintForOkf({ path: "notes/idea.md", frontmatter: {} });
		expect(r.needsType).toBe(true);
		expect(r.suggestedType).toBe(OKF_DEFAULT_TYPE);
		expect(r.notes.join(" ")).toContain("type");
	});

	it("accepts a present non-empty type", () => {
		const r = lintForOkf({
			path: "notes/idea.md",
			frontmatter: { type: "concept" },
		});
		expect(r.needsType).toBe(false);
	});

	it("treats a blank type string as missing", () => {
		const r = lintForOkf({
			path: "notes/idea.md",
			frontmatter: { type: "   " },
		});
		expect(r.needsType).toBe(true);
	});

	it("flags index.md as OKF-reserved and a collision when it carries frontmatter", () => {
		const r = lintForOkf({
			path: "Projects/index.md",
			frontmatter: { title: "Projects", tags: ["x"] },
		});
		expect(r.isReservedIndex).toBe(true);
		expect(r.indexCollision).toBe(true);
		expect(r.notes.join(" ")).toContain("index.md");
	});

	it("marks index.md reserved but not a collision when it has no frontmatter", () => {
		const r = lintForOkf({ path: "index.md", frontmatter: {} });
		expect(r.isReservedIndex).toBe(true);
		expect(r.indexCollision).toBe(false);
	});

	it("detects index.md case-insensitively from a nested path", () => {
		const r = lintForOkf({ path: "a/b/INDEX.MD", frontmatter: { type: "x" } });
		expect(r.isReservedIndex).toBe(true);
	});
});

describe("withOkfType", () => {
	it("adds type when missing without mutating the original", () => {
		const original = { title: "X" };
		const next = withOkfType(original, "note");
		expect(next).toEqual({ title: "X", type: "note" });
		expect(original).toEqual({ title: "X" });
	});

	it("preserves an existing non-empty type", () => {
		const next = withOkfType({ type: "concept", title: "X" }, "note");
		expect(next.type).toBe("concept");
	});

	it("replaces a blank type", () => {
		const next = withOkfType({ type: "" }, "note");
		expect(next.type).toBe("note");
	});
});
