import type { App, TFile } from "obsidian";
import { stringifyFile, withHumaUuid } from "./frontmatter";

export const CONFLICT_SUFFIX = ".conflict.md";

export interface ConflictEmission {
	conflictPath: string;
	originalPath: string;
}

export interface DirtyMerge {
	id: string;
	path: string;
	localBody: string;
	serverBody: string;
	serverFrontmatter: Record<string, unknown> | null;
}

// Writes a sibling <basename>.conflict.md file containing both bodies between
// git-style markers, then replaces the original file with the server's body
// so on-disk state matches the server until the user reconciles.
//
// The plan is explicit about marker format ("<<<<<<< local", "=======",
// ">>>>>>> server") and Obsidian-friendly placement: same folder, same
// basename + ".conflict.md" suffix, so file explorer surfaces them adjacent.
export async function emitConflict(
	app: App,
	merge: DirtyMerge,
): Promise<ConflictEmission> {
	const conflictPath = conflictPathFor(merge.path);
	const conflictBody = formatConflictBody(merge.localBody, merge.serverBody);

	const existingConflict = app.vault.getAbstractFileByPath(conflictPath);
	if (existingConflict && isMarkdownTFile(existingConflict)) {
		await app.vault.modify(existingConflict, conflictBody);
	} else if (existingConflict) {
		throw new Error(
			`Cannot write conflict file at ${conflictPath}: path exists and is not a markdown file.`,
		);
	} else {
		await app.vault.create(conflictPath, conflictBody);
	}

	const original = app.vault.getAbstractFileByPath(merge.path);
	const frontmatter = withHumaUuid(
		merge.serverFrontmatter ?? {},
		merge.id,
	);
	const text = stringifyFile(merge.serverBody, frontmatter);
	if (original && isMarkdownTFile(original)) {
		await app.vault.modify(original, text);
	} else if (!original) {
		await app.vault.create(merge.path, text);
	} else {
		throw new Error(
			`Cannot replace ${merge.path} with server body: path exists and is not a markdown file.`,
		);
	}

	return { conflictPath, originalPath: merge.path };
}

export function conflictPathFor(originalPath: string): string {
	const dot = originalPath.lastIndexOf(".");
	const base =
		dot > originalPath.lastIndexOf("/") ? originalPath.slice(0, dot) : originalPath;
	return `${base}${CONFLICT_SUFFIX}`;
}

export function formatConflictBody(local: string, server: string): string {
	return [
		"<<<<<<< local",
		local.replace(/\n+$/, ""),
		"=======",
		server.replace(/\n+$/, ""),
		">>>>>>> server",
		"",
	].join("\n");
}

function isMarkdownTFile(file: unknown): file is TFile {
	return (
		typeof file === "object" &&
		file !== null &&
		"extension" in (file as { extension?: unknown }) &&
		(file as { extension?: unknown }).extension === "md"
	);
}

// Lists every *.conflict.md file in the vault. Used by the "Resolve Huma
// conflict" command palette entry to walk the user through outstanding
// conflicts sequentially.
export function listConflictFiles(app: App): TFile[] {
	const all = app.vault.getMarkdownFiles();
	return all.filter((f) => f.path.endsWith(CONFLICT_SUFFIX));
}
