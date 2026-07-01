// Per-note sharing modal. Opened from the file context menu / "Share this
// note" command. Renders visibility (private/organization/public), the
// organization role, the public link, and the per-person collaborator list
// with a tenant-user typeahead. Each control applies live via injected deps
// (which call the bearer /api/vault/share endpoint); read-only for non-owners.

import { Modal, Notice, Setting, type App } from "obsidian";
import type {
	ShareAssignableRole,
	ShareStateResponse,
	ShareUser,
	ShareVisibility,
} from "../types";
import {
	ROLE_LABELS,
	VISIBILITY_LABELS,
	renderUserSearchResults,
	userLabel,
} from "./share-common";

// Deps return the refreshed state so the modal re-renders from server truth
// after every mutation; the owner of these callbacks (main.ts) also updates
// the frontmatter mirror + audit ring as a side effect.
export interface ShareModalDeps {
	noteTitle: string;
	serverBaseUrl: string;
	initialState: ShareStateResponse;
	setVisibility(v: ShareVisibility): Promise<ShareStateResponse>;
	setTenantRole(r: ShareAssignableRole): Promise<ShareStateResponse>;
	addCollaborator(
		identifier: string,
		role: ShareAssignableRole,
	): Promise<ShareStateResponse>;
	updateCollaboratorRole(
		userId: string,
		role: ShareAssignableRole,
	): Promise<ShareStateResponse>;
	removeCollaborator(userId: string): Promise<ShareStateResponse>;
	searchUsers(q: string): Promise<ShareUser[]>;
}

export class ShareModal extends Modal {
	private readonly deps: ShareModalDeps;
	private state: ShareStateResponse;
	private busy = false;
	private searchTimer: number | null = null;

	constructor(app: App, deps: ShareModalDeps) {
		super(app);
		this.deps = deps;
		this.state = deps.initialState;
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
		this.contentEl.empty();
	}

	// Runs a mutation, swallows the per-call error into a Notice, and always
	// re-renders from the latest known state so a failed control snaps back.
	private async apply(
		op: () => Promise<ShareStateResponse>,
	): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			this.state = await op();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Huma: ${msg}`, 6000);
		} finally {
			this.busy = false;
			this.render();
		}
	}

	private publicUrl(): string | null {
		if (this.state.visibility !== "public" || !this.state.publicSlug) return null;
		const base = this.deps.serverBaseUrl.replace(/\/+$/, "");
		return `${base}/documents/public/${this.state.publicSlug}`;
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		new Setting(contentEl)
			.setName(`Share "${this.deps.noteTitle}"`)
			.setHeading();

		if (!this.state.isOwner) {
			this.renderReadOnly();
			return;
		}

		this.renderVisibility();
		this.renderPeople();
		this.renderAddPeople();
	}

	private renderReadOnly(): void {
		const { contentEl } = this;
		new Setting(contentEl).setDesc(
			"Only the owner can change sharing for this note.",
		);
		new Setting(contentEl)
			.setName("Visibility")
			.setDesc(VISIBILITY_LABELS[this.state.visibility]);
		if (this.state.visibility === "tenant") {
			new Setting(contentEl)
				.setName("Everyone in the organization can")
				.setDesc(ROLE_LABELS[this.state.tenantRole]);
		}
		const url = this.publicUrl();
		if (url) {
			new Setting(contentEl).setName("Public link").setDesc(url);
		}
		this.renderPeople(true);
	}

	private renderVisibility(): void {
		const { contentEl } = this;
		new Setting(contentEl)
			.setName("Visibility")
			.setDesc("Who can find this note.")
			.addDropdown((d) => {
				d.addOptions(VISIBILITY_LABELS as Record<string, string>)
					.setValue(this.state.visibility)
					.setDisabled(this.busy)
					.onChange((value) =>
						void this.apply(() =>
							this.deps.setVisibility(value as ShareVisibility),
						),
					);
			});

		if (this.state.visibility === "tenant") {
			new Setting(contentEl)
				.setName("Everyone in the organization can")
				.addDropdown((d) => {
					d.addOptions(ROLE_LABELS as Record<string, string>)
						.setValue(this.state.tenantRole)
						.setDisabled(this.busy)
						.onChange((value) =>
							void this.apply(() =>
								this.deps.setTenantRole(value as ShareAssignableRole),
							),
						);
				});
		}

		const url = this.publicUrl();
		if (url) {
			new Setting(contentEl)
				.setName("Public link")
				.setDesc(url)
				.addButton((b) =>
					b.setButtonText("Copy").onClick(() => {
						void navigator.clipboard
							.writeText(url)
							.then(() => new Notice("Huma: public link copied.", 3000));
					}),
				);
		}
	}

	private renderPeople(readOnly = false): void {
		const { contentEl } = this;
		new Setting(contentEl).setName("People with access").setHeading();

		if (this.state.owner) {
			new Setting(contentEl)
				.setName(userLabel(this.state.owner, this.state.ownerId ?? "owner"))
				.setDesc(this.state.owner.email ?? "")
				.addExtraButton((b) => b.setIcon("crown").setTooltip("Owner").setDisabled(true));
		}

		for (const c of this.state.collaborators) {
			const setting = new Setting(contentEl)
				.setName(userLabel(c.user, c.userId))
				.setDesc(c.user?.email ?? c.userId);
			setting.addDropdown((d) => {
				d.addOptions(ROLE_LABELS as Record<string, string>)
					.setValue(c.role)
					.setDisabled(readOnly || this.busy)
					.onChange((value) =>
						void this.apply(() =>
							this.deps.updateCollaboratorRole(
								c.userId,
								value as ShareAssignableRole,
							),
						),
					);
			});
			if (!readOnly) {
				setting.addExtraButton((b) =>
					b
						.setIcon("x")
						.setTooltip("Remove")
						.setDisabled(this.busy)
						.onClick(() =>
							void this.apply(() => this.deps.removeCollaborator(c.userId)),
						),
				);
			}
		}

		if (this.state.collaborators.length === 0 && readOnly) {
			new Setting(contentEl).setDesc("No individual collaborators.");
		}
	}

	private renderAddPeople(): void {
		const { contentEl } = this;
		const setting = new Setting(contentEl).setName("Add people");
		let resultsEl: HTMLDivElement;
		setting.addText((t) => {
			t.setPlaceholder("Search name or email…").onChange((q) =>
				this.scheduleSearch(q.trim(), resultsEl),
			);
		});
		resultsEl = contentEl.createDiv({ cls: "huma-share-search-results" });
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
		const ownerId = this.state.ownerId;
		const existing = new Set(this.state.collaborators.map((c) => c.userId));
		const candidates = users.filter(
			(u) => u.zitadelSub !== ownerId && !existing.has(u.zitadelSub),
		);
		renderUserSearchResults(resultsEl, candidates, (u) => {
			resultsEl.empty();
			void this.apply(() =>
				this.deps.addCollaborator(u.zitadelSub, "editor"),
			);
		});
	}

}
