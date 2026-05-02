// Tracks vault writes the plugin itself initiated, so the resulting
// vault.on('modify') events can be filtered before triggering another sync.
// Entries match by (path, post-write body hash). Each record() call is
// consumed at most once. Entries expire after a TTL to prevent leaks if the
// expected modify event never fires (e.g. Obsidian coalesced our write).

const DEFAULT_TTL_MS = 30_000;

interface Entry {
	hash: string;
	expiresAt: number;
}

export class SelfWriteTracker {
	private readonly entries = new Map<string, Entry[]>();
	private readonly ttlMs: number;

	constructor(ttlMs: number = DEFAULT_TTL_MS) {
		this.ttlMs = ttlMs;
	}

	record(path: string, hash: string, now: number = Date.now()): void {
		const list = this.entries.get(path) ?? [];
		list.push({ hash, expiresAt: now + this.ttlMs });
		this.entries.set(path, list);
	}

	consume(path: string, hash: string, now: number = Date.now()): boolean {
		const list = this.entries.get(path);
		if (!list) return false;
		const live = list.filter((e) => e.expiresAt > now);
		if (live.length === 0) {
			this.entries.delete(path);
			return false;
		}
		const idx = live.findIndex((e) => e.hash === hash);
		if (idx === -1) {
			this.entries.set(path, live);
			return false;
		}
		live.splice(idx, 1);
		if (live.length === 0) this.entries.delete(path);
		else this.entries.set(path, live);
		return true;
	}

	hasPath(path: string): boolean {
		return this.entries.has(path);
	}

	pruneExpired(now: number = Date.now()): void {
		for (const [path, list] of this.entries) {
			const live = list.filter((e) => e.expiresAt > now);
			if (live.length === 0) this.entries.delete(path);
			else this.entries.set(path, live);
		}
	}
}
