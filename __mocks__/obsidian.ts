// Minimal Obsidian API mock for Vitest. Only the surface our plugin code
// imports is implemented. Pattern follows
// addozhang/obsidian-image-upload-toolkit's Vitest mock approach.

import matter from "gray-matter";

export class TFile {
	path: string;
	basename: string;
	extension: string;
	stat: { mtime: number; ctime: number; size: number };
	constructor(path: string, content: string = "") {
		this.path = path;
		const slash = path.lastIndexOf("/");
		const dot = path.lastIndexOf(".");
		this.basename = path.slice(slash + 1, dot > slash ? dot : path.length);
		this.extension = dot > slash ? path.slice(dot + 1) : "";
		const now = Date.now();
		this.stat = { mtime: now, ctime: now, size: content.length };
	}
}

export class TFolder {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
}

export type TAbstractFile = TFile | TFolder;

export class MockVault {
	private readonly files = new Map<string, { file: TFile; content: string }>();
	private readonly folders = new Set<string>();

	addFile(path: string, content: string): TFile {
		const file = new TFile(path, content);
		this.files.set(path, { file, content });
		return file;
	}

	getMarkdownFiles(): TFile[] {
		return Array.from(this.files.values())
			.filter(({ file }) => file.extension === "md")
			.map(({ file }) => file);
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		const f = this.files.get(path);
		if (f) return f.file;
		if (this.folders.has(path)) return new TFolder(path);
		return null;
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.files.get(file.path)?.content ?? "";
	}

	async read(file: TFile): Promise<string> {
		return this.cachedRead(file);
	}

	async modify(file: TFile, content: string): Promise<void> {
		const entry = this.files.get(file.path);
		if (!entry) throw new Error(`No such file: ${file.path}`);
		entry.content = content;
		entry.file.stat.mtime = Date.now();
		entry.file.stat.size = content.length;
	}

	async process(
		file: TFile,
		fn: (data: string) => string,
	): Promise<string> {
		const entry = this.files.get(file.path);
		if (!entry) throw new Error(`No such file: ${file.path}`);
		const next = fn(entry.content);
		entry.content = next;
		entry.file.stat.mtime = Date.now();
		entry.file.stat.size = next.length;
		return next;
	}

	async create(path: string, content: string): Promise<TFile> {
		if (this.files.has(path)) throw new Error(`File exists: ${path}`);
		const file = new TFile(path, content);
		this.files.set(path, { file, content });
		return file;
	}

	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}

	async renameTFile(file: TFile, newPath: string): Promise<void> {
		const entry = this.files.get(file.path);
		if (!entry) throw new Error(`No such file: ${file.path}`);
		this.files.delete(file.path);
		file.path = newPath;
		const slash = newPath.lastIndexOf("/");
		const dot = newPath.lastIndexOf(".");
		file.basename = newPath.slice(
			slash + 1,
			dot > slash ? dot : newPath.length,
		);
		file.extension = dot > slash ? newPath.slice(dot + 1) : "";
		this.files.set(newPath, entry);
	}

	on(_event: string, _handler: unknown): { unload(): void } {
		return { unload() {} };
	}

	getFileContents(path: string): string | undefined {
		return this.files.get(path)?.content;
	}

	listFilePaths(): string[] {
		return Array.from(this.files.keys());
	}
}

export interface MockApp {
	vault: MockVault;
	fileManager: MockFileManager;
	workspace: {
		onLayoutReady(cb: () => void): void;
		on(event: string, handler: unknown): { unload(): void };
		getLeaf(_create: boolean): { openFile(_f: TFile): Promise<void> };
	};
}

// Stand-in for Obsidian's FileManager.processFrontMatter. Uses gray-matter
// (already a production dep) so the mock's parsing semantics match what
// production code expects when it later reads the same file back.
export class MockFileManager {
	private readonly vault: MockVault;
	constructor(vault: MockVault) {
		this.vault = vault;
	}
	async processFrontMatter(
		file: TFile,
		fn: (frontmatter: Record<string, unknown>) => void,
	): Promise<void> {
		const text = (await this.vault.cachedRead(file)) ?? "";
		const parsed = matter(text);
		const fm = { ...(parsed.data as Record<string, unknown>) };
		fn(fm);
		const next =
			Object.keys(fm).length === 0
				? parsed.content
				: matter.stringify(parsed.content, fm);
		await this.vault.modify(file, next);
	}
	async renameFile(file: TFile, newPath: string): Promise<void> {
		await this.vault.renameTFile(file, newPath);
	}
}

export function createMockApp(): MockApp {
	const vault = new MockVault();
	return {
		vault,
		fileManager: new MockFileManager(vault),
		workspace: {
			onLayoutReady(cb) {
				cb();
			},
			on(_event, _handler) {
				return { unload() {} };
			},
			getLeaf(_create) {
				return {
					async openFile(_f) {
						return undefined;
					},
				};
			},
		},
	};
}

export type App = MockApp;

// The classes below are imported by source modules but never *instantiated*
// in unit tests; they only need to be valid identifiers / constructable
// shells.
export class Plugin {
	app: App;
	manifest: { id: string; version: string };
	constructor(app: App, manifest: { id: string; version: string }) {
		this.app = app;
		this.manifest = manifest;
	}
	addStatusBarItem(): HTMLElement {
		return {} as HTMLElement;
	}
	addCommand(_def: unknown): void {}
	addSettingTab(_tab: unknown): void {}
	registerEvent(_e: unknown): void {}
	registerInterval(_n: number): number {
		return 0;
	}
	async loadData(): Promise<unknown> {
		return null;
	}
	async saveData(_d: unknown): Promise<void> {}
}

export class PluginSettingTab {
	app: App;
	plugin: Plugin;
	containerEl: HTMLElement;
	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = {} as HTMLElement;
	}
	display(): void {}
}

export class Setting {
	constructor(_el: HTMLElement) {}
	setName(_n: string): this {
		return this;
	}
	setDesc(_d: string): this {
		return this;
	}
	addText(_cb: unknown): this {
		return this;
	}
	addButton(_cb: unknown): this {
		return this;
	}
	addSlider(_cb: unknown): this {
		return this;
	}
}

export class Modal {
	app: App;
	contentEl: HTMLElement;
	constructor(app: App) {
		this.app = app;
		this.contentEl = {} as HTMLElement;
	}
	open(): void {}
	close(): void {}
	onOpen(): void {}
	onClose(): void {}
}

export class Notice {
	constructor(_message: string, _timeout?: number) {}
}

export interface Component {
	registerEvent(_e: unknown): void;
}

export const MarkdownRenderer = {
	async render(
		_app: App,
		_md: string,
		_el: HTMLElement,
		_path: string,
		_owner: Component,
	): Promise<void> {},
};

export const Platform = {
	isMobile: false,
	isDesktop: true,
};

export type WorkspaceLeaf = unknown;

// Mirrors Obsidian's normalizePath: collapse slashes, drop leading/trailing
// slashes, replace non-breaking spaces, NFC-normalize. Just enough behaviour
// for tests to exercise the security-relevant transformations.
export function normalizePath(input: string): string {
	let p = input.replace(/[\\/]+/g, "/");
	p = p.replace(/^\/+|\/+$/g, "");
	p = p.replace(/\u00a0/g, " ");
	if (typeof (p as unknown as { normalize?: unknown }).normalize === "function") {
		p = p.normalize("NFC");
	}
	return p;
}
