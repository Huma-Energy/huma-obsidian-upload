// Opt-in, per-item OKF (Open Knowledge Format) lint for vault files. OKF wants
// each concept file to carry a `type`; this flags a missing one and offers a
// reversible add (a single frontmatter key — never a bulk rewrite). It also
// flags `index.md`, which OKF reserves as a per-folder index: an existing
// index.md with its own frontmatter may collide on export. Pure: no Obsidian
// APIs, no filesystem, no wikilink conversion — just frontmatter analysis.

export const OKF_TYPE_KEY = "type";
export const OKF_DEFAULT_TYPE = "note";

export interface OkfLintResult {
	// Frontmatter has no usable `type` string.
	needsType: boolean;
	suggestedType: string;
	// Basename is index.md (case-insensitive) — OKF-reserved.
	isReservedIndex: boolean;
	// Reserved index.md that already carries author frontmatter (export will
	// generate index.md frontmatter and may clash).
	indexCollision: boolean;
	// Human-readable findings for the surface.
	notes: string[];
}

export function lintForOkf(opts: {
	path: string;
	frontmatter: Record<string, unknown>;
}): OkfLintResult {
	const { path, frontmatter } = opts;
	const typeVal = frontmatter[OKF_TYPE_KEY];
	const needsType = !(typeof typeVal === "string" && typeVal.trim().length > 0);

	const base = (path.split("/").pop() ?? path).toLowerCase();
	const isReservedIndex = base === "index.md";
	const indexCollision =
		isReservedIndex && Object.keys(frontmatter).length > 0;

	const notes: string[] = [];
	if (needsType) {
		notes.push(`Missing OKF \`type\`; suggested: \`${OKF_DEFAULT_TYPE}\`.`);
	}
	if (indexCollision) {
		notes.push(
			"`index.md` is OKF-reserved as a folder index; review its frontmatter before exporting.",
		);
	}

	return {
		needsType,
		suggestedType: OKF_DEFAULT_TYPE,
		isReservedIndex,
		indexCollision,
		notes,
	};
}

// Adds the OKF `type` key without mutating the original or clobbering an
// existing non-empty value. Returns a new object so the change is a single,
// reversible frontmatter edit the caller writes back.
export function withOkfType(
	frontmatter: Record<string, unknown>,
	type: string,
): Record<string, unknown> {
	const existing = frontmatter[OKF_TYPE_KEY];
	if (typeof existing === "string" && existing.trim().length > 0) {
		return { ...frontmatter };
	}
	return { ...frontmatter, [OKF_TYPE_KEY]: type };
}
