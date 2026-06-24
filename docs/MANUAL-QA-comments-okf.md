# Manual QA — comments round-trip, anchor behavior, plugin commands, OKF export

Everything below is the part automated tests can't cover: real Obsidian
rendering, interactive commands, and the live web↔vault round-trip. Unit +
integration suites already cover the pure logic (detector, OKF lint, codec,
re-anchor, suppression, atomic versioning, no-split-brain).

---

## Setup (localhost) — run exactly this

A full-stack E2E: the web app + collab + DB on localhost, with the plugin
pointed at it. `humatopia-frontend/.env.local` already has `DATABASE_URL`,
`ZITADEL_*`, and `SESSION_COOKIE_SECRET`, so no new config is needed.

> **DB note:** run the app against your normal dev `DATABASE_URL` (already in
> `.env.local`). Do **not** use `DATABASE_URL_TEST` here — the integration
> suite TRUNCATEs that branch. The "disposable branch / never dev-main" rule
> applies to the automated suite, not this manual run.

### 1. Server (web app + collab) — terminal 1
```
cd /Users/steffen/Projects/huma/humatopia-frontend
bun install                 # first time only
bun run dev                 # vite on :3000 — serves the app AND the /hocuspocus WS in-process
```
Open http://localhost:3000 and sign in (ZITADEL dev instance). If the dev DB is
missing recent schema, run `bun run db:migrate` first (needs `DATABASE_URL_DIRECT`,
the unpooled Neon URL — add it to `.env.local` if absent).

### 2. Create test content (web editor at localhost:3000)
1. Create a new document.
2. Type two **blank-line-separated** paragraphs, e.g. `Alpha line.` then `Beta line.`
3. Select **Beta line.** → add an inline comment (e.g. "is this current?").
4. Elsewhere type `@` → pick a user (a self-mention is fine) = the mention.
   The doc auto-reflects into `vault_files` on save.

### 3. Plugin (feature branch) — terminal 2
```
cd /Users/steffen/Projects/huma/huma-obsidian-upload
git checkout feat/comment-badge-okf-lint
npm install                 # first time only
npm run build               # produces main.js at the repo root
```
Load into a **throwaway** Obsidian vault (not your real notes):
```
ln -s /Users/steffen/Projects/huma/huma-obsidian-upload \
  "<TEST_VAULT>/.obsidian/plugins/huma-vault-sync"
```
(or copy `main.js` + `manifest.json` + `styles.css` into that folder.) BRAT
won't work — the branch isn't released.

### 4. Point the plugin at localhost + sign in
1. Obsidian → Settings → Community plugins → enable **Huma Vault Sync**.
2. Settings → Huma Vault Sync → **Server URL** = `http://localhost:3000`
   (default is `https://humatopia.ai` — you must change it; localhost is exempt
   from the plugin's HTTPS requirement).
3. Command palette → **Huma Vault Sync: Sign in** → open the verification link
   (points at localhost:3000, where you're already signed in) → approve.
4. **Huma Vault Sync: Sync now** → pulls the doc you created (comment footnotes +
   mention included).

### 5. OKF export (for section C) — grab a session cookie
Browser DevTools on localhost:3000 → Application → Cookies → copy `huma_session`.
```
curl -s -H "Cookie: huma_session=<value>" http://localhost:3000/api/okf/export \
  | jq '.stats, (.files | keys)'
# inspect one file:  … | jq -r '.files["<folder/file.md>"]'
```
Returns JSON `{ stats, files: { "<path>": "<markdown>" } }`.

Now work through sections A–D below.

---

## A. Plugin commands (`huma-obsidian-upload`, branch `feat/comment-badge-okf-lint`)

Build the branch into the test vault first (`npm run build`, copy `main.js` +
`manifest.json` + `styles.css`, or BRAT the branch).

- [ ] **Palette discovery** — both commands appear: "Huma Vault Sync: Show web annotations in this note" and "Huma Vault Sync: Check this note for OKF fields".
- [ ] **Commands gate on an active markdown file** — with no note open (or a non-`.md` pane focused) both commands are absent/disabled.

### A1. Show web annotations
- [ ] Open a **pulled note that has a comment** (a `# Comments` section with `[^c-…]:` defs). Run the command → Notice reads e.g. *"This note carries 1 web comment authored on the web (read-only here). Editing a commented passage may re-anchor or orphan its comment."* with the correct count.
- [ ] Open a note with **a `huma://user/` mention link** → Notice reports the mention count.
- [ ] Open a note with **both** → Notice lists "N web comment(s) and M mention(s)".
- [ ] Open a **plain note** (no annotations) → Notice: *"no web comments or mentions in this note."*
- [ ] Open a note whose body contains **your own `# Comments` heading but no `[^c-…]:` defs** → reported as having **no** annotations (no false positive).
- [ ] The command **does not modify the file** (mtime/content unchanged after running).

### A2. Check this note for OKF fields
- [ ] On a note **missing `type` frontmatter** → Notice: *"added `type: note` …"*, and the file's YAML frontmatter now has `type: note`.
- [ ] **Reversibility** — Cmd/Ctrl-Z (or manually editing the key) cleanly removes it; running again re-adds it.
- [ ] On a note **already having `type:`** → Notice: *"already satisfies the OKF checks"*, frontmatter unchanged (existing value not clobbered).
- [ ] On an **`index.md` that has frontmatter** → Notice flags the index.md collision (review before export).
- [ ] **No bulk rewrite** — only the active note changes; sibling notes untouched.
- [ ] **No sync churn** — after adding `type`, a sync cycle does **not** push the note as a content change (the plugin hashes the body, not frontmatter). Confirm no spurious `push`/conflict in the sync log.

---

## B. Comments + mentions round-trip in Obsidian (server `humatopia-frontend` ↔ plugin)

### B1. Visible + clickable
- [ ] Pull a commented doc. In **Reading view**, the `[^c-…]` footnote refs render as clickable footnotes and the `# Comments` section lists author / ISO timestamp / body / resolved state.
- [ ] Mentions render as links (`[@Name](huma://user/…)`).
- [ ] **Live Preview** edit mode shows the footnote markers without corrupting them.

### B2. Re-anchor (comment survives an Obsidian edit to a different run)
- [ ] In Obsidian, edit a **different** paragraph than the commented one; save; let it push.
- [ ] On the web, the comment is **still anchored to its original quoted run**, its body intact, and the doc shows the Obsidian edit.
- [ ] Web vault badge / sync state shows no error; no duplicate comment.

### B3. Orphan (commented run deleted from Obsidian)
- [ ] In Obsidian, **delete the exact commented passage**; push.
- [ ] On the web, the comment is **orphaned** ("Original content deleted"), **not lost** — body still readable, recoverable.

### B4. Anchor refresh (web edit moves the anchored text)
- [ ] On the **web**, edit prose immediately **before** a commented run (shifting its context) and let it autosave.
- [ ] Re-pull in Obsidian (or push an unrelated edit) → the comment still re-anchors by **exact context** (no drift, no spurious `merge_dirty`). (Server-side this is the `refreshCommentAnchors` pass; observable as continued clean re-anchoring rather than fuzzy fallback.)

### B5. Concurrent-edit merge classification
- [ ] Web edits paragraph A; Obsidian (stale base) edits paragraph C; push → **merge_clean** (both kept).
- [ ] Web and Obsidian edit the **same** line → **merge_dirty** → plugin writes a `.conflict.md`; resolving it works. (Expected, not data loss.)

---

## C. OKF export (server `humatopia-frontend`)

- [ ] `GET /api/okf/export` returns a bundle (folder-tree of `.md`).
- [ ] Every non-reserved `.md` has **parseable YAML frontmatter** with a **non-empty `type`**.
- [ ] Frontmatter carries provenance (`created`/`created_by`/`modified`/`modified_by`, version) and `huma_uuid`.
- [ ] Each folder has an `index.md`; `log.md` is generated from version + audit + comment history.
- [ ] `[[wikilinks]]` are converted to OKF `/path.md` links **in the export only** (the vault stays wikilink-native — confirm the vault files are unchanged).
- [ ] The `# Comments` section is present and OKF-conventional (mirrors `# Citations`).

---

## D. markdown-roundtrip harness (optional, plan's manual step)

- [ ] Run the harness at `/Users/steffen/Projects/huma/markdown-roundtrip/` extended with comment/mention fixtures; confirm bodies round-trip without corruption of footnotes/mentions.

---

## Notes / known v1 limitations to confirm, not file as bugs
- Comments are **read-only in Obsidian** for v1 (authored/resolved on the web).
- **Multi-column blocks flatten** only if you edit inside them; untouched columns survive.
- The P3 surface is a **command-driven advisory**, not an always-on in-editor badge (a passive CM6 badge is future work).
