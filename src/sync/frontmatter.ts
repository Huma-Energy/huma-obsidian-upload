import matter from "gray-matter";

export const HUMA_UUID_KEY = "huma_uuid";

export interface ParsedFrontmatter {
	frontmatter: Record<string, unknown>;
	body: string;
}

// Splits a markdown file into its YAML frontmatter (parsed) and body. Files
// without frontmatter return `{}` and the full text. The body returned here is
// what we hash for content-equality checks — frontmatter changes (like the
// plugin writing huma_uuid back after first push) must not invalidate hashes.
export function parseFile(text: string): ParsedFrontmatter {
	const parsed = matter(text);
	return {
		frontmatter: { ...(parsed.data as Record<string, unknown>) },
		body: parsed.content,
	};
}

// Re-emits a markdown file from a parsed body + frontmatter. Used by
// frontmatter-injection (task 5) to write huma_uuid back into the on-disk
// file. If frontmatter is empty, the YAML block is omitted entirely.
export function stringifyFile(
	body: string,
	frontmatter: Record<string, unknown>,
): string {
	if (Object.keys(frontmatter).length === 0) {
		// gray-matter emits an empty `---\n---\n` block for {} which is noisy;
		// avoid the noise by returning the body verbatim.
		return body;
	}
	return matter.stringify(body, frontmatter);
}

export function readHumaUuid(
	frontmatter: Record<string, unknown>,
): string | null {
	const v = frontmatter[HUMA_UUID_KEY];
	return typeof v === "string" && v.length > 0 ? v : null;
}

// Sets huma_uuid on a frontmatter object without mutating the original.
// Returns a new object preserving every other key in original order.
export function withHumaUuid(
	frontmatter: Record<string, unknown>,
	uuid: string,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(frontmatter)) {
		if (k === HUMA_UUID_KEY) continue;
		out[k] = v;
	}
	out[HUMA_UUID_KEY] = uuid;
	return out;
}
