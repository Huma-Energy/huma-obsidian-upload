// Shared presentation helpers for the sharing modals (per-note ShareModal and
// FolderShareModal): the user-facing visibility labels (tenant → "Organization"
// per the locked UX vocabulary), the assignable-role labels, and the
// name/email/id fallback used to label a person. Kept here so the two modals
// cannot drift on wording.

import { Modal, Setting, type App } from "obsidian";
import type {
	ShareAssignableRole,
	ShareUser,
	ShareVisibility,
} from "../types";

export const VISIBILITY_LABELS: Record<ShareVisibility, string> = {
	private: "Private",
	tenant: "Organization",
	public: "Public",
};

export const ROLE_LABELS: Record<ShareAssignableRole, string> = {
	editor: "Editor",
	commenter: "Commenter",
	viewer: "Viewer",
};

export function userLabel(user: ShareUser | null, fallbackId: string): string {
	return user?.name ?? user?.email ?? fallbackId;
}

// Render collaborator-typeahead result rows into `resultsEl`: one row per
// candidate with an "Add" CTA, or a single empty-state line when there are
// none. Shared by both share modals so their result lists stay identical; each
// modal keeps its own debounce and candidate filtering.
export function renderUserSearchResults(
	resultsEl: HTMLElement,
	candidates: readonly ShareUser[],
	onPick: (user: ShareUser) => void,
	addLabel = "Add as editor",
): void {
	resultsEl.empty();
	if (candidates.length === 0) {
		resultsEl.createDiv({
			cls: "huma-share-search-empty",
			text: "No matching people.",
		});
		return;
	}
	for (const u of candidates) {
		const row = resultsEl.createDiv({ cls: "huma-share-search-row" });
		new Setting(row)
			.setName(userLabel(u, u.zitadelSub))
			.setDesc(u.email ?? "")
			.addButton((b) =>
				b
					.setButtonText(addLabel)
					.setCta()
					.onClick(() => onPick(u)),
			);
	}
}

// Minimal yes/no confirmation. Used before destructive folder-rule
// propagation (removing access / narrowing visibility across many notes).
// Resolves false if the modal is dismissed without choosing.
class ConfirmModal extends Modal {
	private resolved = false;
	constructor(
		app: App,
		private readonly opts: {
			title: string;
			body: string;
			cta: string;
			onResolve: (ok: boolean) => void;
		},
	) {
		super(app);
	}

	onOpen(): void {
		new Setting(this.contentEl).setName(this.opts.title).setHeading();
		this.contentEl.createEl("p", { text: this.opts.body });
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText("Cancel").onClick(() => this.finish(false)),
			)
			.addButton((b) =>
				b
					.setButtonText(this.opts.cta)
					.setWarning()
					.onClick(() => this.finish(true)),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(false);
	}

	private finish(ok: boolean): void {
		if (this.resolved) return;
		this.resolved = true;
		this.opts.onResolve(ok);
		this.close();
	}
}

export function confirm(
	app: App,
	opts: { title: string; body: string; cta: string },
): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, { ...opts, onResolve: resolve }).open();
	});
}

// Shared payload for the delete-folder-rule confirmation, used by both the
// folder-share modal and the settings tab so the locked wording stays in sync.
export const DELETE_FOLDER_RULE_CONFIRM = {
	title: "Delete folder rule?",
	body: "New notes in this folder will no longer be shared automatically. Notes already shared keep their current access.",
	cta: "Delete rule",
} as const;
