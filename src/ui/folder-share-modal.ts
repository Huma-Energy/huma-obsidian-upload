// Folder-share rule editor. Opened from the folder context menu ("Share folder
// on Huma…"). Unlike the per-note ShareModal (live per-control), this composes a
// canonical FolderShareRule (visibility, org role, collaborators) and applies it
// to every synced note in the folder on one "Apply" — a batch, with a confirm
// before any access-reducing propagation. Owner-only notes are skipped server-
// side and reported in the result summary.

import { Modal, Notice, Setting, type App } from "obsidian";
import type { FolderShareRule } from "../settings";
import type {
	ShareAssignableRole,
	ShareUser,
	ShareVisibility,
} from "../types";
import {
	DELETE_FOLDER_RULE_CONFIRM,
	ROLE_LABELS,
	VISIBILITY_LABELS,
	confirm,
	renderUserSearchResults,
	userLabel,
} from "./share-common";
import { isDestructiveEdit } from "../sync/folder-share";

export interface FolderApplySummary {
	applied: number;
	skippedNotOwner: number;
	errors: number;
	// Notes still without a document after the pre-apply push (e.g. excluded
	// or a push failure) — they carry no shareable document.
	notSynced: number;
}

export interface FolderShareModalDeps {
	folderName: string;
	// Synced notes under the folder at open time (drives the button label).
	syncedCount: number;
	totalCount: number;
	initialRule: FolderShareRule;
	isExisting: boolean;
	searchUsers(q: string): Promise<ShareUser[]>;
	onApply(rule: FolderShareRule): Promise<FolderApplySummary>;
	onDelete(): Promise<void>;
}

export class FolderShareModal extends Modal {
	private readonly deps: FolderShareModalDeps;
	private rule: FolderShareRule;
	private readonly displayCache = new Map<string, ShareUser>();
	private busy = false;
	private searchTimer: number | null = null;

	constructor(app: App, deps: FolderShareModalDeps) {
		super(app);
		this.deps = deps;
		this.rule = structuredClone(deps.initialRule);
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		new Setting(contentEl)
			.setName(`Share folder "${this.deps.folderName}"`)
			.setHeading();

		const notSynced = this.deps.totalCount - this.deps.syncedCount;
		new Setting(contentEl).setDesc(
			notSynced > 0
				? `Applies to ${this.deps.totalCount} note(s) in this folder. ${notSynced} not synced yet — they're pushed first, then shared.`
				: `Applies to ${this.deps.syncedCount} note(s) in this folder.`,
		);

		this.renderVisibility();
		this.renderPeople();
		this.renderAddPeople();
		this.renderFooter();
	}

	private renderVisibility(): void {
		const { contentEl } = this;
		new Setting(contentEl)
			.setName("Visibility")
			.setDesc("Applied to every note in the folder.")
			.addDropdown((d) => {
				d.addOptions(VISIBILITY_LABELS as Record<string, string>)
					.setValue(this.rule.visibility)
					.setDisabled(this.busy)
					.onChange((value) => {
						this.rule.visibility = value as ShareVisibility;
						this.render();
					});
			});

		if (this.rule.visibility === "tenant") {
			new Setting(contentEl)
				.setName("Everyone in the organization can")
				.addDropdown((d) => {
					d.addOptions(ROLE_LABELS as Record<string, string>)
						.setValue(this.rule.tenantRole)
						.setDisabled(this.busy)
						.onChange((value) => {
							this.rule.tenantRole = value as ShareAssignableRole;
						});
				});
		}
	}

	private renderPeople(): void {
		const { contentEl } = this;
		new Setting(contentEl).setName("People added to every note").setHeading();

		if (this.rule.collaborators.length === 0) {
			new Setting(contentEl).setDesc("No individual collaborators.");
			return;
		}

		for (const c of this.rule.collaborators) {
			const cached = this.displayCache.get(c.userId) ?? null;
			const setting = new Setting(contentEl)
				.setName(userLabel(cached, c.userId))
				.setDesc(cached?.email ?? "");
			setting.addDropdown((d) => {
				d.addOptions(ROLE_LABELS as Record<string, string>)
					.setValue(c.role)
					.setDisabled(this.busy)
					.onChange((value) => {
						c.role = value as ShareAssignableRole;
					});
			});
			setting.addExtraButton((b) =>
				b
					.setIcon("x")
					.setTooltip("Remove")
					.setDisabled(this.busy)
					.onClick(() => {
						this.rule.collaborators = this.rule.collaborators.filter(
							(x) => x.userId !== c.userId,
						);
						this.render();
					}),
			);
		}
	}

	private renderAddPeople(): void {
		const { contentEl } = this;
		const setting = new Setting(contentEl).setName("Add people");
		let resultsEl: HTMLDivElement;
		setting.addText((t) => {
			t.setPlaceholder("Search name or email…")
				.setDisabled(this.busy)
				.onChange((q) => this.scheduleSearch(q.trim(), resultsEl));
		});
		resultsEl = contentEl.createDiv({ cls: "huma-share-search-results" });
	}

	private renderFooter(): void {
		const { contentEl } = this;
		const applyLabel = `Apply to ${this.deps.syncedCount} note${
			this.deps.syncedCount === 1 ? "" : "s"
		}`;
		const footer = new Setting(contentEl).addButton((b) =>
			b
				.setButtonText(this.busy ? "Applying…" : applyLabel)
				.setCta()
				.setDisabled(this.busy)
				.onClick(() => void this.apply()),
		);

		if (this.deps.isExisting) {
			footer.addButton((b) =>
				b
					.setButtonText("Delete rule")
					.setWarning()
					.setDisabled(this.busy)
					.onClick(() => void this.remove()),
			);
			new Setting(contentEl).setDesc(
				"Deleting stops auto-sharing new notes. Notes already shared keep their current access.",
			);
		}
	}

	private scheduleSearch(q: string, resultsEl: HTMLDivElement): void {
		if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
		if (q.length === 0) {
			resultsEl.empty();
			return;
		}
		this.searchTimer = window.setTimeout(() => {
			void this.runSearch(q, resultsEl);
		}, 250);
	}

	private async runSearch(q: string, resultsEl: HTMLDivElement): Promise<void> {
		let users: ShareUser[];
		try {
			users = await this.deps.searchUsers(q);
		} catch {
			return;
		}
		const existing = new Set(this.rule.collaborators.map((c) => c.userId));
		const candidates = users.filter((u) => !existing.has(u.zitadelSub));
		renderUserSearchResults(resultsEl, candidates, (u) => {
			this.displayCache.set(u.zitadelSub, u);
			this.rule.collaborators = [
				...this.rule.collaborators,
				{ userId: u.zitadelSub, role: "editor" },
			];
			this.render();
		});
	}

	private async apply(): Promise<void> {
		if (this.busy) return;
		if (
			this.deps.isExisting &&
			isDestructiveEdit(this.deps.initialRule, this.rule)
		) {
			const ok = await confirm(this.app, {
				title: "Reduce access?",
				body: `This removes access or lowers visibility on up to ${this.deps.syncedCount} note(s) in this folder. Continue?`,
				cta: "Apply anyway",
			});
			if (!ok) return;
		}
		this.busy = true;
		this.render();
		try {
			const summary = await this.deps.onApply(this.rule);
			new Notice(this.summaryText(summary), 8000);
			this.close();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Huma: ${msg}`, 6000);
			this.busy = false;
			this.render();
		}
	}

	private summaryText(s: FolderApplySummary): string {
		const parts = [`shared ${s.applied} note(s)`];
		if (s.skippedNotOwner > 0) {
			parts.push(`skipped ${s.skippedNotOwner} you don't own`);
		}
		if (s.notSynced > 0) parts.push(`${s.notSynced} not synced yet`);
		if (s.errors > 0) parts.push(`${s.errors} failed`);
		return `Huma: ${parts.join("; ")}.`;
	}

	private async remove(): Promise<void> {
		if (this.busy) return;
		const ok = await confirm(this.app, DELETE_FOLDER_RULE_CONFIRM);
		if (!ok) return;
		this.busy = true;
		this.render();
		try {
			await this.deps.onDelete();
			new Notice("Huma: folder rule deleted.", 4000);
			this.close();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Huma: ${msg}`, 6000);
			this.busy = false;
			this.render();
		}
	}
}
