// Status bar item for the Huma sync state. Renders a Lucide icon (the same
// system Obsidian Sync uses) plus a compact label, color-coded per state.
// The full descriptive text lives in aria-label and the title attribute so
// hover and screen readers still get the long form. attachStatusBar wires
// click-through; the plugin owns what each state's click does.

import { setIcon } from "obsidian";

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

const STATE_CLASSES = [
	"huma-status--blocked",
	"huma-status--signed-out",
	"huma-status--idle",
	"huma-status--syncing",
	"huma-status--error",
	"huma-status--conflict",
] as const;

export function attachStatusBar(el: HTMLElement): StatusBarHandle {
	let current: StatusBarState = { kind: "signed-out" };
	let clickHandler: ((state: StatusBarState) => void) | null = null;
	el.addClass("huma-status-bar");
	el.addEventListener("click", () => clickHandler?.(current));

	return {
		render(state: StatusBarState) {
			current = state;
			el.empty();
			for (const cls of STATE_CLASSES) el.removeClass(cls);
			el.addClass(`huma-status--${state.kind}`);

			const iconEl = el.createSpan({ cls: "huma-status-icon" });
			setIcon(iconEl, iconForState(state));

			const label = shortLabelFor(state);
			if (label.length > 0) {
				el.createSpan({ cls: "huma-status-label", text: label });
			}

			const aria = formatStatusAria(state);
			el.setAttr("aria-label", aria);
			el.setAttr("title", aria);
		},
		onClick(handler) {
			clickHandler = handler;
		},
	};
}

export function iconForState(state: StatusBarState): string {
	switch (state.kind) {
		case "signed-out":
			return "log-in";
		case "idle":
			return "check-circle";
		case "syncing":
			return "refresh-cw";
		case "error":
			return "alert-circle";
		case "conflict":
			return "alert-triangle";
		case "blocked":
			return "ban";
	}
}

export function shortLabelFor(state: StatusBarState): string {
	switch (state.kind) {
		case "signed-out":
			return "";
		case "idle":
			return state.lastSyncedAt ? formatRelative(state.lastSyncedAt) : "";
		case "syncing":
			return state.pendingActions > 0 ? String(state.pendingActions) : "";
		case "error":
			return "";
		case "conflict": {
			const total = state.conflictCount + state.staleCount;
			return total > 0 ? String(total) : "";
		}
		case "blocked":
			return "";
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
