import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import {
	SYNC_INTERVAL_MAX_SECONDS,
	SYNC_INTERVAL_MIN_SECONDS,
} from "../settings";
import type HumaVaultSyncPlugin from "../main";

export class HumaSettingsTab extends PluginSettingTab {
	private readonly plugin: HumaVaultSyncPlugin;

	constructor(app: App, plugin: HumaVaultSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Huma Vault Sync" });

		new Setting(containerEl)
			.setName("Server base URL")
			.setDesc(
				"Origin of the Huma dashboard, e.g. https://huma.energy. No trailing slash.",
			)
			.addText((text) =>
				text
					.setPlaceholder("https://huma.energy")
					.setValue(this.plugin.data.settings.serverBaseUrl)
					.onChange(async (value) => {
						const trimmed = value.trim().replace(/\/+$/, "");
						this.plugin.data.settings.serverBaseUrl = trimmed;
						await this.plugin.saveAll();
						this.plugin.rebuildHttpClient();
					}),
			);

		this.renderAuthSection(containerEl);
		this.renderSyncIntervalSection(containerEl);
	}

	private renderAuthSection(containerEl: HTMLElement): void {
		const tokens = this.plugin.data.tokens;
		const authSetting = new Setting(containerEl)
			.setName("Authentication")
			.setDesc(authDescription(tokens));

		if (tokens === null) {
			authSetting.addButton((btn) =>
				btn
					.setButtonText("Sign in")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						try {
							await this.plugin.signIn();
						} catch (err) {
							new Notice(
								`Huma sign-in failed: ${describeError(err)}`,
								6000,
							);
						} finally {
							btn.setDisabled(false);
							this.display();
						}
					}),
			);
		} else {
			authSetting.addButton((btn) =>
				btn.setButtonText("Sign out").onClick(async () => {
					btn.setDisabled(true);
					await this.plugin.signOut();
					btn.setDisabled(false);
					this.display();
				}),
			);
		}
	}

	private renderSyncIntervalSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Sync interval (seconds)")
			.setDesc(
				`How often the plugin polls the dashboard for changes on desktop. Mobile syncs only on foreground resume. Min ${SYNC_INTERVAL_MIN_SECONDS}, max ${SYNC_INTERVAL_MAX_SECONDS}.`,
			)
			.addSlider((slider) =>
				slider
					.setLimits(
						SYNC_INTERVAL_MIN_SECONDS,
						SYNC_INTERVAL_MAX_SECONDS,
						5,
					)
					.setValue(this.plugin.data.settings.syncIntervalSeconds)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.data.settings.syncIntervalSeconds = value;
						await this.plugin.saveAll();
					}),
			);
	}
}

function authDescription(
	tokens: { access_expires_at: number } | null,
): string {
	if (tokens === null) {
		return "Not signed in. Sign-in opens your default browser for the ZITADEL device flow; tokens are stored only in plugin data, never in the vault.";
	}
	const remainingMs = tokens.access_expires_at - Date.now();
	if (remainingMs <= 0) {
		return "Signed in. Access token expired — will refresh on next request.";
	}
	const minutes = Math.round(remainingMs / 60_000);
	return `Signed in. Access token expires in ~${minutes} minute${
		minutes === 1 ? "" : "s"
	} (refresh-token rotation handles renewal automatically).`;
}

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
