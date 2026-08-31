# Environment Configuration

Portal is configured entirely through environment variables, loaded from a
per-environment file via Bun's built-in `--env-file` flag (see
`GETTING_STARTED.md`, step 3, for the setup walkthrough). This document is
the full reference: every variable Portal reads, what it controls, and its
default.

## Precedence

Every configurable value in this codebase resolves the same way, in this
order:

1. An explicit value passed via `createServer(opts)` (or
   `createManifestRegistry(baseUrls, opts)`) — used by tests and by any code
   embedding Portal directly.
2. The matching environment variable, if set.
3. A hardcoded default.

Portal's own entrypoint (the `if (import.meta.main)` block at the bottom of
`src/server.ts`) never passes overriding opts for the variables below, so in
a real deployment the environment variable is the only lever you have — opts
only matter if you're embedding `createServer`/`createManifestRegistry`
yourself (e.g. in a test).

## Variables

| Variable | Required? | Default | Purpose |
|---|---|---|---|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Needed for GitHub sign-in to work | — | OAuth App credentials (see `GETTING_STARTED.md`, step 2). Missing → boot-time warning + `/auth/login/github` fails with a clear redirect instead of reaching GitHub. |
| `NODE_ENV` | No | unset (development) | `"production"` enables strict mode: missing signing secrets throw at boot instead of warning, and the OAuth state cookie is marked `Secure`. Anything else behaves as development. |
| `ACCESS_TOKEN_SECRET` | Required in production | insecure dev default (warns) | Signs access tokens. |
| `STATE_SECRET` | Required in production | insecure dev default (warns) | Signs the OAuth CSRF state parameter. Same fallback behavior as `ACCESS_TOKEN_SECRET`. |
| `INTERNAL_TOKEN_SECRET` | Required in production, only if `PORTAL_SCS_URLS` is set | — | Signs internal service-to-service tokens for SCS bundle/manifest fetches. Not resolved at all when no manifest registry is configured. |
| `DATABASE_PATH` | No | `portal.sqlite` | SQLite file path. |
| `PORT` | No | `3000` | Server port. |
| `PORTAL_BASE_URL` | No | the incoming request's own origin | Overrides the base URL used to build OAuth redirect/callback URIs. Set this if Portal runs behind a reverse proxy or a different public hostname. |
| `PORTAL_ADMIN_EMAILS` | No | empty | Comma-separated list of emails auto-granted the `portal:admin` role on first login. Empty → no user is auto-promoted to admin. |
| `PORTAL_SCS_URLS` | No | empty | Comma-separated base URLs of registered self-contained systems. Empty → no manifest registry, so nav/route enforcement/SCS bundle loading are all disabled. |
| `PORTAL_SCS_REFRESH_INTERVAL_MS` | No | `60000` (1 minute) | How often Portal re-fetches every registered SCS's manifest. Only read when `PORTAL_SCS_URLS` is set. |
| `PORTAL_SCS_FETCH_TIMEOUT_MS` | No | `10000` (10s) | Timeout for a single SCS manifest fetch. Only read when `PORTAL_SCS_URLS` is set. |
| `PORTAL_SCS_REQUEST_TIMEOUT_MS` | No | `10000` (10s) | Timeout for Portal's server-to-SCS proxy fetches — bundle loads and composed GET/POST data requests. An SCS that doesn't respond in time is treated as unreachable (`502`). |
| `PORTAL_MAX_REQUEST_BODY_SIZE` | No | `1048576` (1MB) | Maximum inbound request body size Portal accepts, in bytes. A larger body gets `413 Request Entity Too Large` before Portal's own routing logic ever runs. |
| `PORTAL_ACCESS_TOKEN_TTL_SECONDS` | No | `900` (15 minutes) | Access token lifetime. |
| `PORTAL_REFRESH_TOKEN_TTL_SECONDS` | No | `2592000` (30 days) | Refresh token lifetime. Changing this only affects tokens issued after the change — tokens already stored carry their own already-computed expiry. |

## Example `.env`

Everything with a default is optional — this shows every variable for
completeness, including ones you'd typically leave unset in development.

```bash
# --- Required ---
export GITHUB_CLIENT_ID=your-github-oauth-app-client-id
export GITHUB_CLIENT_SECRET=your-github-oauth-app-client-secret

# --- Required in production only ---
# export NODE_ENV=production
# export ACCESS_TOKEN_SECRET=a-long-random-string
# export STATE_SECRET=a-different-long-random-string

# --- SCS registration (optional; leave unset to run Portal standalone) ---
# export PORTAL_SCS_URLS=http://localhost:4001
# export INTERNAL_TOKEN_SECRET=shared-secret-matching-every-registered-scs
# export PORTAL_SCS_REFRESH_INTERVAL_MS=60000
# export PORTAL_SCS_FETCH_TIMEOUT_MS=10000
# export PORTAL_SCS_REQUEST_TIMEOUT_MS=10000

# --- Everything else (optional) ---
# export DATABASE_PATH=portal.sqlite
# export PORT=3000
# export PORTAL_BASE_URL=https://portal.example.com
# export PORTAL_ADMIN_EMAILS=you@example.com,teammate@example.com
# export PORTAL_MAX_REQUEST_BODY_SIZE=1048576
# export PORTAL_ACCESS_TOKEN_TTL_SECONDS=900
# export PORTAL_REFRESH_TOKEN_TTL_SECONDS=2592000
```
