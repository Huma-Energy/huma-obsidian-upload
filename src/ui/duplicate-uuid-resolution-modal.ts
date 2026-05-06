// Duplicate-UUID resolution modal. Surfaced when two or more vault files
// share the same huma_uuid, which pauses sync for that UUID. Per duplicate
// set the user picks one file to keep the binding; the others have their
// huma_uuid stripped so they become untracked locals and re-sync as new
// files on the next cycle. No auto-action — pick is always explicit.

import { App, Modal, Notice } from "obsidian";

export interface DuplicateUuidEntryView {
	uuid: string;
	paths: string[];
}

export interface DuplicateUuidResolutionModalDeps {
	getEntries(): readonly DuplicateUuidEntryView[];
	keepUuid(uuid: string, keepPath: string): Promise<void>;
}

export class DuplicateUuidResolutionModal extends Modal {
	private readonly deps: DuplicateUuidResolutionModalDeps;

	constructor(app: App, deps: DuplicateUuidResolutionModalDeps) {
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
		contentEl.createEl("h2", { text: "Resolve duplicate files" });

		const entries = this.deps.getEntries();
		if (entries.length === 0) {
			contentEl.createEl("p", {
				text: "No duplicate files outstanding.",
			});
			return;
		}

		contentEl.createEl("p", {
			text: `${entries.length} group(s) of files share a sync link. Sync is paused for each group until you pick which file keeps the link.`,
		});

		const tip = contentEl.createEl("p", { cls: "huma-stale-tip" });
		tip.createSpan({ text: "Click " });
		tip.createEl("strong", { text: "Keep this one" });
		tip.createSpan({
			text: " on the file that should stay linked. The other file(s) will sync as new files on the next cycle, with their current contents.",
		});

		const list = contentEl.createDiv({ cls: "huma-stale-list" });
		for (const e of entries) {
			const setEl = list.createDiv({ cls: "huma-duplicate-set" });
			setEl.createDiv({
				cls: "huma-stale-id huma-duplicate-set-id",
				text: e.uuid,
			});

			const allButtons: HTMLButtonElement[] = [];
			const setBusy = (busy: boolean): void => {
				for (const b of allButtons) b.disabled = busy;
			};

			for (const path of e.paths) {
				const row = setEl.createDiv({ cls: "huma-stale-row" });

				const info = row.createDiv({ cls: "huma-stale-info" });
				info.createDiv({ cls: "huma-stale-path", text: path });

				const actions = row.createDiv({ cls: "huma-stale-actions" });
				const keepBtn = actions.createEl("button", {
					text: "Keep this one",
					cls: "mod-cta",
				});
				allButtons.push(keepBtn);
				keepBtn.addEventListener("click", () => {
					void (async () => {
						setBusy(true);
						keepBtn.setText("Keeping…");
						const otherCount = e.paths.length - 1;
						try {
							await this.deps.keepUuid(e.uuid, path);
							new Notice(
								`Huma: kept ${path}; ${otherCount} other file(s) will sync as new on the next cycle.`,
								4000,
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
}
