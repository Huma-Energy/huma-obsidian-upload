import { describe, expect, it } from "vitest";
import { SelfWriteTracker } from "../../src/sync/self-write-tracker";

describe("SelfWriteTracker", () => {
	it("consumes a recorded write and returns true once", () => {
		const t = new SelfWriteTracker();
		t.record("a.md", "h1");
		expect(t.consume("a.md", "h1")).toBe(true);
		expect(t.consume("a.md", "h1")).toBe(false);
	});

	it("returns false when the path is unknown", () => {
		const t = new SelfWriteTracker();
		expect(t.consume("a.md", "h1")).toBe(false);
	});

	it("returns false when the hash does not match a recorded write", () => {
		const t = new SelfWriteTracker();
		t.record("a.md", "h1");
		expect(t.consume("a.md", "h2")).toBe(false);
		// The original entry survives — a later matching event still consumes.
		expect(t.consume("a.md", "h1")).toBe(true);
	});

	it("supports multiple pending writes on the same path", () => {
		const t = new SelfWriteTracker();
		t.record("a.md", "h1");
		t.record("a.md", "h2");
		expect(t.consume("a.md", "h2")).toBe(true);
		expect(t.consume("a.md", "h1")).toBe(true);
		expect(t.consume("a.md", "h1")).toBe(false);
	});

	it("expires entries after the configured TTL", () => {
		const t = new SelfWriteTracker(1_000);
		t.record("a.md", "h1", 1_000_000);
		expect(t.consume("a.md", "h1", 1_000_500)).toBe(true);
		t.record("a.md", "h1", 1_000_000);
		expect(t.consume("a.md", "h1", 1_002_000)).toBe(false);
	});

	it("hasPath reports path presence and clears after the last consume", () => {
		const t = new SelfWriteTracker();
		expect(t.hasPath("a.md")).toBe(false);
		t.record("a.md", "h1");
		t.record("a.md", "h2");
		expect(t.hasPath("a.md")).toBe(true);
		t.consume("a.md", "h1");
		expect(t.hasPath("a.md")).toBe(true);
		t.consume("a.md", "h2");
		expect(t.hasPath("a.md")).toBe(false);
	});
});
