// Sign-in modal owning the OAuth device-flow UX. Renders the user code with
// Copy code + Open browser actions, polls the server via runDevicePollLoop
// (cancellation via AbortController), and surfaces denied/expired/network
// errors with a Try again button. Replaces the prior 10-second Notice flow
// so the code stays visible until the user confirms in the browser.

import { App, Modal, Notice } from "obsidian";
import {
	runDevicePollLoop,
	type DevicePollOutcome,
	type SignInProgress,
} from "../client/auth";
import type { StoredTokens } from "../settings";
import type { DeviceAuthResponse } from "../types";

export interface SignInModalDeps {
	startDeviceFlow: () => Promise<SignInProgress>;
	poll: (sessionId: string) => Promise<DevicePollOutcome>;
	onSuccess: (tokens: StoredTokens) => Promise<void>;
	onCancel: () => void;
	onError: (err: unknown) => void;
}

type ViewState =
	| { kind: "starting" }
	| { kind: "polling"; deviceCode: DeviceAuthResponse; deadline: number; statusNote: string }
	| { kind: "denied" }
	| { kind: "expired" }
	| { kind: "error"; message: string };

export class SignInModal extends Modal {
	private readonly deps: SignInModalDeps;
	private controller: AbortController | null = null;
	private state: ViewState = { kind: "starting" };
	private expiryTimer: number | null = null;
	private settled = false;

	constructor(app: App, deps: SignInModalDeps) {
		super(app);
		this.deps = deps;
	}

	onOpen(): void {
		this.render();
		void this.startFlow();
	}

	onClose(): void {
		this.clearExpiryTimer();
		// Abort any in-flight poll. If we already settled (success / explicit
		// cancel / explicit error), the controller has been retired.
		if (this.controller && !this.controller.signal.aborted) {
			this.controller.abort();
		}
		// If the modal is dismissed (Esc / X) without a deliberate outcome,
		// treat it as a cancel so the caller's promise resolves.
		if (!this.settled) {
			this.settled = true;
			this.deps.onCancel();
		}
		this.contentEl.empty();
	}

	private async startFlow(): Promise<void> {
		this.controller = new AbortController();
		this.state = { kind: "starting" };
		this.render();
		try {
			const progress = await this.deps.startDeviceFlow();
			if (this.controller.signal.aborted) return;
			const deadline = Date.now() + progress.deviceCode.expires_in * 1000;
			this.state = {
				kind: "polling",
				deviceCode: progress.deviceCode,
				deadline,
				statusNote: "Waiting for confirmation in your browser…",
			};
			// Best-effort auto-open of the verification URL. The Open
			// browser button below also calls window.open in case the
			// auto-open is blocked or the user dismissed the popup.
			window.open(progress.deviceCode.verification_uri_complete, "_blank");
			this.render();
			this.startExpiryTimer();

			const result = await runDevicePollLoop({
				sessionId: progress.deviceCode.session_id,
				intervalSeconds: progress.intervalSeconds,
				expiresInSeconds: progress.deviceCode.expires_in,
				signal: this.controller.signal,
				sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
				poll: (sessionId) => this.deps.poll(sessionId),
			});

			this.clearExpiryTimer();
			if (this.controller.signal.aborted) return;

			switch (result.kind) {
				case "tokens":
					this.settled = true;
					try {
						await this.deps.onSuccess(result.tokens);
					} finally {
						this.close();
					}
					return;
				case "denied":
					this.state = { kind: "denied" };
					this.render();
					return;
				case "expired":
					this.state = { kind: "expired" };
					this.render();
					return;
				case "aborted":
					return;
			}
		} catch (err) {
			if (this.controller?.signal.aborted) return;
			this.clearExpiryTimer();
			const message = err instanceof Error ? err.message : String(err);
			this.state = { kind: "error", message };
			this.render();
			this.deps.onError(err);
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Huma" is the product name
		contentEl.createEl("h2", { text: "Sign in to Huma" });

		switch (this.state.kind) {
			case "starting":
				contentEl.createEl("p", {
					cls: "huma-signin-tip",
					text: "Connecting to the server to start sign-in…",
				});
				this.renderCancelFooter(contentEl);
				return;
			case "polling":
				this.renderPolling(contentEl, this.state);
				return;
			case "denied":
				this.renderError(
					contentEl,
					"Sign-in was denied. Did you click 'Reject' by mistake? You can try again.",
				);
				return;
			case "expired":
				this.renderError(
					contentEl,
					"The sign-in code expired before you confirmed. Codes last about 10 minutes. Try again?",
				);
				return;
			case "error":
				this.renderError(
					contentEl,
					`Couldn't reach the server: ${this.state.message}. Check your internet, then try again.`,
				);
				return;
		}
	}

	private renderPolling(
		contentEl: HTMLElement,
		state: { deviceCode: DeviceAuthResponse; deadline: number; statusNote: string },
	): void {
		contentEl.createEl("p", {
			cls: "huma-signin-tip",
			text: "Confirm sign-in in your browser using the code below. This window will close automatically once you confirm.",
		});

		const codeRow = contentEl.createDiv({ cls: "huma-signin-code-row" });
		codeRow.createSpan({
			cls: "huma-signin-code",
			text: state.deviceCode.user_code,
		});

		const actions = contentEl.createDiv({ cls: "huma-signin-actions" });
		const copyBtn = actions.createEl("button", {
			text: "Copy code",
			cls: "mod-cta",
		});
		copyBtn.addEventListener("click", () => {
			void this.copyCode(state.deviceCode.user_code);
		});
		const openBtn = actions.createEl("button", { text: "Open browser" });
		openBtn.addEventListener("click", () => {
			window.open(state.deviceCode.verification_uri_complete, "_blank");
		});

		contentEl.createEl("p", {
			cls: "huma-signin-status",
			text: state.statusNote,
		});

		const expiryEl = contentEl.createEl("p", {
			cls: "huma-signin-expiry",
			text: this.formatExpiry(state.deadline),
		});
		expiryEl.dataset.deadline = String(state.deadline);

		this.renderCancelFooter(contentEl);
	}

	private renderError(contentEl: HTMLElement, message: string): void {
		contentEl.createEl("p", { cls: "huma-signin-tip", text: message });
		const footer = contentEl.createDiv({ cls: "huma-signin-footer" });
		const tryAgain = footer.createEl("button", {
			text: "Try again",
			cls: "mod-cta",
		});
		tryAgain.addEventListener("click", () => {
			void this.startFlow();
		});
		const cancel = footer.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => {
			this.settled = true;
			this.deps.onCancel();
			this.close();
		});
	}

	private renderCancelFooter(contentEl: HTMLElement): void {
		const footer = contentEl.createDiv({ cls: "huma-signin-footer" });
		const cancel = footer.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => {
			this.settled = true;
			this.deps.onCancel();
			this.close();
		});
	}

	private async copyCode(code: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(code);
			new Notice("Huma: code copied.", 2000);
		} catch {
			// Clipboard API may be blocked in some Obsidian builds.
			// Fallback: select the code element so the user can copy
			// manually with cmd+C / ctrl+C.
			const codeEl = this.contentEl.querySelector(".huma-signin-code");
			if (codeEl) {
				const range = document.createRange();
				range.selectNodeContents(codeEl);
				const sel = window.getSelection();
				sel?.removeAllRanges();
				sel?.addRange(range);
			}
			new Notice(
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Huma" is the product name; cmd+C is the macOS key chord
				"Huma: copy not available — code is selected, press cmd+C to copy.",
				4000,
			);
		}
	}

	private startExpiryTimer(): void {
		this.clearExpiryTimer();
		this.expiryTimer = window.setInterval(() => {
			if (this.state.kind !== "polling") {
				this.clearExpiryTimer();
				return;
			}
			const expiryEl = this.contentEl.querySelector(".huma-signin-expiry");
			if (!expiryEl) return;
			expiryEl.setText(this.formatExpiry(this.state.deadline));
			const remaining = this.state.deadline - Date.now();
			expiryEl.toggleClass(
				"huma-signin-expiry--low",
				remaining < 60_000,
			);
		}, 1000);
	}

	private clearExpiryTimer(): void {
		if (this.expiryTimer !== null) {
			window.clearInterval(this.expiryTimer);
			this.expiryTimer = null;
		}
	}

	private formatExpiry(deadline: number): string {
		const ms = Math.max(0, deadline - Date.now());
		const totalSeconds = Math.floor(ms / 1000);
		const m = Math.floor(totalSeconds / 60);
		const s = totalSeconds % 60;
		return `Code expires in ${m}:${s.toString().padStart(2, "0")}`;
	}
}
