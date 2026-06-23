// Detects Huma web-authored annotations (comments + mentions) inside a pulled
// markdown body, so the plugin can surface an advisory: these are authored on
// the web, are read-only in Obsidian for v1, and editing a commented passage
// may re-anchor or orphan its comment. Pure string analysis that mirrors the
// server's annotation-codec output — no Obsidian APIs, fully unit-testable.

// A `# Comments` footnote definition the server emits: `[^c-<hex>]: …` at line
// start. Counting definitions (not inline refs) yields the thread count even
// when a run could not be located inline (the codec still lists it).
const COMMENT_DEF_RE = /^\[\^c-[0-9a-fA-F]+\]:/gm;
// Mention links round-trip as `[@Name](huma://user/<sub>)`; match the scheme.
const MENTION_LINK_RE = /\]\(huma:\/\/user\/[^)\s]+\)/g;

export interface HumaAnnotations {
	hasComments: boolean;
	commentCount: number;
	hasMentions: boolean;
	mentionCount: number;
	hasAny: boolean;
}

export function detectHumaAnnotations(body: string): HumaAnnotations {
	const commentCount = (body.match(COMMENT_DEF_RE) ?? []).length;
	const mentionCount = (body.match(MENTION_LINK_RE) ?? []).length;
	return {
		hasComments: commentCount > 0,
		commentCount,
		hasMentions: mentionCount > 0,
		mentionCount,
		hasAny: commentCount > 0 || mentionCount > 0,
	};
}

// One-line advisory for the surface (status hint / Notice). Empty when nothing
// is present so callers can skip showing anything.
export function annotationSummary(a: HumaAnnotations): string {
	if (!a.hasAny) return "";
	const parts: string[] = [];
	if (a.hasComments) {
		parts.push(`${a.commentCount} web comment${a.commentCount === 1 ? "" : "s"}`);
	}
	if (a.hasMentions) {
		parts.push(`${a.mentionCount} mention${a.mentionCount === 1 ? "" : "s"}`);
	}
	return (
		`This note carries ${parts.join(" and ")} authored on the web ` +
		`(read-only here). Editing a commented passage may re-anchor or orphan ` +
		`its comment.`
	);
}
