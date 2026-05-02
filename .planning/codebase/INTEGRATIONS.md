# External Integrations

**Analysis Date:** 2026-05-01

## APIs & External Services

**Huma dashboard vault API:**
- Origin: configured per-install via `HumaSettings.serverBaseUrl` (`src/settings.ts:21`). Default `https://huma.energy` (`src/settings.ts:41`); current pre-release deployment target is `https://humagreenfield.netlify.app`. Hosted on Netlify (subject to Netlify lambda body / response size limits — see `docs/CONFLICT-MATRIX.md:131-132`, `docs/CONFLICT-MATRIX.md:155`).
- SDK/Client: none. All traffic goes through a thin in-repo client built on Obsidian's `requestUrl`:
  - `src/client/http.ts` — `FetchHttpClient implements HttpClient`. Sets `Accept: application/json`, `Content-Type: application/json` (when body present), and `Authorization: Bearer <token>` (when `bearer` supplied). Calls `requestUrl({ throw: false })` and converts non-2xx into `HttpError` with the parsed `ApiError` body (`src/client/http.ts:42-71`).
  - `src/client/vault-api.ts` — `VaultApiClient`. Wraps the auth-bearing endpoints.
  - `src/client/auth.ts` — `AuthClient`. Wraps the token endpoints (no bearer required).
- Auth: ZITADEL device-authorization grant, intermediated by the dashboard. Bearer access tokens on every vault call. See "Authentication & Identity" below.

**Endpoints (constants — server paths are hardcoded as constants, the host comes from settings):**

| Endpoint | Method | Constant | Purpose |
|---|---|---|---|
| `/api/vault/auth/device` | POST | `DEVICE_AUTH_PATH` (`src/client/auth.ts:11`) | Start ZITADEL device flow; server returns `session_id`, `user_code`, `verification_uri_complete`, `expires_in`, `interval` |
| `/api/vault/auth/token` | POST | `TOKEN_PATH` (`src/client/auth.ts:12`) | Exchange `session_id` (grant_type=`device_code`) or `refresh_token` (grant_type=`refresh_token`) for a `TokenResponse` |
| `/api/vault/auth/revoke` | POST | `REVOKE_PATH` (`src/main.ts:27`) | Best-effort refresh-token revocation on sign-out (`src/main.ts:291-301`) |
| `/api/vault/manifest` | GET | `MANIFEST_PATH` (`src/client/vault-api.ts:10`) | Paginated server manifest. Query params: `cursor` (pagination), `since` (ISO timestamp for delta sync) |
| `/api/vault/pull` | POST | `PULL_PATH` (`src/client/vault-api.ts:11`) | Body `{ ids: string[] }`; returns full file bodies + frontmatter for the given UUIDs. Batch size 50 (`docs/CONFLICT-MATRIX.md:60`) |
| `/api/vault/push` | POST | `PUSH_PATH` (`src/client/vault-api.ts:12`) | Body `PushRequest` (see `src/types.ts:78-86`); returns one of `accept` / `merge_clean` / `merge_dirty` (`src/types.ts:88-103`) |

**Wire contract:** Transcribed in `src/types.ts:1-124`. The header note flags this as a manual transcription that will be regenerated from `@huma/vault-api-schema` once that package is published.

## Data Storage

**Databases:**
- None directly. The dashboard server owns the canonical store; the plugin treats it as a black-box CRDT-like editor and never connects to a database.

**Plugin data store (local):**
- Obsidian per-plugin data: `<vault>/.obsidian/plugins/huma-vault-sync/data.json`. Persisted via `Plugin.loadData()` / `Plugin.saveData()` (`src/main.ts:94-101`).
- Schema: `HumaPluginData` (`src/settings.ts:10-18`):
  - `settings: HumaSettings` — `serverBaseUrl`, `syncIntervalSeconds`, `excludedFolders`.
  - `tokens: StoredTokens | null` — `access_token`, `refresh_token`, `access_expires_at` (ms epoch).
  - `manifest: ManifestRecord[]` — Local sync manifest (`{id, path, version, hash, lastSyncedAt}`).
  - `auditRing: AuditEntry[]` — 200-entry ring buffer (`AUDIT_RING_CAPACITY` at `src/audit/ring.ts:3`).
  - `lastSince: string | null` — Server time of last successful manifest fetch, used as `?since=` for delta polling.

**File Storage:**
- Obsidian vault filesystem. The plugin reads/writes markdown via:
  - `app.vault.cachedRead(file)` — read.
  - `app.vault.process(file, () => text)` — atomic body replace (`src/sync/frontmatter.ts:62-68`, used as `replaceFileBody`).
  - `app.fileManager.processFrontMatter(file, mutator)` — atomic frontmatter mutation (referenced at `docs/CONFLICT-MATRIX.md:73`).
  - `app.vault.create(path, text)` — first-time pull file creation.
  - `app.fileManager.renameFile(file, toPath)` — rename, also rewrites internal `[[wikilinks]]` (`docs/CONFLICT-MATRIX.md:84`).
- Server paths are normalized via `normalizePath` (Obsidian) before any vault operation, defending against traversal and platform-mixed slashes (`SECURITY.md:32`).

**Caching:**
- None on the network layer. Obsidian's `vault.cachedRead` provides an in-memory file cache.
- A `SelfWriteTracker` (`src/sync/self-write-tracker.ts`) keeps a path × body-hash map with 30 s TTL to suppress `vault.on('modify')` events fired by the plugin's own writes (`src/main.ts:42`, `src/main.ts:395-415`).

## Authentication & Identity

**Auth Provider:**
- ZITADEL (https://zitadel.com), upstreamed via the Huma dashboard. The plugin never contacts ZITADEL directly — the dashboard's `/api/vault/auth/*` endpoints proxy/intermediate the device-authorization grant.

**Flow:** OAuth 2.0 Device Authorization Grant (RFC 8628).

1. `AuthClient.startDeviceFlow()` (`src/client/auth.ts:43-51`) — POST `/api/vault/auth/device` with `{ client_name }`. Server returns `DeviceAuthResponse` (`src/types.ts:8-14`) including `verification_uri_complete` (opened with `window.open` at `src/main.ts:244`) and `user_code` (shown in a long-duration `Notice`).
2. `runDevicePollLoop` (`src/client/auth.ts:128-153`) — polls POST `/api/vault/auth/token` with `grant_type: "device_code"` at the server-provided `interval` until one of `tokens` / `expired` / `denied`, with `slow_down` adding 5 s to the interval and `pending` continuing.
3. On `tokens`, `tokensFromResponse` (`src/client/auth.ts:96-102`) computes `access_expires_at = Date.now() + expires_in*1000`. Both tokens persist to `data.json`.

**Refresh:** `AuthClient.refresh(refreshToken)` (`src/client/auth.ts:82-93`) — POST `/api/vault/auth/token` with `grant_type: "refresh_token"`. The `TokenManager` (`src/sync/token-manager.ts`) is the single chokepoint for access-token reads (`getAccessToken`); it transparently refreshes when `isAccessTokenExpired` returns true (30 s slack, `src/client/auth.ts:16`). Refresh tokens rotate per ZITADEL policy and both tokens are swapped atomically via `store.setTokens(next)`.

**Revocation:** Best-effort POST `/api/vault/auth/revoke` on sign-out (`src/main.ts:291-301`). Failure is silent.

**Unrecoverable auth errors** (`src/sync/token-manager.ts:15-27`): `refresh_token_reused`, `token_reused`, `invalid_grant`, `invalid_token`. On any of these, `TokenManager` clears stored tokens and the plugin transitions to signed-out (`src/main.ts:323-340`) so it doesn't loop on a revoked refresh token.

**Token storage invariants (security-critical):**
- Tokens live exclusively in `data.json` under `.obsidian/plugins/huma-vault-sync/`. They are never written to a vault file (`SECURITY.md:29-32`).
- Startup invariant: `scanVaultForTokens` (`src/security/vault-token-scan.ts:24-49`) scans every markdown file for token-shaped strings (≥40 char base64url runs, see `src/security/token-shape.ts`). Exact matches against stored tokens **block** plugin start with a 0-timeout `Notice`. Heuristic-only matches surface a warning + `token_scan_warning` audit entry but do not block.

## Monitoring & Observability

**Error Tracking:**
- None. No Sentry, Bugsnag, or similar SDK present.

**Logs:**
- Local audit ring at `data.json#auditRing` — 200 entries, in-plugin only (`src/audit/ring.ts`). Events enumerated at `src/types.ts:105-116`: `push_accept`, `push_reject`, `merge_clean`, `merge_dirty`, `path_change`, `pull_apply`, `pull_drop`, `server_deleted`, `duplicate_uuid`, `token_scan_warning`, `auth_error`. Surfaced to the user via the **Huma — Show sync log** command (`src/main.ts:462-466`) which opens `AuditLogModal`.
- The server's audit log is the canonical record of every push outcome (per `README.md:53`); the local ring is a debugging aid.
- User-facing error messages are produced by `classifyErrorForUser` (`src/main.ts:520-535`), narrowing `HttpError` and network `TypeError` into stable strings.

## CI/CD & Deployment

**Hosting:**
- Plugin: GitHub releases (sideloaded via BRAT). No npm package, no Obsidian community registry entry.
- Server (Huma dashboard): Netlify-hosted (inferred from `docs/CONFLICT-MATRIX.md:131,155` — references to "Netlify body cap" and Netlify lambda response/request limits). The current pre-release target host is `https://humagreenfield.netlify.app`.

**CI Pipeline:**
- No `.github/workflows`, `.circleci`, `.gitlab-ci.yml`, or other CI config is present in the repo. Build/lint/test runs locally.

**Release tooling:**
- `npm version` runs `version-bump.mjs` to sync `manifest.json` and `versions.json`, then `git add`s them (`package.json:10`, `version-bump.mjs`).
- `.npmrc` sets `tag-version-prefix=""` so tags match `versions.json` keys.

## Environment Configuration

**Required env vars:**
- None. The plugin runs inside Obsidian and reads all configuration from `data.json` via the settings tab (`src/ui/settings-tab.ts`). No `process.env.*` references in `src/`.

**Secrets location:**
- Access + refresh tokens: `<vault>/.obsidian/plugins/huma-vault-sync/data.json#tokens`. Never elsewhere.
- `.env` and `.env.*` are gitignored (`.gitignore:24-25`) defensively; no `.env` file exists in this repo.

## Webhooks & Callbacks

**Incoming:**
- None. The plugin is a pure client; it does not expose any HTTP surface.

**Outgoing:**
- All initiated by the plugin (manifest poll, pull, push, auth). No fire-and-forget webhooks are sent to third parties.

## Network Layer Constraints

- **`fetch` is forbidden.** All HTTP traffic goes through Obsidian's `requestUrl` (`src/client/http.ts:1`, `SECURITY.md:34`). On desktop this routes through Electron's `net` module; on mobile through native HTTP. This avoids CORS preflight and stays within Obsidian's documented network surface. Verified: only `requestUrl` is imported from `obsidian`; the lone `fetch` reference in `src/main.ts:530` is a pattern-match against a `TypeError.message` for error classification, not a call.
- **No `AbortSignal` for in-flight requests.** `requestUrl` does not expose abort, so plugin unload lets in-flight requests run to completion (`docs/CONFLICT-MATRIX.md:157`).
- **Body size limits.** Server is on Netlify; lambda body cap (~5–6 MB) bounds push and pull payloads. Pre-flight client-side size check is queued but not yet implemented (`docs/CONFLICT-MATRIX.md:131,155`).

---

*Integration audit: 2026-05-01*
