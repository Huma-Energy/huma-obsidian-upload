import { Plugin } from "obsidian";

export default class HumaVaultSyncPlugin extends Plugin {
	async onload(): Promise<void> {
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText("Huma plugin loaded");
	}

	onunload(): void {
		// no-op at task 1
	}
}
