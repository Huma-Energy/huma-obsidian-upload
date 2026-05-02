// First-run welcome modal that auto-opens once on plugin enable when no
// tokens are stored and welcomeSeenAt is null. Three steps: (1) confirm or
// edit the server URL behind an Advanced disclosure, (2) Sign in (delegates
// to SignInModal), (3) report the first-sync result. Step 3 sets
// welcomeSeenAt so the modal does not reappear on subsequent enables.

import { App, Modal, Notice, Setting } from "obsidian";
import type { SyncRunResult } from "../sync/engine";

export interface WelcomeSignInCallbacks {
	onSuccess: () => Promise<void>;
	onCancel: () => void;
	onError: (err: unknown) => void;
}

export interface WelcomeModalDeps {
	getServerUrl: () => string;
	setServerUrl: (url: string) => Promise<void>;
	// Plugin opens SignInModal with its own auth wiring + the welcome
	// modal's callbacks for step transitions. Plugin's onSuccess persists
	// tokens via finishSignIn before invoking welcome's onSuccess.
	startSignIn: (callbacks: WelcomeSignInCallbacks) => void;
	runFirstSync: () => Promise<SyncRunResult | null>;
	markWelcomeSeen: () => Promise<void>;
}

type WelcomeStep = 1 | 2 | 3 | "syncing";

export class WelcomeModal extends Modal {
	private readonly deps: WelcomeModalDeps;
	private step: WelcomeStep = 1;
	private lastSync: SyncRunResult | null = null;
	private lastError: string | null = null;
	private settled = false;

	constructor(app: App, deps: WelcomeModalDeps) {
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
		switch (this.step) {
			case 1:
				this.renderStep1(contentEl);
				return;
			case 2:
				this.renderStep2(contentEl);
				return;
			case "syncing":
				this.renderSyncing(contentEl);
				return;
			case 3:
				this.renderStep3(contentEl);
				return;
		}
	}

	private renderStep1(contentEl: HTMLElement): void {
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Huma" is the product name
		contentEl.createEl("h2", { text: "Welcome to Huma Vault Sync" });
		contentEl.createEl("p", {
			cls: "huma-welcome-tip",
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Huma" is the product name
			text: "Your notes will sync to the Huma dashboard. Let's get you connected.",
		});

		const urlBlock = contentEl.createDiv({ cls: "huma-welcome-url" });
		urlBlock.createEl("p", {
			cls: "huma-welcome-url-label",
			text: "Server",
		});
		urlBlock.createEl("p", {
			cls: "huma-welcome-url-value",
			text: this.deps.getServerUrl(),
		});

		// Advanced disclosure: details/summary lets the user expand to edit
		// the URL without making it the primary action. Most users skip it.
		const details = contentEl.createEl("details", {
			cls: "huma-welcome-advanced",
		});
		details.createEl("summary", { text: "Advanced settings" });
		const advancedBody = details.createDiv();
		advancedBody.createEl("p", {
			cls: "huma-welcome-tip",
			text: "Most users should leave this as is. Change only if you've been given a custom server URL.",
		});
		new Setting(advancedBody).setName("Server URL").addText((text) =>
			text
				.setValue(this.deps.getServerUrl())
				.onChange(async (value) => {
					await this.deps.setServerUrl(value);
				}),
		);

		const footer = contentEl.createDiv({ cls: "huma-welcome-footer" });
		const skip = footer.createEl("button", { text: "Skip for now" });
		skip.addEventListener("click", () => this.handleSkip());
		const cont = footer.createEl("button", {
			text: "Continue",
			cls: "mod-cta",
		});
		cont.addEventListener("click", () => {
			this.step = 2;
			this.render();
		});
	}

	private renderStep2(contentEl: HTMLElement): void {
		contentEl.createEl("h2", { text: "Sign in" });
		contentEl.createEl("p", {
			cls: "huma-welcome-tip",
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Sign in" is the button label being referenced
			text: "Click Sign in to authorize the plugin. Your browser will open with a code to enter.",
		});
		if (this.lastError) {
			contentEl.createEl("p", {
				cls: "huma-welcome-error",
				text: `Last attempt failed: ${this.lastError}`,
			});
		}

		const footer = contentEl.createDiv({ cls: "huma-welcome-footer" });
		const skip = footer.createEl("button", { text: "Skip for now" });
		skip.addEventListener("click", () => this.handleSkip());
		const signIn = footer.createEl("button", {
			text: "Sign in",
			cls: "mod-cta",
		});
		signIn.addEventListener("click", () => this.startSignIn());
	}

	private renderSyncing(contentEl: HTMLElement): void {
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Huma" is the product name
		contentEl.createEl("h2", { text: "Connecting Huma…" });
		contentEl.createEl("p", {
			cls: "huma-welcome-tip",
			text: "Running the first sync. This usually takes a few seconds.",
		});
	}

	private renderStep3(contentEl: HTMLElement): void {
		contentEl.createEl("h2", { text: "You're connected" });
		const message = this.firstSyncMessage();
		contentEl.createEl("p", {
			cls: "huma-welcome-tip",
			text: message,
		});

		const footer = contentEl.createDiv({ cls: "huma-welcome-footer" });
		const start = footer.createEl("button", {
			text: "Get started",
			cls: "mod-cta",
		});
		start.addEventListener("click", () => {
			void (async () => {
				start.disabled = true;
				try {
					await this.deps.markWelcomeSeen();
				} catch (err) {
					new Notice(
						`Huma: failed to save welcome flag — ${
							err instanceof Error ? err.message : String(err)
						}`,
						6000,
					);
				} finally {
					this.settled = true;
					this.close();
				}
			})();
		});
	}

	private firstSyncMessage(): string {
		if (this.lastError) {
			return `Sign-in worked but the first sync failed: ${this.lastError}. Click Sync now in settings to retry.`;
		}
		const result = this.lastSync;
		if (!result) {
			return "Sign-in succeeded. Sync runs automatically in the background — check the status bar at the bottom-right.";
		}
		const total = result.actions.length;
		if (total > 0) {
			return `Synced ${total} action${
				total === 1 ? "" : "s"
			}. The status bar at the bottom-right shows current state — click it any time to sync again.`;
		}
		return "No files to sync yet. Open or create a note in this vault and Huma will sync it on the next cycle (every 30 seconds by default).";
	}

	private startSignIn(): void {
		this.lastError = null;
		// Close-out our visible UI; the modal stays mounted so we can
		// resume rendering when SignInModal completes. Empty contentEl
		// ensures nothing is left behind during the brief switch.
		this.contentEl.empty();
		this.deps.startSignIn({
			onSuccess: async () => {
				// Plugin's onSuccess already persisted tokens + started
				// polling via finishSignIn. We continue to step 3 with
				// the first-sync result.
				await this.runFirstSyncAndAdvance();
			},
			onCancel: () => {
				// User cancelled sign-in — bring them back to step 2.
				this.render();
			},
			onError: (err) => {
				this.lastError = err instanceof Error ? err.message : String(err);
				this.render();
			},
		});
	}

	private async runFirstSyncAndAdvance(): Promise<void> {
		this.step = "syncing";
		this.render();
		try {
			this.lastSync = await this.deps.runFirstSync();
			this.lastError = null;
		} catch (err) {
			this.lastError = err instanceof Error ? err.message : String(err);
		}
		this.step = 3;
		this.render();
	}

	private handleSkip(): void {
		// Skip does NOT mark welcomeSeenAt — the modal will reopen on next
		// enable until the user completes step 3 or signs in independently
		// via the standalone command.
		this.settled = true;
		this.close();
	}
}
