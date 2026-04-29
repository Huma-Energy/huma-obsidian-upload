import { describe, expect, it } from "vitest";
import { pushAudit, pushAuditMany } from "../../src/audit/ring";
import type { AuditEntry } from "../../src/types";

function entry(i: number): AuditEntry {
	return {
		timestamp: `2026-04-29T00:00:${String(i).padStart(2, "0")}Z`,
		event: "push_accept",
		path: `note-${i}.md`,
		id: `id-${i}`,
	};
}

describe("audit ring", () => {
	it("pushAudit appends without exceeding capacity", () => {
		const ring: AuditEntry[] = [];
		for (let i = 0; i < 5; i++) pushAudit(ring, entry(i), 3);
		expect(ring.length).toBe(3);
		expect(ring.map((r) => r.path)).toEqual(["note-2.md", "note-3.md", "note-4.md"]);
	});

	it("pushAuditMany evicts the oldest entries when overflowing", () => {
		const ring: AuditEntry[] = [entry(0), entry(1), entry(2)];
		pushAuditMany(ring, [entry(3), entry(4)], 4);
		expect(ring.length).toBe(4);
		expect(ring[0]!.path).toBe("note-1.md");
		expect(ring[3]!.path).toBe("note-4.md");
	});

	it("respects default capacity of 200", () => {
		const ring: AuditEntry[] = [];
		for (let i = 0; i < 250; i++) pushAudit(ring, entry(i));
		expect(ring.length).toBe(200);
		expect(ring[0]!.path).toBe("note-50.md");
	});
});
