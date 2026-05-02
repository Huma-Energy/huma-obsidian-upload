// Stale local deletion resolution modal. Lists entries where the local
// manifest tracks a UUID whose file no longer exists on disk while the
// server entry is still live. Each row has a Restore button that drops the
// local manifest row and triggers a sync — reconcile then re-pulls the file
// via master-matrix row #3 (server live, local absent, scan absent).

import { App, Modal, Notice } from "obsidian";

export interface StaleEntryView {
	serverId: string;
	path: string;
	lastSyncedAt: string | null;
}

export interface StaleResolutionModalDeps {
	getEntries(): readonly StaleEntryView[];
	restore(serverId: string): Promise<void>;
	ignore(serverId: string): Promise<void>;
}

export class StaleResolutionModal extends Modal {
	private readonly deps: StaleResolutionModalDeps;

	constructor(app: App, deps: StaleResolutionModalDeps) {
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
		contentEl.createEl("h2", { text: "Resolve stale deletions" });

		const entries = this.deps.getEntries();
		if (entries.length === 0) {
			contentEl.createEl("p", {
				text: "No stale deletions outstanding.",
			});
			return;
		}

		contentEl.createEl("p", {
			text: `${entries.length} file(s) are tracked locally but missing from disk while still live on the server.`,
		});

		const tip = contentEl.createEl("p", { cls: "huma-stale-tip" });
		tip.createSpan({ text: "Click " });
		tip.createEl("strong", { text: "Restore" });
		tip.createSpan({
			text: " to download the file back, or ",
		});
		tip.createEl("strong", { text: "Ignore" });
		tip.createSpan({
			text: " to suppress the warning for this file (the server copy is kept; the warning auto-clears if you later delete it in the Huma web app).",
		});

		const list = contentEl.createDiv({ cls: "huma-stale-list" });
		for (const e of entries) {
			const row = list.createDiv({ cls: "huma-stale-row" });

			const info = row.createDiv({ cls: "huma-stale-info" });
			info.createDiv({ cls: "huma-stale-path", text: e.path });
			const meta = info.createDiv({ cls: "huma-stale-meta" });
			meta.createSpan({ cls: "huma-stale-id", text: e.serverId });
			if (e.lastSyncedAt) {
				meta.createSpan({
					cls: "huma-stale-when",
					text: `last synced ${e.lastSyncedAt}`,
				});
			}

			const actions = row.createDiv({ cls: "huma-stale-actions" });
			const restoreBtn = actions.createEl("button", {
				text: "Restore",
				cls: "mod-cta",
			});
			const ignoreBtn = actions.createEl("button", { text: "Ignore" });
			const setBusy = (busy: boolean): void => {
				restoreBtn.disabled = busy;
				ignoreBtn.disabled = busy;
			};
			restoreBtn.addEventListener("click", () => {
				void (async () => {
					setBusy(true);
					restoreBtn.setText("Restoring…");
					try {
						await this.deps.restore(e.serverId);
						new Notice(`Huma: restored ${e.path}.`, 3000);
					} catch (err) {
						const msg =
							err instanceof Error ? err.message : String(err);
						new Notice(
							`Huma: restore failed — ${msg}`,
							6000,
						);
					} finally {
						this.render();
					}
				})();
			});
			ignoreBtn.addEventListener("click", () => {
				void (async () => {
					setBusy(true);
					ignoreBtn.setText("Ignoring…");
					try {
						await this.deps.ignore(e.serverId);
					} catch (err) {
						const msg =
							err instanceof Error ? err.message : String(err);
						new Notice(
							`Huma: ignore failed — ${msg}`,
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
