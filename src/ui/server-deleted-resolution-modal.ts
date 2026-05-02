// Server-deleted resolution modal. Surfaced when the server has tombstoned
// (archived) one or more files the local vault still holds. Per row the user
// picks Delete locally (OS trash, recoverable) or Keep locally (strip
// huma_uuid frontmatter so the orphan stops re-pushing to the server). No
// auto-action — both branches require explicit consent.

import { App, Modal, Notice } from "obsidian";

export interface ServerDeletedEntryView {
	id: string;
	path: string;
	firstSeenAt: string;
}

export interface ServerDeletedResolutionModalDeps {
	getEntries(): readonly ServerDeletedEntryView[];
	deleteLocally(serverId: string): Promise<void>;
	keepLocally(serverId: string): Promise<void>;
}

export class ServerDeletedResolutionModal extends Modal {
	private readonly deps: ServerDeletedResolutionModalDeps;

	constructor(app: App, deps: ServerDeletedResolutionModalDeps) {
		super(app);
		this.deps = deps;
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Resolve server-deleted files" });

		const entries = this.deps.getEntries();
		if (entries.length === 0) {
			contentEl.createEl("p", {
				text: "No server-deleted files awaiting review.",
			});
			return;
		}

		contentEl.createEl("p", {
			text: `${entries.length} file(s) were archived on the server but still exist locally.`,
		});

		const tip = contentEl.createEl("p", { cls: "huma-stale-tip" });
		tip.createSpan({ text: "Click " });
		tip.createEl("strong", { text: "Delete locally" });
		tip.createSpan({
			text: " to move the file to your OS trash (recoverable), or ",
		});
		tip.createEl("strong", { text: "Keep locally" });
		tip.createSpan({
			text: " to strip the huma_uuid from frontmatter so the file becomes an untracked local copy.",
		});

		const caveat = contentEl.createEl("p", { cls: "huma-stale-tip" });
		caveat.createEl("strong", { text: "Heads-up: " });
		caveat.createSpan({
			text: "if the file is later un-archived on the web, the plugin won't notice automatically (the manifest's delta-fetch doesn't surface un-archive events). After Delete locally you'll need to manually re-pull. After Keep locally, editing the file will re-sync it as a new file with a fresh UUID — the original server entry stays disconnected.",
		});

		const list = contentEl.createDiv({ cls: "huma-stale-list" });
		for (const e of entries) {
			const row = list.createDiv({ cls: "huma-stale-row" });

			const info = row.createDiv({ cls: "huma-stale-info" });
			info.createDiv({ cls: "huma-stale-path", text: e.path });
			const meta = info.createDiv({ cls: "huma-stale-meta" });
			meta.createSpan({ cls: "huma-stale-id", text: e.id });
			meta.createSpan({
				cls: "huma-stale-when",
				text: `tombstone seen ${e.firstSeenAt}`,
			});

			const actions = row.createDiv({ cls: "huma-stale-actions" });
			const deleteBtn = actions.createEl("button", {
				text: "Delete locally",
				cls: "mod-warning",
			});
			const keepBtn = actions.createEl("button", { text: "Keep locally" });
			const setBusy = (busy: boolean): void => {
				deleteBtn.disabled = busy;
				keepBtn.disabled = busy;
			};
			deleteBtn.addEventListener("click", () => {
				void (async () => {
					setBusy(true);
					deleteBtn.setText("Deleting…");
					try {
						await this.deps.deleteLocally(e.id);
						new Notice(`Huma: moved ${e.path} to trash.`, 3000);
					} catch (err) {
						const msg =
							err instanceof Error ? err.message : String(err);
						new Notice(
							`Huma: delete failed — ${msg}`,
							6000,
						);
					} finally {
						this.render();
					}
				})();
			});
			keepBtn.addEventListener("click", () => {
				void (async () => {
					setBusy(true);
					keepBtn.setText("Keeping…");
					try {
						await this.deps.keepLocally(e.id);
						new Notice(
							`Huma: stripped huma_uuid from ${e.path}.`,
							3000,
						);
					} catch (err) {
						const msg =
							err instanceof Error ? err.message : String(err);
						new Notice(
							`Huma: keep failed — ${msg}`,
							6000,
						);
					} finally {
						this.render();
					}
				})();
			});
		}
	}
}
