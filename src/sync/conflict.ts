import { normalizePath, type App, type TFile } from "obsidian";
import { replaceFileBody, stringifyFile, withHumaUuid } from "./frontmatter";
import { sha256Hex } from "./hash";
import type { SelfWriteTracker } from "./self-write-tracker";

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
	tracker: SelfWriteTracker,
): Promise<ConflictEmission> {
	const originalPath = normalizePath(merge.path);
	const conflictPath = conflictPathFor(originalPath);
	const conflictBody = formatConflictBody(merge.localBody, merge.serverBody);
	const [conflictHash, serverHash] = await Promise.all([
		sha256Hex(conflictBody),
		sha256Hex(merge.serverBody),
	]);

	tracker.record(conflictPath, conflictHash);
	const existingConflict = app.vault.getAbstractFileByPath(conflictPath);
	if (existingConflict && isMarkdownTFile(existingConflict)) {
		await replaceFileBody(app, existingConflict, conflictBody);
	} else if (existingConflict) {
		throw new Error(
			`Cannot write conflict file at ${conflictPath}: path exists and is not a markdown file.`,
		);
	} else {
		await app.vault.create(conflictPath, conflictBody);
	}

	const original = app.vault.getAbstractFileByPath(originalPath);
	const frontmatter = withHumaUuid(merge.serverFrontmatter ?? {}, merge.id);
	const text = stringifyFile(merge.serverBody, frontmatter);
	tracker.record(originalPath, serverHash);
	if (original && isMarkdownTFile(original)) {
		await replaceFileBody(app, original, text);
	} else if (!original) {
		await app.vault.create(originalPath, text);
	} else {
		throw new Error(
			`Cannot replace ${originalPath} with server body: path exists and is not a markdown file.`,
		);
	}

	return { conflictPath, originalPath };
}

export function conflictPathFor(originalPath: string): string {
	const safe = normalizePath(originalPath);
	const dot = safe.lastIndexOf(".");
	const base = dot > safe.lastIndexOf("/") ? safe.slice(0, dot) : safe;
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
