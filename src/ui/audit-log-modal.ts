// Sync log modal. Renders the audit ring as filterable rows grouped by
// severity (info / warning / error). Filter buttons at the top toggle
// visibility via a class on the list container; row visibility is
// controlled by CSS so filtering is O(1) and doesn't re-render entries.
// A "Copy all" button serializes the full ring to plain text.

import { App, Modal, Notice } from "obsidian";
import type { AuditEntry, AuditEvent } from "../types";

type Severity = "info" | "warning" | "error";

const FILTERS: { id: "all" | Severity; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "error", label: "Errors" },
	{ id: "warning", label: "Warnings" },
	{ id: "info", label: "Sync" },
];

export interface AuditLogModalHooks {
	onResolveStale?: () => void;
	hasStale?: () => boolean;
	onResolveServerDeleted?: () => void;
	hasServerDeleted?: () => boolean;
}

export class AuditLogModal extends Modal {
	private readonly entries: readonly AuditEntry[];
	private readonly onClear?: () => Promise<void>;
	private readonly hooks: AuditLogModalHooks;

	constructor(
		app: App,
		entries: readonly AuditEntry[],
		onClear?: () => Promise<void>,
		hooks: AuditLogModalHooks = {},
	) {
		super(app);
		this.entries = entries;
		this.onClear = onClear;
		this.hooks = hooks;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Huma sync log" });

		if (this.entries.length === 0) {
			contentEl.createEl("p", {
				text: "No sync activity recorded yet. Audit entries appear here after the first sync cycle.",
			});
			return;
		}

		contentEl.createEl("p", {
			text: `Showing the last ${this.entries.length} actions from this device's local audit ring (capped at 200). The server's audit log is the canonical record.`,
		});

		// Single toolbar holding action buttons + filter pills on one row.
		const toolbar = contentEl.createDiv({ cls: "huma-audit-toolbar" });

		const copyBtn = toolbar.createEl("button", { text: "Copy" });
		copyBtn.addEventListener("click", () => {
			void (async () => {
				await navigator.clipboard.writeText(
					renderAuditPlainText(this.entries),
				);
				new Notice(
					`Huma: copied ${this.entries.length} sync log entries.`,
					3000,
				);
			})();
		});
		if (this.onClear) {
			const clearBtn = toolbar.createEl("button", {
				text: "Clear",
				cls: "mod-warning",
			});
			clearBtn.addEventListener("click", () => {
				void (async () => {
					const count = this.entries.length;
					await this.onClear?.();
					new Notice(
						`Huma: cleared ${count} sync log entries.`,
						3000,
					);
					// Re-render with the now-empty ring; onOpen handles the
					// empty-state message.
					this.onOpen();
				})();
			});
		}

		// Visual separator between action buttons and filter pills.
		toolbar.createDiv({ cls: "huma-audit-toolbar-sep" });

		const list = contentEl.createDiv({ cls: "huma-audit-log" });

		// Filter buttons swap a class on the list container; CSS hides rows
		// that don't match. No re-render needed.
		const filterButtons: HTMLButtonElement[] = [];
		const setFilter = (id: "all" | Severity) => {
			list.removeClass(
				"huma-audit-log--all",
				"huma-audit-log--error",
				"huma-audit-log--warning",
				"huma-audit-log--info",
			);
			list.addClass(`huma-audit-log--${id}`);
			for (const b of filterButtons) {
				b.toggleClass("is-active", b.dataset.filter === id);
			}
		};
		for (const f of FILTERS) {
			const b = toolbar.createEl("button", {
				text: `${f.label} (${countBy(this.entries, f.id)})`,
				cls: "huma-audit-filter-btn",
			});
			b.dataset.filter = f.id;
			b.addEventListener("click", () => setFilter(f.id));
			filterButtons.push(b);
		}

		// Build rows newest-first.
		const canResolveStale =
			!!this.hooks.onResolveStale &&
			(this.hooks.hasStale?.() ?? false);
		const canResolveServerDeleted =
			!!this.hooks.onResolveServerDeleted &&
			(this.hooks.hasServerDeleted?.() ?? false);
		for (const e of [...this.entries].reverse()) {
			const sev = severityFor(e.event);
			const isResolvableStale =
				e.event === "stale_local_delete" && canResolveStale;
			const isResolvableServerDeleted =
				e.event === "server_deleted" && canResolveServerDeleted;
			const isClickable =
				isResolvableStale || isResolvableServerDeleted;
			const row = list.createDiv({
				cls: `huma-audit-row huma-severity-${sev}${
					isClickable ? " huma-audit-row--clickable" : ""
				}`,
			});
			row.createSpan({ cls: "huma-audit-ts", text: e.timestamp });
			row.createSpan({ cls: "huma-audit-event", text: e.event });
			row.createSpan({
				cls: "huma-audit-id",
				text: e.id ?? "",
			});
			row.createSpan({ cls: "huma-audit-path", text: e.path });
			row.createSpan({
				cls: "huma-audit-detail",
				text: e.detail ?? "",
			});
			if (isClickable) {
				row.setAttr("role", "button");
				row.setAttr("tabindex", "0");
				const ariaLabel = isResolvableStale
					? `Resolve stale deletion for ${e.path}`
					: `Review server-deleted file ${e.path}`;
				row.setAttr("aria-label", ariaLabel);
				const open = (): void => {
					this.close();
					if (isResolvableStale) {
						this.hooks.onResolveStale?.();
					} else if (isResolvableServerDeleted) {
						this.hooks.onResolveServerDeleted?.();
					}
				};
				row.addEventListener("click", open);
				row.addEventListener("keydown", (ev) => {
					if (ev.key === "Enter" || ev.key === " ") {
						ev.preventDefault();
						open();
					}
				});
			}
		}

		setFilter("all");
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function renderAuditPlainText(entries: readonly AuditEntry[]): string {
	return [...entries]
		.reverse()
		.map((e) => {
			const id = e.id ? ` ${e.id}` : "";
			const detail = e.detail ? ` — ${e.detail}` : "";
			return `${e.timestamp} ${e.event}${id} ${e.path}${detail}`;
		})
		.join("\n");
}

function severityFor(event: AuditEvent): Severity {
	switch (event) {
		case "push_reject":
		case "auth_error":
			return "error";
		case "merge_dirty":
		case "token_scan_warning":
		case "stale_local_delete":
		case "server_deleted":
			return "warning";
		default:
			return "info";
	}
}

function countBy(
	entries: readonly AuditEntry[],
	filter: "all" | Severity,
): number {
	if (filter === "all") return entries.length;
	let n = 0;
	for (const e of entries) if (severityFor(e.event) === filter) n++;
	return n;
}
