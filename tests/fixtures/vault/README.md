# Fixture vault

Representative Obsidian markdown files used by the scanner / round-trip /
reconciliation tests. Each file exercises a distinct content shape from the
matrix in plan task 3 (wikilinks, embeds, callouts, block-id anchors,
frontmatter, GFM tables, fenced code, mermaid, KaTeX).

The hash invariant under test: hashing the post-frontmatter body before and
after a no-op gray-matter round-trip must produce the same digest. Adding,
updating, or reading `huma_uuid` in frontmatter must NOT change the body
hash for any file in this directory.

Fixtures are duplicated via the test helper at `tests/sync/scan.test.ts`
to reach the perf-target file count without committing redundant content
to git.
