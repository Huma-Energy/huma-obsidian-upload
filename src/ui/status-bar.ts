export type StatusBarState =
	| { kind: "blocked"; reason: string }
	| { kind: "signed-out" }
	| { kind: "idle"; lastSyncedAt: string | null }
	| { kind: "syncing"; pendingActions: number }
	| { kind: "error"; message: string }
	| { kind: "conflict"; conflictCount: number; staleCount: number };

export interface StatusBarHandle {
	render(state: StatusBarState): void;
	onClick(handler: (state: StatusBarState) => void): void;
}

export function attachStatusBar(el: HTMLElement): StatusBarHandle {
	let current: StatusBarState = { kind: "signed-out" };
	let clickHandler: ((state: StatusBarState) => void) | null = null;
	el.addClass("huma-status-bar");
	el.style.cursor = "pointer";
	el.addEventListener("click", () => clickHandler?.(current));

	return {
		render(state: StatusBarState) {
			current = state;
			el.setText(formatStatusText(state));
			el.setAttr("aria-label", formatStatusAria(state));
		},
		onClick(handler) {
			clickHandler = handler;
		},
	};
}

export function formatStatusText(state: StatusBarState): string {
	switch (state.kind) {
		case "blocked":
			return "Huma: ⛔ blocked";
		case "signed-out":
			return "Huma: signed out";
		case "idle":
			return state.lastSyncedAt
				? `Huma: ✓ ${formatRelative(state.lastSyncedAt)}`
				: "Huma: ✓ idle";
		case "syncing":
			return `Huma: ⟳ syncing (${state.pendingActions})`;
		case "error":
			return "Huma: ● error";
		case "conflict": {
			const parts: string[] = [];
			if (state.conflictCount > 0) parts.push(`${state.conflictCount} conflict`);
			if (state.staleCount > 0) parts.push(`${state.staleCount} stale`);
			return `Huma: ⚠ ${parts.join(", ") || "attention"}`;
		}
	}
}

export function formatStatusAria(state: StatusBarState): string {
	switch (state.kind) {
		case "blocked":
			return `Huma Vault Sync blocked: ${state.reason}. Click to open settings.`;
		case "signed-out":
			return "Huma Vault Sync signed out. Click to open settings.";
		case "idle":
			return state.lastSyncedAt
				? `Huma Vault Sync idle. Last synced ${state.lastSyncedAt}.`
				: "Huma Vault Sync idle.";
		case "syncing":
			return `Huma Vault Sync syncing. ${state.pendingActions} actions pending.`;
		case "error":
			return `Huma Vault Sync error: ${state.message}. Click to view log.`;
		case "conflict":
			return `Huma Vault Sync has ${state.conflictCount} unresolved conflicts and ${state.staleCount} stale local deletions.`;
	}
}

function formatRelative(iso: string): string {
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return iso;
	const seconds = Math.floor((Date.now() - ts) / 1000);
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86_400)}d ago`;
}
