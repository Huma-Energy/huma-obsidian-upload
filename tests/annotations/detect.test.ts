import { describe, expect, it } from "vitest";
import {
	annotationSummary,
	detectHumaAnnotations,
} from "../../src/annotations/detect";

describe("detectHumaAnnotations", () => {
	it("reports nothing for plain prose", () => {
		const a = detectHumaAnnotations("Just some ordinary note text.\n");
		expect(a.hasAny).toBe(false);
		expect(a.commentCount).toBe(0);
		expect(a.mentionCount).toBe(0);
		expect(annotationSummary(a)).toBe("");
	});

	it("counts comment footnote definitions under a # Comments section", () => {
		const body = [
			"The quoted run.[^c-0a1b2c3d]",
			"",
			"# Comments",
			"",
			"[^c-0a1b2c3d]: Alice (2026-06-20): is this current?",
			"[^c-deadbeef]: Bob (2026-06-21): resolved.",
		].join("\n");
		const a = detectHumaAnnotations(body);
		expect(a.hasComments).toBe(true);
		expect(a.commentCount).toBe(2);
		expect(a.hasMentions).toBe(false);
	});

	it("does not treat a user's own # Comments heading (no footnote defs) as annotations", () => {
		const body = "# Comments\n\nJust my own notes about comments here.\n";
		const a = detectHumaAnnotations(body);
		expect(a.hasComments).toBe(false);
		expect(a.hasAny).toBe(false);
	});

	it("detects huma://user mention links", () => {
		const body = "Ping [@Alice](huma://user/sub-123) and [@Bob](huma://user/sub-456).\n";
		const a = detectHumaAnnotations(body);
		expect(a.hasMentions).toBe(true);
		expect(a.mentionCount).toBe(2);
		expect(a.hasComments).toBe(false);
	});

	it("reports both comments and mentions together with a summary", () => {
		const body = [
			"Hi [@Carol](huma://user/sub-9).[^c-aabbccdd]",
			"",
			"# Comments",
			"",
			"[^c-aabbccdd]: Carol (2026-06-22): noted.",
		].join("\n");
		const a = detectHumaAnnotations(body);
		expect(a.hasAny).toBe(true);
		expect(a.commentCount).toBe(1);
		expect(a.mentionCount).toBe(1);
		const summary = annotationSummary(a);
		expect(summary).toContain("1 web comment");
		expect(summary).toContain("1 mention");
		expect(summary).toContain("re-anchor or orphan");
	});

	it("pluralizes counts in the summary", () => {
		const body = [
			"a[^c-11111111] b[^c-22222222]",
			"# Comments",
			"[^c-11111111]: x",
			"[^c-22222222]: y",
		].join("\n");
		expect(annotationSummary(detectHumaAnnotations(body))).toContain(
			"2 web comments",
		);
	});
});
