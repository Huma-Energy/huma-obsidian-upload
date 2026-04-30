import { App, MarkdownRenderer, Modal, type Component } from "obsidian";
import type { AuditEntry } from "../types";

export class AuditLogModal extends Modal {
	private readonly entries: readonly AuditEntry[];
	private readonly owner: Component;

	constructor(app: App, entries: readonly AuditEntry[], owner: Component) {
		super(app);
		this.entries = entries;
		this.owner = owner;
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

		const intro = contentEl.createEl("p");
		intro.setText(
			`Showing the last ${this.entries.length} actions from this device's local audit ring (capped at 200). The server's audit log is the canonical record.`,
		);

		const md = renderAuditMarkdown(this.entries);
		const container = contentEl.createDiv({ cls: "huma-audit-log" });
		void MarkdownRenderer.render(this.app, md, container, "/", this.owner);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function renderAuditMarkdown(entries: readonly AuditEntry[]): string {
	const rows = [...entries].reverse().map((e) => {
		const detail = e.detail ? ` — ${escapeMarkdown(e.detail)}` : "";
		const id = e.id ? ` \`${e.id}\`` : "";
		return `- **${e.timestamp}** \`${e.event}\`${id} \`${escapeMarkdown(e.path)}\`${detail}`;
	});
	return rows.join("\n");
}

function escapeMarkdown(s: string): string {
	return s.replace(/([\\`*_{}[\]()#+\-.!|])/g, "\\$1");
}
