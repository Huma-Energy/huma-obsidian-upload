import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import {
	SYNC_INTERVAL_MAX_SECONDS,
	SYNC_INTERVAL_MIN_SECONDS,
} from "../settings";
import { normalizeExcludedFolders } from "../sync/exclusion";
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

		new Setting(containerEl)
			.setName("Server base URL")
			.setDesc(
				"Origin of the Huma dashboard, e.g. https://huma.energy. No trailing slash.",
			)
			.addText((text) =>
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case -- URL placeholder, not UI prose
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
		this.renderExclusionsSection(containerEl);
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

	private renderExclusionsSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc(
				"One vault-relative folder path per line. Files inside these folders will not sync. Existing copies on the server are not deleted when a folder is added here — archive them on the dashboard if you want them removed.",
			)
			.addTextArea((area) => {
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- folder-path examples, not UI prose
				area.setPlaceholder("drafts\nbusiness/private");
				area.setValue(
					this.plugin.data.settings.excludedFolders.join("\n"),
				);
				// Save the raw text on every keystroke (so partial edits
				// persist if the user navigates away mid-edit), but only
				// commit the *normalized* list and surface a Notice when the
				// user finishes editing — i.e. on blur. Notice-per-keystroke
				// is noise.
				let focusSnapshot = this.plugin.data.settings.excludedFolders;
				area.inputEl.addEventListener("focus", () => {
					focusSnapshot = this.plugin.data.settings.excludedFolders;
				});
				area.onChange(async (value) => {
					this.plugin.data.settings.excludedFolders =
						normalizeExcludedFolders(value.split("\n"));
					await this.plugin.saveAll();
				});
				area.inputEl.addEventListener("blur", () => {
					const next = this.plugin.data.settings.excludedFolders;
					const added = next.filter((f) => !focusSnapshot.includes(f));
					if (added.length > 0) {
						new Notice(
							`Huma: ${added.length} folder(s) excluded from sync. Files already on the server remain — archive them on the dashboard to remove.`,
							8000,
						);
					}
				});
				area.inputEl.rows = 4;
				area.inputEl.addClass("huma-excluded-folders");
			});
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
