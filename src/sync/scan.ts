import type { App, TFile } from "obsidian";
import { parseFile, readHumaUuid } from "./frontmatter";
import { sha256Hex } from "./hash";
import { CONFLICT_SUFFIX } from "./conflict";

export interface ScannedFile {
	uuid: string | null;
	path: string;
	hash: string;
	body: string;
	frontmatter: Record<string, unknown>;
	mtime: number;
}

export interface VaultLike {
	getMarkdownFiles(): TFile[];
	cachedRead(file: TFile): Promise<string>;
}

// Walks every markdown file in the vault, parses frontmatter, hashes the
// body (post-frontmatter strip) with SHA-256, and emits a ScannedFile per
// file. Files with no huma_uuid in frontmatter are emitted with uuid: null
// — task 4's reconciliation engine flags those for first-push.
export async function scanVault(app: App): Promise<ScannedFile[]>;
export async function scanVault(vault: VaultLike): Promise<ScannedFile[]>;
export async function scanVault(
	source: App | VaultLike,
): Promise<ScannedFile[]> {
	const vault: VaultLike = "vault" in source ? source.vault : source;
	const files = vault
		.getMarkdownFiles()
		.filter((f) => !f.path.endsWith(CONFLICT_SUFFIX));
	const out: ScannedFile[] = [];
	for (const file of files) {
		const text = await vault.cachedRead(file);
		const { frontmatter, body } = parseFile(text);
		const hash = await sha256Hex(body);
		out.push({
			uuid: readHumaUuid(frontmatter),
			path: file.path,
			hash,
			body,
			frontmatter,
			mtime: file.stat?.mtime ?? 0,
		});
	}
	return out;
}
