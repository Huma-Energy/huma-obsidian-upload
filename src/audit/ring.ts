import type { AuditEntry } from "../types";

export const AUDIT_RING_CAPACITY = 200;

// Append-with-eviction. Mutates the input array for cheap in-place updates;
// callers persist via plugin saveData after a batch of pushes.
export function pushAudit(
	ring: AuditEntry[],
	entry: AuditEntry,
	capacity: number = AUDIT_RING_CAPACITY,
): void {
	ring.push(entry);
	const overflow = ring.length - capacity;
	if (overflow > 0) ring.splice(0, overflow);
}

export function pushAuditMany(
	ring: AuditEntry[],
	entries: readonly AuditEntry[],
	capacity: number = AUDIT_RING_CAPACITY,
): void {
	for (const e of entries) ring.push(e);
	const overflow = ring.length - capacity;
	if (overflow > 0) ring.splice(0, overflow);
}
