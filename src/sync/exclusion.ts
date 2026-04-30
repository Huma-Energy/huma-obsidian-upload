// Folder-prefix exclusion shared by scan and reconcile. Excluded folders are
// vault-relative path prefixes; a file path is excluded when it equals an
// entry exactly or sits under one (entry + "/"). Helpers also normalize raw
// user input from the settings textarea (trim, drop empty lines, strip
// leading/trailing slashes) so storage and matching agree.

export function normalizeExcludedFolders(input: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of input) {
		const trimmed = raw.trim().replace(/^\/+|\/+$/g, "");
		if (trimmed.length === 0) continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

export function isExcludedPath(
	path: string,
	excludedFolders: readonly string[],
): boolean {
	for (const folder of excludedFolders) {
		if (path === folder) return true;
		if (path.startsWith(folder + "/")) return true;
	}
	return false;
}
