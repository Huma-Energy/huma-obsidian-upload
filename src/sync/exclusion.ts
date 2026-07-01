// Folder-prefix exclusion shared by scan and reconcile. Excluded folders are
// vault-relative path prefixes; a file path is excluded when it equals an
// entry exactly or sits under one (entry + "/"). Helpers also normalize raw
// user input from the settings textarea (trim, drop empty lines, strip
// leading/trailing slashes) so storage and matching agree.

// Strip leading/trailing slashes from a vault-relative folder path; the vault
// root ("/") normalizes to "". Shared so folder-share paths and exclusion paths
// agree on the same shape that isUnderFolder / isExcludedPath match against.
export function stripFolderSlashes(path: string): string {
	return path.replace(/^\/+|\/+$/g, "");
}

export function normalizeExcludedFolders(input: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of input) {
		const trimmed = stripFolderSlashes(raw.trim());
		if (trimmed.length === 0) continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

// True when `path` is the folder itself or sits under it ("<folder>/…"). The
// single prefix primitive behind both sync exclusion and folder-share
// membership, so the two can't drift on trailing-slash / boundary semantics.
export function isPathUnderOrEqual(path: string, folder: string): boolean {
	return path === folder || path.startsWith(folder + "/");
}

export function isExcludedPath(
	path: string,
	excludedFolders: readonly string[],
): boolean {
	return excludedFolders.some((folder) => isPathUnderOrEqual(path, folder));
}
