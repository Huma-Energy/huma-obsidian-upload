# Huma Vault Sync

Bidirectional sync plugin between an Obsidian vault and the Huma dashboard at humagreenfield.netlify.app. Pre-release v0.1.

## Core value

Users edit notes in Obsidian or via the Huma web dashboard and changes flow both ways automatically. Local edits push as deltas; server changes pull as deltas; conflicts emit `.conflict.md` siblings with git-style markers; identity is tracked via `huma_uuid` frontmatter so renames preserve linkage.

## Architecture

State-based reconciliation over three views (server manifest with delta cursor, local manifest cache, vault scan), with UUID identity in frontmatter. Cold-start full fetch + periodic re-baseline (RFC 6578 / MS Graph delta pattern) recovers from stale `lastSince`. Push-side three-way merge runs server-side; client emits conflict files when the server returns `merge_dirty`.

## Constraints

- Obsidian plugin guidelines (e.g. `requestUrl` not `fetch`; status bar desktop-only).
- npm only; TypeScript strict; esbuild → single `main.js`.
- Never commit secrets; tokens live only in plugin data, never in vault files.
- Manifest hashes use parsed-back body (`sha256(parseFile(stringifyFile(body, fm)).body)`), never raw body.

## Key Decisions

See ADR-style notes in `CHANGELOG.md` `[Unreleased]` and inline reasoning in `docs/CONFLICT-MATRIX.md`.

## Status

Pre-release v0.1. 92 tests passing on branch `claude/huma-obsidian-plugin-WQu5o`. Codebase mapped 2026-05-01.
