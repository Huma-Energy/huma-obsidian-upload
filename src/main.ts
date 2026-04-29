import { Notice, Plugin } from "obsidian";
import {
	DEFAULT_PLUGIN_DATA,
	type HumaPluginData,
} from "./settings";
import { FetchHttpClient } from "./client/http";
import {
	AuthClient,
	runDevicePollLoop,
	type DevicePollOutcome,
} from "./client/auth";
import { HumaSettingsTab } from "./ui/settings-tab";
import { scanVaultForTokens } from "./security/vault-token-scan";

const PLUGIN_USER_AGENT = "Huma Obsidian Plugin v0.1.0";
const REVOKE_PATH = "/api/vault/auth/revoke"; // provisional; ignored on failure.

export default class HumaVaultSyncPlugin extends Plugin {
	data: HumaPluginData = structuredClone(DEFAULT_PLUGIN_DATA);
	private http: FetchHttpClient | null = null;
	private auth: AuthClient | null = null;
	private statusBarEl: HTMLElement | null = null;
	private startupBlocked = false;

	async onload(): Promise<void> {
		await this.loadAll();
		this.rebuildHttpClient();
		this.statusBarEl = this.addStatusBarItem();
		this.addSettingTab(new HumaSettingsTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			void this.runStartupInvariant();
		});

		this.renderStatusBar();
	}

	onunload(): void {
		// Nothing async to await here; Obsidian disposes plugin instances.
	}

	async loadAll(): Promise<void> {
		const stored = (await this.loadData()) as Partial<HumaPluginData> | null;
		this.data = mergeData(stored);
	}

	async saveAll(): Promise<void> {
		await this.saveData(this.data);
	}

	rebuildHttpClient(): void {
		this.http = new FetchHttpClient(this.data.settings.serverBaseUrl);
		this.auth = new AuthClient(this.http, PLUGIN_USER_AGENT);
	}

	private renderStatusBar(): void {
		if (!this.statusBarEl) return;
		if (this.startupBlocked) {
			this.statusBarEl.setText("Huma: blocked (token in vault)");
			return;
		}
		if (this.data.tokens === null) {
			this.statusBarEl.setText("Huma: signed out");
			return;
		}
		this.statusBarEl.setText("Huma: idle");
	}

	private async runStartupInvariant(): Promise<void> {
		const tokens = this.data.tokens;
		const known = tokens
			? [tokens.access_token, tokens.refresh_token]
			: [];
		const result = await scanVaultForTokens(this.app, known);
		if (result.blocking.length > 0) {
			this.startupBlocked = true;
			const paths = result.blocking.map((h) => h.path).join(", ");
			new Notice(
				`Huma Vault Sync refused to start: a stored auth token was found in the vault (${paths}). ` +
					`Remove it before re-enabling sync. Tokens must never live under the vault root.`,
				0,
			);
			this.renderStatusBar();
			return;
		}
		if (result.suspicious.length > 0) {
			const paths = result.suspicious
				.slice(0, 3)
				.map((h) => h.path)
				.join(", ");
			new Notice(
				`Huma Vault Sync warning: ${result.suspicious.length} file(s) contain token-shaped strings (${paths}${
					result.suspicious.length > 3 ? ", …" : ""
				}). ` +
					`If these are not your tokens, you can ignore this notice.`,
				8000,
			);
		}
		this.renderStatusBar();
	}

	async signIn(): Promise<void> {
		if (this.startupBlocked) {
			throw new Error(
				"Sign-in blocked because a token-shaped string was found in the vault.",
			);
		}
		if (!this.auth) throw new Error("Auth client not initialised.");

		const progress = await this.auth.startDeviceFlow();
		const { deviceCode, intervalSeconds } = progress;

		// Open verification URL in default browser. window.open is supported on
		// every Obsidian platform (desktop electron + iOS/Android webview).
		window.open(deviceCode.verification_uri_complete, "_blank");

		new Notice(
			`Huma sign-in: enter code ${deviceCode.user_code} in your browser. ` +
				`This Obsidian window will sign you in automatically when you confirm.`,
			Math.min(deviceCode.expires_in, 600) * 1000,
		);

		const result = await runDevicePollLoop({
			sessionId: deviceCode.session_id,
			intervalSeconds,
			expiresInSeconds: deviceCode.expires_in,
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			poll: (sessionId): Promise<DevicePollOutcome> => {
				if (!this.auth) throw new Error("Auth client gone.");
				return this.auth.pollDeviceToken(sessionId);
			},
		});

		switch (result.kind) {
			case "tokens":
				this.data.tokens = result.tokens;
				await this.saveAll();
				new Notice("Huma: signed in.", 3000);
				this.renderStatusBar();
				return;
			case "denied":
				throw new Error("Sign-in denied at the verification page.");
			case "expired":
				throw new Error(
					"Sign-in code expired before confirmation. Try again.",
				);
			case "aborted":
				throw new Error("Sign-in aborted.");
		}
	}

	async signOut(): Promise<void> {
		const tokens = this.data.tokens;
		this.data.tokens = null;
		await this.saveAll();
		this.renderStatusBar();
		if (tokens && this.http) {
			// Best-effort revocation; never block sign-out on a server failure.
			try {
				await this.http.request({
					method: "POST",
					path: REVOKE_PATH,
					body: { refresh_token: tokens.refresh_token },
				});
			} catch {
				// ignore — local state is already cleared
			}
		}
		new Notice("Huma: signed out.", 3000);
	}
}

function mergeData(stored: Partial<HumaPluginData> | null): HumaPluginData {
	const base = structuredClone(DEFAULT_PLUGIN_DATA);
	if (!stored) return base;
	return {
		settings: { ...base.settings, ...(stored.settings ?? {}) },
		tokens: stored.tokens ?? null,
		manifest: stored.manifest ?? base.manifest,
		auditRing: stored.auditRing ?? base.auditRing,
	};
}
