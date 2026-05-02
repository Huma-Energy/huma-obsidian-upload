# Testing Patterns

**Analysis Date:** 2026-05-01

## Test Framework

**Runner:** Vitest 2.1.8 (`package.json` devDependency)
- Config: `vitest.config.ts`
- Environment: `node` (`vitest.config.ts:6`)
- Globals: `false` — `describe`/`it`/`expect` are imported explicitly per file. `vitest/globals` is in `tsconfig.json` `types` so the type symbols are available; the runtime values are not auto-injected.
- Test file pattern: `tests/**/*.test.ts` (`vitest.config.ts:8`)

**Assertion library:** Vitest's built-in `expect` (Chai-compatible matchers). No additional matcher packages.

**Run commands (`package.json` scripts):**
```bash
npm test            # Single run: vitest run
npm run test:watch  # Watch mode: vitest
npm run lint        # ESLint flat config: eslint .
npm run build       # tsc -noEmit -skipLibCheck && esbuild production
```

**Current baseline:** 14 test files, 92 tests, all passing. Total runtime ~730 ms (transform 586 ms, tests 185 ms). Verified at the timestamp of this analysis.

## Obsidian Mock

**Location:** `__mocks__/obsidian.ts` (291 lines).

**Resolution mechanism:** The mock is wired in via `vitest.config.ts` `resolve.alias`:

```ts
resolve: {
    alias: {
        obsidian: resolve(__dirname, "__mocks__/obsidian.ts"),
    },
},
```

Any production module that does `import { ... } from "obsidian"` resolves to this file in tests. There is no per-test `vi.mock("obsidian", ...)` setup — the alias does the work statically. `__mocks__/` is in the ESLint global ignore list (`eslint.config.mts:49`).

**Mock surface (only what production code touches):**

| Export | Purpose | Notes |
|--------|---------|-------|
| `TFile` | Path/basename/extension/stat shell | `__mocks__/obsidian.ts:7-21` |
| `TFolder`, `TAbstractFile` | Folder + union | `__mocks__/obsidian.ts:23-30` |
| `MockVault` | In-memory `Map<path, {file, content}>` | Implements `getMarkdownFiles`, `cachedRead`, `read`, `modify`, `process`, `create`, `createFolder`, `renameTFile`, `getAbstractFileByPath`, `on`, plus test helpers `addFile`, `getFileContents`, `listFilePaths` |
| `MockFileManager` | `processFrontMatter` via `gray-matter`, `renameFile` | `__mocks__/obsidian.ts:136-158` — uses the same `gray-matter` dep production uses, so parse/emit semantics match |
| `createMockApp()` | Returns `{ vault, fileManager, workspace }` shaped like Obsidian's `App` | `__mocks__/obsidian.ts:160-181` |
| `Plugin`, `PluginSettingTab`, `Setting`, `Modal`, `Notice` | Constructable shells | Imported by source modules but never instantiated in unit tests; identifiers exist so tsc passes |
| `MarkdownRenderer.render` | No-op `Promise<void>` | `__mocks__/obsidian.ts:262-270` |
| `Platform` | `{ isMobile: false, isDesktop: true }` | Tests can override per-suite if mobile branches matter |
| `normalizePath` | Collapses slashes, strips lead/trail `/`, ` ` → space, NFC | `__mocks__/obsidian.ts:282-290` — just enough behaviour to exercise traversal-defence tests |
| `requestUrl` | Not exported in the mock | Tests that need HTTP stub the `VaultApiClient` / `HttpClient` interface directly, not `requestUrl` |

**Mock semantics that matter:**
- `MockVault.process(file, fn)` mirrors `Vault.process` — applies `fn` to current content and writes the result atomically (`__mocks__/obsidian.ts:71-82`). Tests for `replaceFileBody` and the pull worker depend on this.
- `MockFileManager.processFrontMatter` uses `gray-matter` to parse, applies the user's mutator, and re-stringifies through `matter.stringify` — same library as production. This is what makes the parsed-back-body hash invariant testable end-to-end (see "Hash-Stability Tests" below).
- `MockVault.modify` is exposed but production code is not allowed to call it directly. The build-time invariant in `tests/security/no-token-vault-write.test.ts` greps for `vault.modify` adjacency to token references.

## Test File Organization

**Location:** Separate `tests/` tree mirroring `src/` layout. Tests are *not* co-located.

```
tests/
├── audit/
│   └── ring.test.ts
├── client/
│   └── auth.test.ts
├── fixtures/
│   └── vault/                       # 16 fixture markdown files (eslint-ignored)
│       ├── 01-plain-prose.md … 15-long-prose.md
│       ├── 13-nested/nested-note.md
│       └── README.md
├── main-error-classifier.test.ts    # top-level: tests src/main.ts re-export
├── security/
│   ├── no-token-vault-write.test.ts # build-time grep invariant
│   ├── token-shape.test.ts
│   └── vault-token-scan.test.ts
└── sync/
    ├── conflict.test.ts
    ├── exclusion.test.ts
    ├── frontmatter.test.ts
    ├── manifest-fetch-policy.test.ts
    ├── pull-worker.test.ts
    ├── reconcile.test.ts
    ├── scan.test.ts
    └── self-write-tracker.test.ts
```

**Test files:** 14. **Tests:** 92. **Fixtures:** `tests/fixtures/vault/` (excluded from the ESLint scan; loaded via `node:fs` in `tests/sync/scan.test.ts`).

**Naming:**
- One test file per source module. `tests/sync/X.test.ts` ↔ `src/sync/X.ts`.
- `tests/main-error-classifier.test.ts` is the exception — it lives at the top level rather than `tests/main.test.ts` because it targets a single classifier function re-exported from `src/main.ts`.

## Test Structure

**Suite organization (canonical pattern from `tests/sync/reconcile.test.ts`):**

```typescript
import { describe, expect, it } from "vitest";
import { reconcile } from "../../src/sync/reconcile";
import type { ManifestEntry } from "../../src/types";

// Local builders that take Partial<T> and fill defaults.
function serverEntry(p: Partial<ManifestEntry>): ManifestEntry {
    return {
        id: "id-1",
        path: "a.md",
        version: 1,
        hash: "h-server",
        deleted_at: null,
        ...p,
    };
}

describe("reconcile", () => {
    it("emits a pull when the server has a newer version and locally unchanged", () => {
        const out = reconcile({
            serverManifest: [serverEntry({ version: 2 })],
            localManifest: [localRecord({ version: 1 })],
            scanned: [scanned({})],
        });
        expect(out.actions.map((a) => a.kind)).toEqual(["pull"]);
        expect(out.stats).toMatchObject({ pull: 1, push: 0, conflict: 0 });
    });
});
```

**Patterns:**
- Imports: `describe, expect, it` (sometimes `vi`, `beforeEach`, `afterEach`) from `"vitest"`, then source under test, then types
- One `describe` per public surface; test name reads as a sentence ("emits a pull when ...", "drops a not_found id from the manifest and pulls the survivors")
- Inline builder helpers (`serverEntry`, `localRecord`, `scanned`, `pullFile`, `manifestRow`, `entry`) take `Partial<T>` and spread defaults — this is the standard. New tests should add their own builder if no existing one fits, not introduce a shared factory module.
- Comments inside `it` bodies document *regression context* and live-repro narrative — see `tests/sync/reconcile.test.ts:231-237` ("Live repro: AnotherTest.md was created+pushed...")
- Test files that need lifecycle use `beforeEach(() => { ... })` and `afterEach(() => { tracker.pruneExpired(); })` — see `tests/sync/pull-worker.test.ts:53-60`
- Tests that need timing control inject deterministic clock arguments (`SelfWriteTracker.record(path, hash, now?)`, `tracker.consume(path, hash, now?)`) — see `tests/sync/self-write-tracker.test.ts:34-40`

## Mocking

**Vitest `vi.fn` and `vi.mock`:**
- Used sparingly. The Obsidian mock is alias-based and global; per-test mocks are limited to dependency injection.
- Example: `tests/client/auth.test.ts:60-71` injects `poll: vi.fn(async () => ({ kind: "tokens", tokens }))` to `runDevicePollLoop`.

**Dependency injection over module mocking.** The pull worker is tested against a hand-rolled stub:

```typescript
const api = {
    pull: async (ids: string[]): Promise<PullResponse> => { ... },
} as unknown as VaultApiClient;
```

(`tests/sync/pull-worker.test.ts:64-74`). The worker accepts the client as a parameter, so tests pass a stub directly rather than mocking `VaultApiClient` globally.

**What to mock:**
- HTTP boundaries (`VaultApiClient.pull`, `runDevicePollLoop({ poll })`)
- Time, when behaviour depends on TTL/expiry — `SelfWriteTracker` accepts `now?: number` arguments
- Sleep, when behaviour depends on retry timing — `runDevicePollLoop({ sleep })`

**What NOT to mock:**
- The `obsidian` module — use the alias mock at `__mocks__/obsidian.ts`
- `gray-matter` — the production dep is in the mock, so parse/emit round-trips match
- Web Crypto — `tests/sync/frontmatter.test.ts` and `tests/sync/scan.test.ts` use real `sha256Hex`

## Hash-Stability Tests

**Why these matter.** The parsed-back-body hash invariant (commit `0685a8b` and the broader CHANGELOG context) requires SHA-256 always be computed over `parseFile(stringifyFile(body, fm)).body` — never over the raw body. If raw bodies are hashed, `gray-matter`'s round-trip whitespace adjustments cause the next scan to produce a different hash, reconcile flags the file as locally-edited, and the plugin push-loops.

**Tests locking this down:**

| File | Test | Asserts |
|------|------|---------|
| `tests/sync/frontmatter.test.ts:12-20` | "round-trips a file with frontmatter without changing the body hash" | `sha256Hex(parsed.body) === sha256Hex(parseFile(stringifyFile(body, fm)).body)` |
| `tests/sync/frontmatter.test.ts:56-68` | "body hash is invariant under huma_uuid injection" | Adding `huma_uuid` to frontmatter must not change the body hash |
| `tests/sync/frontmatter.test.ts:70-81` | "hash of parsed-back body is stable across stringify round-trip even when body is empty" | Empty-body backfill case — `sha256("") != sha256("\n")` is the trap; we must hash the parsed-back body |
| `tests/sync/scan.test.ts:70-76` | "hash stays stable across two scan passes of the same content" | Two scans of the same vault produce identical hashes per path |

If new code paths write to the vault, they must be locked down with a hash-stability test in this style. The test should hash the body once at write time and again after parsing back the on-disk text, and assert equality.

## Reconcile Property Coverage

`tests/sync/reconcile.test.ts` is the largest single suite (24 tests, 553 lines). It maps onto the conflict matrix in `docs/CONFLICT-MATRIX.md` — several tests are explicitly labelled "master row #N" or "sub-matrix ✓ ✗ – ✓" to keep the test ↔ matrix correspondence visible.

**Coverage clusters:**

| Cluster | Examples |
|---------|----------|
| Direction | "emits a pull...", "emits a push...", "emits an add...", "emits server-deleted..." |
| Master matrix rows | row #2 (push id=null), row #3 (first-time pull), row #4 (data.json wiped), row #7 (no-op all-agree) |
| Rename interactions | rename-local only; rename-local + pull; push with previousPath; concurrent rename-rename |
| Delta-mode regressions | "delta hides server entry, file edited locally → pushes via synthetic server entry", "does not re-push a locally-known file absent from a delta server manifest" — these tie back to the CHANGELOG "Bug 1" / "Bug 2" fixes |
| Exclusion | excluded folders bypass server entries; excluded folders bypass scanned files |
| Determinism | "produces stable action ids deterministically across runs" |
| Ordering | "orders pulls before pushes before adds" |
| Duplicate UUID | refuses to act when two scanned files share a `huma_uuid`; still emits server-deleted for tombstoned duplicates |

**Adding a reconcile test:** Locate the matrix row in `docs/CONFLICT-MATRIX.md`, label the test with the row coordinate, and reuse the `serverEntry`/`localRecord`/`scanned` builders. Assert the full action list with `expect(out.actions).toEqual([...])` rather than just kinds, when path/previousPath/serverId carry semantic load.

## Build-Time Invariants (Test-Enforced)

Two suites are *invariants* rather than unit tests. They scan source files at test time and fail CI on regression.

**`tests/security/no-token-vault-write.test.ts`:**
- Walks `src/**/*.ts`, splits into function blocks, and asserts no block contains both a vault-write call (`vault.modify`, `vault.create`, `vault.createFolder`, `vault.append`) and a token reference (`access_token`, `refresh_token`, `storedToken`/`storedTokens`, `bearer`).
- Override marker: `// SAFE-TOKEN-WRITE: <reason>` inside the function body suppresses the hit. Use only when the false positive is unambiguous.
- The naive function-block splitter is documented at `tests/security/no-token-vault-write.test.ts:69-105` — good enough for hand-written code, not a TS parser.

**`tests/sync/scan.test.ts:45-76`:**
- Loads the on-disk fixture vault (`tests/fixtures/vault/`) via `node:fs` and asserts:
  - One scan entry per markdown file
  - Files without `huma_uuid` are flagged for first-push (`uuid: null`)
  - `huma_uuid` is extracted for synced files
  - Hashes are deterministic across two scan passes

## Coverage

**Coverage tooling:** Not configured. `npm test` runs `vitest run` with no `--coverage` flag and `vitest.config.ts` has no `coverage` block.

**Effective coverage:** All `src/sync/` modules and all `src/security/` modules have dedicated test files. `src/client/auth.ts` has device-flow coverage. `src/client/http.ts` has no direct test (covered transitively through `pull-worker.test.ts`). `src/main.ts`, `src/ui/*`, and `src/sync/engine.ts` are covered indirectly — `engine.ts` is hard to test in isolation by design (the policy and reconcile pieces are factored out and tested individually).

## Common Patterns

**Async testing:**
```typescript
it("returns tokens when poll succeeds", async () => {
    const result = await runDevicePollLoop({ ... });
    expect(result).toEqual({ kind: "tokens", tokens });
});
```
Every async test is `async () => { await ...; expect(...); }`. No `.then()` chains.

**Error testing (HttpError):**
```typescript
function notFoundError(id: string): HttpError {
    return new HttpError(404, { error: "not_found", id }, { error: "not_found", id });
}

const api = {
    pull: async (ids: string[]) => {
        if (ids.includes("id-gone")) throw notFoundError("id-gone");
        return { files: ... };
    },
} as unknown as VaultApiClient;
```
(`tests/sync/pull-worker.test.ts:20-25, 64-74`). Errors are constructed via local helpers, then thrown from the stubbed boundary.

**Discriminated-union assertion:**
```typescript
expect(out.actions.map((a) => a.kind)).toEqual(["pull", "push"]);
// or, when path/serverId matter:
expect(out.actions).toEqual([
    { kind: "push", id: "push:id-x", serverId: "id-x", path: "new.md", previousPath: "old.md" },
]);
```

**Determinism:**
```typescript
const a = reconcile(input);
const b = reconcile(input);
expect(a.actions.map((x) => x.id)).toEqual(b.actions.map((x) => x.id));
```
(`tests/sync/reconcile.test.ts:377-386`).

## Adding a Test

1. Create `tests/<area>/<module>.test.ts` mirroring `src/<area>/<module>.ts`.
2. Start with `import { describe, expect, it } from "vitest";` then the source under test, then types.
3. Add a five-line file-purpose header explaining *why* the test exists (regression context, invariant being locked, master-matrix row).
4. Add inline `Partial<T>`-based builder helpers if the existing builders don't fit.
5. If the test interacts with the vault, use `createMockApp()` or build a `MockVault` directly. Cast to the production type with `as unknown as Parameters<typeof X>[0]` only at the call site.
6. If the test asserts hash stability, hash the parsed-back body, never the raw body.
7. Run `npm test` locally; the suite is fast (~700 ms) so there is no excuse for skipping.

---

*Testing analysis: 2026-05-01*
