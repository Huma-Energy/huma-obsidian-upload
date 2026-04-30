// Mobile-only sync status modal. Reached via the ribbon icon since custom
// status bar items are unsupported on Obsidian mobile (see User interface/
// Status bar.md). Shows the current EngineState in plain language and offers
// the user-actionable affordances available from the desktop status bar:
// "Sync now" and an entry into the conflict resolver.

import { Modal, Setting, type App } from "obsidian";
import type { EngineState } from "../sync/engine";

export interface MobileStatusModalOptions {
	getState(): EngineState | { kind: "signed-out" };
	getLastSyncedAt(): string | null;
	getConflictCount(): number;
	onSyncNow(): void;
	onResolveConflicts(): void;
	onOpenLog(): void;
}

export class MobileStatusModal extends Modal {
	private readonly opts: MobileStatusModalOptions;

	constructor(app: App, opts: MobileStatusModalOptions) {
		super(app);
		this.opts = opts;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		new Setting(contentEl).setName("Huma sync").setHeading();

		const state = this.opts.getState();
		const lastSyncedAt = this.opts.getLastSyncedAt();
		const conflicts = this.opts.getConflictCount();

		new Setting(contentEl).setDesc(describeState(state, lastSyncedAt, conflicts));

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Sync now").setCta().onClick(() => {
				this.opts.onSyncNow();
				this.close();
			}),
		);

		if (conflicts > 0) {
			new Setting(contentEl).addButton((btn) =>
				btn.setButtonText(`Resolve conflicts (${conflicts})`).onClick(() => {
					this.opts.onResolveConflicts();
					this.close();
				}),
			);
		}

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Show sync log").onClick(() => {
				this.opts.onOpenLog();
				this.close();
			}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function describeState(
	state: EngineState | { kind: "signed-out" },
	lastSyncedAt: string | null,
	conflicts: number,
): string {
	switch (state.kind) {
		case "signed-out":
			return "Not signed in. Open the plugin settings to sign in.";
		case "idle":
			return lastSyncedAt
				? `Idle. Last synced ${lastSyncedAt}.`
				: "Idle.";
		case "syncing":
			return `Syncing — ${state.pending} action(s) pending.`;
		case "error":
			return `Error: ${state.message}`;
		case "conflict":
			return `${conflicts} unresolved conflict(s); ${state.stale} stale local deletion(s).`;
	}
}

