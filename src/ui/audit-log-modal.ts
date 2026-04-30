// Sync log modal. Renders the audit ring as filterable rows grouped by
// severity (info / warning / error). Filter buttons at the top toggle
// visibility via a class on the list container; row visibility is
// controlled by CSS so filtering is O(1) and doesn't re-render entries.
// A "Copy all" button serializes the full ring to plain text.

import { App, Modal, Notice, Setting } from "obsidian";
import type { AuditEntry, AuditEvent } from "../types";

type Severity = "info" | "warning" | "error";

const FILTERS: { id: "all" | Severity; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "error", label: "Errors" },
	{ id: "warning", label: "Warnings" },
	{ id: "info", label: "Sync events" },
];

export class AuditLogModal extends Modal {
	private readonly entries: readonly AuditEntry[];

	constructor(app: App, entries: readonly AuditEntry[]) {
		super(app);
		this.entries = entries;
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

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Copy all to clipboard").onClick(async () => {
				await navigator.clipboard.writeText(
					renderAuditPlainText(this.entries),
				);
				new Notice(
					`Huma: copied ${this.entries.length} sync log entries.`,
					3000,
				);
			}),
		);

		const list = contentEl.createDiv({ cls: "huma-audit-log" });
		const filterBar = contentEl.createDiv({ cls: "huma-audit-filter" });

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
			const b = filterBar.createEl("button", {
				text: `${f.label} (${countBy(this.entries, f.id)})`,
				cls: "huma-audit-filter-btn",
			});
			b.dataset.filter = f.id;
			b.addEventListener("click", () => setFilter(f.id));
			filterButtons.push(b);
		}
		// Reorder so the filter bar appears between the description and the
		// list — createDiv inserts in DOM order, so move list after filterBar.
		contentEl.insertBefore(filterBar, list);

		// Build rows newest-first.
		for (const e of [...this.entries].reverse()) {
			const sev = severityFor(e.event);
			const row = list.createDiv({
				cls: `huma-audit-row huma-severity-${sev}`,
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
			return "error";
		case "merge_dirty":
		case "token_scan_warning":
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
