# Bootstrap + GitHub Login/Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Portal project (bun + TypeScript scaffold) and implement GitHub OAuth2 login end-to-end: a user logs in via GitHub, Portal provisions a local profile on first login, and issues its own bearer access/refresh tokens that gate a protected `/me` endpoint.

**Architecture:** A `Bun.serve`-based HTTP server (`src/server.ts`) fronting a set of small, pure auth modules (OAuth2 client, JWT-style access tokens, opaque refresh tokens, CSRF state, user provisioning) backed by `bun:sqlite`. The database and provider config are injectable into `createServer()`, so the full login flow is tested end-to-end against a fake in-process provider server — no real network calls, no real GitHub credentials needed for tests.

**Tech Stack:** Bun runtime + `bun:test`, `bun:sqlite`, TypeScript, `node:crypto` (via Bun's Node.js compat) for HMAC signing. No new runtime dependencies; `bun-types` is added as a dev-only type-declarations package.

**Spec:** `specification.md` (Architecture section: Request flow, SCS manifest contract, Identity/sessions/rights, Context model)

## Global Constraints

- Runtime and bundler is bun; TypeScript for frontend and backend-for-frontend. (`Claude.md`)
- Minimize external dependencies — ask before introducing a new one. (`Claude.md`, `specification.md`)
- Every feature needs a set of test cases, run via `bun:test`, files under `./__tests__` (per `bunfig.toml`). (`Claude.md`)
- Use bun's own functionality before reaching for other libraries. (`Claude.md`)
- Login is via a configurable set of OAuth2 authorization servers, selected explicitly by the user (e.g. "Sign in with GitHub"); GitHub is the first provider. Portal never stores the provider's credentials. (`specification.md`)
- First login provisions a local Portal profile with no roles assigned by default — there is no separate sign-up form. (`specification.md`)
- Browser↔Portal auth is a bearer token issued by Portal itself (not the provider's token), stored client-side, short-lived and reissued via a refresh flow. (`specification.md`)

**Two assumptions this plan makes, not covered by an explicit spec/CLAUDE.md line — flag if either is wrong:**
1. TLS is out of scope for this plan; the server runs over plain HTTP. `bunfig.toml`'s `[serve] https = true` governs Bun's built-in full-stack dev server for HTML entrypoints, not this hand-written `Bun.serve` call.
2. The OAuth `redirect_uri` is derived per-request from the incoming request's own origin (`url.origin`) rather than a fixed configured base URL, to avoid hardcoding a host.

---

### Task 1: Project bootstrap + health check

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/server.ts`
- Test: `__tests__/server/health.test.ts`

**Interfaces:**
- Produces: `createServer(opts?: { port?: number }): ReturnType<typeof Bun.serve>` from `src/server.ts`.

- [ ] **Step 1: Write the failing test**

`__tests__/server/health.test.ts`:
```ts
import { describe, test, expect, afterAll } from "bun:test";
import { createServer } from "../../src/server";

describe("GET /health", () => {
  const server = createServer({ port: 0 });
  afterAll(() => server.stop());

  test("returns ok status", async () => {
    const response = await fetch(`${server.url}health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test __tests__/server/health.test.ts`
Expected: FAIL — `src/server.ts` does not exist yet (module not found).

- [ ] **Step 3: Create the project scaffold and minimal server**

Create `package.json`:
```json
{
  "name": "portal",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/server.ts",
    "start": "bun src/server.ts",
    "test": "bun test"
  }
}
```

Run: `bun add -d bun-types` (adds the dev-only type declarations for Bun's built-in APIs; pins the resolved version into `package.json`/`bun.lock`).

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "jsx": "react",
    "jsxFactory": "h",
    "jsxFragmentFactory": "Fragment",
    "types": ["bun-types"]
  }
}
```

Create `src/server.ts`:
```ts
export type ServerOptions = {
  port?: number;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createServer(opts: ServerOptions = {}) {
  return Bun.serve({
    port: opts.port ?? 3000,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return json({ status: "ok" });
      }
      return json({ error: "not found" }, 404);
    },
  });
}

if (import.meta.main) {
  const server = createServer({ port: Number(process.env.PORT ?? 3000) });
  console.log(`Portal listening on ${server.url}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test __tests__/server/health.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock tsconfig.json src/server.ts __tests__/server/health.test.ts
git commit -m "chore: bootstrap bun/TypeScript project with a health check endpoint"
```

---

### Task 2: Database + user provisioning

**Files:**
- Create: `src/db.ts`
- Create: `src/auth/users.ts`
- Test: `__tests__/auth/users.test.ts`

**Interfaces:**
- Produces: `createDatabase(path?: string): Database` from `src/db.ts` (creates `users` and `refresh_tokens` tables if missing).
- Produces: `type ProviderProfile = { providerUserId: string; email: string | null; displayName: string | null }`, `type User = { id: string; provider: string; providerUserId: string; email: string | null; displayName: string | null }`, `findOrCreateUser(db: Database, provider: string, profile: ProviderProfile): User` from `src/auth/users.ts`.

- [ ] **Step 1: Write the failing test**

`__tests__/auth/users.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { createDatabase } from "../../src/db";
import { findOrCreateUser } from "../../src/auth/users";

describe("findOrCreateUser", () => {
  test("creates a new user on first login", () => {
    const db = createDatabase(":memory:");
    const user = findOrCreateUser(db, "github", {
      providerUserId: "123",
      email: "octocat@example.com",
      displayName: "The Octocat",
    });
    expect(user.provider).toBe("github");
    expect(user.providerUserId).toBe("123");
    expect(user.email).toBe("octocat@example.com");
    expect(user.id).toBeTruthy();
  });

  test("returns the same user on a second login", () => {
    const db = createDatabase(":memory:");
    const first = findOrCreateUser(db, "github", {
      providerUserId: "123",
      email: "octocat@example.com",
      displayName: "The Octocat",
    });
    const second = findOrCreateUser(db, "github", {
      providerUserId: "123",
      email: "octocat@example.com",
      displayName: "The Octocat",
    });
    expect(second.id).toBe(first.id);
  });

  test("treats the same provider user id from a different provider as a different user", () => {
    const db = createDatabase(":memory:");
    const githubUser = findOrCreateUser(db, "github", {
      providerUserId: "123",
      email: "a@example.com",
      displayName: "A",
    });
    const otherUser = findOrCreateUser(db, "gitlab", {
      providerUserId: "123",
      email: "b@example.com",
      displayName: "B",
    });
    expect(otherUser.id).not.toBe(githubUser.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test __tests__/auth/users.test.ts`
Expected: FAIL — `src/db.ts` / `src/auth/users.ts` do not exist yet.

- [ ] **Step 3: Implement**

`src/db.ts`:
```ts
import { Database } from "bun:sqlite";

export function createDatabase(path: string = "portal.sqlite"): Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      email TEXT,
      display_name TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(provider, provider_user_id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);
  return db;
}
```

`src/auth/users.ts`:
```ts
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export type ProviderProfile = {
  providerUserId: string;
  email: string | null;
  displayName: string | null;
};

export type User = {
  id: string;
  provider: string;
  providerUserId: string;
  email: string | null;
  displayName: string | null;
};

export function findOrCreateUser(db: Database, provider: string, profile: ProviderProfile): User {
  const existing = db
    .query(
      `SELECT id, provider, provider_user_id as providerUserId, email, display_name as displayName
       FROM users WHERE provider = ? AND provider_user_id = ?`
    )
    .get(provider, profile.providerUserId) as User | null;
  if (existing) return existing;

  const id = randomUUID();
  db.query(
    `INSERT INTO users (id, provider, provider_user_id, email, display_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, provider, profile.providerUserId, profile.email, profile.displayName, Math.floor(Date.now() / 1000));

  return { id, provider, providerUserId: profile.providerUserId, email: profile.email, displayName: profile.displayName };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test __tests__/auth/users.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/auth/users.ts __tests__/auth/users.test.ts
git commit -m "feat: add sqlite-backed user provisioning"
```

---

### Task 3: Refresh tokens

**Files:**
- Create: `src/auth/refresh-tokens.ts`
- Test: `__tests__/auth/refresh-tokens.test.ts`

**Interfaces:**
- Consumes: `createDatabase(path?: string): Database` (Task 1's `Database` type comes from `bun:sqlite`), `findOrCreateUser` (Task 2), used only to set up a user id in tests.
- Produces: `createRefreshToken(db: Database, userId: string): string`, `verifyAndRotateRefreshToken(db: Database, token: string): { userId: string; newToken: string } | null`, `revokeRefreshToken(db: Database, token: string): void` from `src/auth/refresh-tokens.ts`.

- [ ] **Step 1: Write the failing test**

`__tests__/auth/refresh-tokens.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { createDatabase } from "../../src/db";
import { findOrCreateUser } from "../../src/auth/users";
import {
  createRefreshToken,
  verifyAndRotateRefreshToken,
  revokeRefreshToken,
} from "../../src/auth/refresh-tokens";

function setupUser(db: ReturnType<typeof createDatabase>) {
  return findOrCreateUser(db, "github", { providerUserId: "1", email: null, displayName: null }).id;
}

describe("refresh tokens", () => {
  test("a freshly created token verifies and rotates to a new token", () => {
    const db = createDatabase(":memory:");
    const userId = setupUser(db);
    const token = createRefreshToken(db, userId);

    const result = verifyAndRotateRefreshToken(db, token);

    expect(result).not.toBeNull();
    expect(result!.userId).toBe(userId);
    expect(result!.newToken).not.toBe(token);
  });

  test("a token cannot be used twice (rotation invalidates the old one)", () => {
    const db = createDatabase(":memory:");
    const userId = setupUser(db);
    const token = createRefreshToken(db, userId);

    verifyAndRotateRefreshToken(db, token);
    const secondAttempt = verifyAndRotateRefreshToken(db, token);

    expect(secondAttempt).toBeNull();
  });

  test("an unknown token fails verification", () => {
    const db = createDatabase(":memory:");
    expect(verifyAndRotateRefreshToken(db, "does-not-exist")).toBeNull();
  });

  test("revoking a token makes it fail verification", () => {
    const db = createDatabase(":memory:");
    const userId = setupUser(db);
    const token = createRefreshToken(db, userId);

    revokeRefreshToken(db, token);

    expect(verifyAndRotateRefreshToken(db, token)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test __tests__/auth/refresh-tokens.test.ts`
Expected: FAIL — `src/auth/refresh-tokens.ts` does not exist yet.

- [ ] **Step 3: Implement**

`src/auth/refresh-tokens.ts`:
```ts
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function createRefreshToken(db: Database, userId: string): string {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS;
  db.query(`INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`).run(token, userId, expiresAt);
  return token;
}

export function verifyAndRotateRefreshToken(db: Database, token: string): { userId: string; newToken: string } | null {
  const row = db
    .query(`SELECT user_id as userId, expires_at as expiresAt FROM refresh_tokens WHERE token = ?`)
    .get(token) as { userId: string; expiresAt: number } | null;
  if (!row) return null;

  db.query(`DELETE FROM refresh_tokens WHERE token = ?`).run(token);
  if (row.expiresAt < Math.floor(Date.now() / 1000)) return null;

  const newToken = createRefreshToken(db, row.userId);
  return { userId: row.userId, newToken };
}

export function revokeRefreshToken(db: Database, token: string): void {
  db.query(`DELETE FROM refresh_tokens WHERE token = ?`).run(token);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test __tests__/auth/refresh-tokens.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/refresh-tokens.ts __tests__/auth/refresh-tokens.test.ts
git commit -m "feat: add rotating refresh tokens"
```

---

### Task 4: Access tokens

**Files:**
- Create: `src/auth/tokens.ts`
- Test: `__tests__/auth/tokens.test.ts`

**Interfaces:**
- Produces: `type AccessTokenPayload = { sub: string; exp: number }`, `signAccessToken(userId: string, secret: string, ttlSeconds?: number): string` (default `ttlSeconds = 900`), `verifyAccessToken(token: string, secret: string): AccessTokenPayload | null` from `src/auth/tokens.ts`.

- [ ] **Step 1: Write the failing test**

`__tests__/auth/tokens.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { signAccessToken, verifyAccessToken } from "../../src/auth/tokens";

const SECRET = "test-secret";

describe("access tokens", () => {
  test("a freshly signed token verifies and carries the user id", () => {
    const token = signAccessToken("user-1", SECRET);
    const payload = verifyAccessToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("user-1");
  });

  test("an expired token fails verification", () => {
    const token = signAccessToken("user-1", SECRET, -1);
    expect(verifyAccessToken(token, SECRET)).toBeNull();
  });

  test("a token signed with a different secret fails verification", () => {
    const token = signAccessToken("user-1", SECRET);
    expect(verifyAccessToken(token, "wrong-secret")).toBeNull();
  });

  test("a tampered payload fails verification", () => {
    const token = signAccessToken("user-1", SECRET);
    const [header, , signature] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: "user-2", exp: 9999999999 })).toString("base64url");
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    expect(verifyAccessToken(tampered, SECRET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test __tests__/auth/tokens.test.ts`
Expected: FAIL — `src/auth/tokens.ts` does not exist yet.

- [ ] **Step 3: Implement**

`src/auth/tokens.ts`:
```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export type AccessTokenPayload = {
  sub: string;
  exp: number;
};

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signAccessToken(userId: string, secret: string, ttlSeconds = 900): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: AccessTokenPayload = { sub: userId, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payloadEncoded = base64url(JSON.stringify(payload));
  const signature = sign(`${header}.${payloadEncoded}`, secret);
  return `${header}.${payloadEncoded}.${signature}`;
}

export function verifyAccessToken(token: string, secret: string): AccessTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expectedSignature = sign(`${header}.${payload}`, secret);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccessTokenPayload;
  if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
  return decoded;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test __tests__/auth/tokens.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/tokens.ts __tests__/auth/tokens.test.ts
git commit -m "feat: add signed access tokens"
```

---

### Task 5: OAuth CSRF state

**Files:**
- Create: `src/auth/state.ts`
- Test: `__tests__/auth/state.test.ts`

**Interfaces:**
- Produces: `createState(secret: string): string`, `verifyState(state: string, secret: string): boolean` from `src/auth/state.ts`.

- [ ] **Step 1: Write the failing test**

`__tests__/auth/state.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { createState, verifyState } from "../../src/auth/state";

const SECRET = "state-secret";

describe("OAuth state", () => {
  test("a freshly created state verifies", () => {
    const state = createState(SECRET);
    expect(verifyState(state, SECRET)).toBe(true);
  });

  test("a state signed with a different secret fails verification", () => {
    const state = createState(SECRET);
    expect(verifyState(state, "wrong-secret")).toBe(false);
  });

  test("a malformed state fails verification", () => {
    expect(verifyState("not-a-valid-state", SECRET)).toBe(false);
  });

  test("two states are not identical (nonce varies)", () => {
    expect(createState(SECRET)).not.toBe(createState(SECRET));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test __tests__/auth/state.test.ts`
Expected: FAIL — `src/auth/state.ts` does not exist yet.

- [ ] **Step 3: Implement**

`src/auth/state.ts`:
```ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function createState(secret: string): string {
  const nonce = randomBytes(16).toString("base64url");
  const signature = createHmac("sha256", secret).update(nonce).digest("base64url");
  return `${nonce}.${signature}`;
}

export function verifyState(state: string, secret: string): boolean {
  const [nonce, signature] = state.split(".");
  if (!nonce || !signature) return false;
  const expected = createHmac("sha256", secret).update(nonce).digest("base64url");
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test __tests__/auth/state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/state.ts __tests__/auth/state.test.ts
git commit -m "feat: add signed CSRF state for the OAuth login flow"
```

---

### Task 6: OAuth provider config + client

**Files:**
- Create: `src/auth/providers.ts`
- Create: `src/auth/oauth-client.ts`
- Test: `__tests__/auth/oauth-client.test.ts`

**Interfaces:**
- Consumes: `type ProviderProfile` (Task 2, `src/auth/users.ts`).
- Produces: `type OAuthProviderConfig = { name: string; authorizeUrl: string; tokenUrl: string; userInfoUrl: string; clientId: string; clientSecret: string; scope: string; mapProfile: (json: any) => ProviderProfile }`, `getProviders(env?: NodeJS.ProcessEnv): Record<string, OAuthProviderConfig>` from `src/auth/providers.ts`.
- Produces: `buildAuthorizeUrl(provider: OAuthProviderConfig, state: string, redirectUri: string): string`, `exchangeCodeForToken(provider: OAuthProviderConfig, code: string, redirectUri: string, fetchFn?: typeof fetch): Promise<string>`, `fetchUserProfile(provider: OAuthProviderConfig, accessToken: string, fetchFn?: typeof fetch): Promise<ProviderProfile>` from `src/auth/oauth-client.ts`.

- [ ] **Step 1: Write the failing test**

`__tests__/auth/oauth-client.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { buildAuthorizeUrl, exchangeCodeForToken, fetchUserProfile } from "../../src/auth/oauth-client";
import type { OAuthProviderConfig } from "../../src/auth/providers";

const provider: OAuthProviderConfig = {
  name: "test-provider",
  authorizeUrl: "https://provider.example/authorize",
  tokenUrl: "https://provider.example/token",
  userInfoUrl: "https://provider.example/user",
  clientId: "client-123",
  clientSecret: "secret-456",
  scope: "read:user",
  mapProfile: (json: any) => ({
    providerUserId: String(json.id),
    email: json.email ?? null,
    displayName: json.name ?? null,
  }),
};

describe("buildAuthorizeUrl", () => {
  test("includes client id, redirect uri, scope, and state", () => {
    const url = new URL(buildAuthorizeUrl(provider, "the-state", "https://portal.example/auth/callback/test-provider"));
    expect(url.origin + url.pathname).toBe("https://provider.example/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://portal.example/auth/callback/test-provider");
    expect(url.searchParams.get("scope")).toBe("read:user");
    expect(url.searchParams.get("state")).toBe("the-state");
  });
});

describe("exchangeCodeForToken", () => {
  test("posts the code and returns the access token", async () => {
    let capturedBody: any = null;
    const fakeFetch = (async (_input: any, init?: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ access_token: "fake-access-token" }), { status: 200 });
    }) as typeof fetch;

    const token = await exchangeCodeForToken(provider, "the-code", "https://portal.example/auth/callback/test-provider", fakeFetch);

    expect(token).toBe("fake-access-token");
    expect(capturedBody.code).toBe("the-code");
    expect(capturedBody.client_id).toBe("client-123");
  });

  test("throws when the response has no access_token", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 400 })) as typeof fetch;
    await expect(exchangeCodeForToken(provider, "bad-code", "https://portal.example/cb", fakeFetch)).rejects.toThrow();
  });
});

describe("fetchUserProfile", () => {
  test("fetches and maps the provider's user profile", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ id: 42, email: "a@example.com", name: "A" }), { status: 200 })) as typeof fetch;
    const profile = await fetchUserProfile(provider, "fake-access-token", fakeFetch);
    expect(profile).toEqual({ providerUserId: "42", email: "a@example.com", displayName: "A" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test __tests__/auth/oauth-client.test.ts`
Expected: FAIL — `src/auth/providers.ts` / `src/auth/oauth-client.ts` do not exist yet.

- [ ] **Step 3: Implement**

`src/auth/providers.ts`:
```ts
import type { ProviderProfile } from "./users";

export type OAuthProviderConfig = {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  mapProfile: (json: any) => ProviderProfile;
};

export function getProviders(env: NodeJS.ProcessEnv = process.env): Record<string, OAuthProviderConfig> {
  return {
    github: {
      name: "github",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userInfoUrl: "https://api.github.com/user",
      clientId: env.GITHUB_CLIENT_ID ?? "",
      clientSecret: env.GITHUB_CLIENT_SECRET ?? "",
      scope: "read:user user:email",
      mapProfile: (json: any) => ({
        providerUserId: String(json.id),
        email: json.email ?? null,
        displayName: json.name ?? json.login ?? null,
      }),
    },
  };
}
```

`src/auth/oauth-client.ts`:
```ts
import type { OAuthProviderConfig } from "./providers";
import type { ProviderProfile } from "./users";

export function buildAuthorizeUrl(provider: OAuthProviderConfig, state: string, redirectUri: string): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", provider.scope);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForToken(
  provider: OAuthProviderConfig,
  code: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const response = await fetchFn(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) throw new Error(`Token exchange failed with status ${response.status}`);
  const json = (await response.json()) as { access_token?: string; error?: string };
  if (!json.access_token) throw new Error(`Token exchange response missing access_token: ${json.error ?? "unknown error"}`);
  return json.access_token;
}

export async function fetchUserProfile(
  provider: OAuthProviderConfig,
  accessToken: string,
  fetchFn: typeof fetch = fetch
): Promise<ProviderProfile> {
  const response = await fetchFn(provider.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Fetching user profile failed with status ${response.status}`);
  const json = await response.json();
  return provider.mapProfile(json);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test __tests__/auth/oauth-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/providers.ts src/auth/oauth-client.ts __tests__/auth/oauth-client.test.ts
git commit -m "feat: add configurable OAuth2 provider registry and client"
```

---

### Task 7: Auth middleware

**Files:**
- Create: `src/auth/middleware.ts`
- Test: `__tests__/auth/middleware.test.ts`

**Interfaces:**
- Consumes: `signAccessToken`, `verifyAccessToken` (Task 4, `src/auth/tokens.ts`).
- Produces: `getAuthenticatedUserId(req: Request, secret: string): string | null` from `src/auth/middleware.ts`.

- [ ] **Step 1: Write the failing test**

`__tests__/auth/middleware.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { signAccessToken } from "../../src/auth/tokens";
import { getAuthenticatedUserId } from "../../src/auth/middleware";

const SECRET = "test-secret";

describe("getAuthenticatedUserId", () => {
  test("returns the user id for a valid bearer token", () => {
    const token = signAccessToken("user-1", SECRET);
    const req = new Request("http://localhost/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(getAuthenticatedUserId(req, SECRET)).toBe("user-1");
  });

  test("returns null when there is no Authorization header", () => {
    const req = new Request("http://localhost/me");
    expect(getAuthenticatedUserId(req, SECRET)).toBeNull();
  });

  test("returns null for a malformed Authorization header", () => {
    const req = new Request("http://localhost/me", { headers: { Authorization: "not-bearer token" } });
    expect(getAuthenticatedUserId(req, SECRET)).toBeNull();
  });

  test("returns null for an invalid token", () => {
    const req = new Request("http://localhost/me", { headers: { Authorization: "Bearer garbage" } });
    expect(getAuthenticatedUserId(req, SECRET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test __tests__/auth/middleware.test.ts`
Expected: FAIL — `src/auth/middleware.ts` does not exist yet.

- [ ] **Step 3: Implement**

`src/auth/middleware.ts`:
```ts
import { verifyAccessToken } from "./tokens";

export function getAuthenticatedUserId(req: Request, secret: string): string | null {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  const payload = verifyAccessToken(token, secret);
  return payload?.sub ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test __tests__/auth/middleware.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/middleware.ts __tests__/auth/middleware.test.ts
git commit -m "feat: add bearer token auth middleware"
```

---

### Task 8: Wire the full login flow into the HTTP server

**Files:**
- Modify: `src/server.ts` (replace the whole file — extends `ServerOptions` and adds the auth routes)
- Test: `__tests__/server/auth-flow.test.ts`

**Interfaces:**
- Consumes: `createDatabase` (Task 2, `src/db.ts`); `findOrCreateUser` (Task 2, `src/auth/users.ts`); `createRefreshToken`, `verifyAndRotateRefreshToken`, `revokeRefreshToken` (Task 3, `src/auth/refresh-tokens.ts`); `signAccessToken` (Task 4, `src/auth/tokens.ts`); `createState`, `verifyState` (Task 5, `src/auth/state.ts`); `getProviders`, `type OAuthProviderConfig` (Task 6, `src/auth/providers.ts`); `buildAuthorizeUrl`, `exchangeCodeForToken`, `fetchUserProfile` (Task 6, `src/auth/oauth-client.ts`); `getAuthenticatedUserId` (Task 7, `src/auth/middleware.ts`).
- Produces: `type ServerOptions = { port?: number; db?: Database; providers?: Record<string, OAuthProviderConfig>; accessTokenSecret?: string; stateSecret?: string }`, `createServer(opts?: ServerOptions): ReturnType<typeof Bun.serve>` (same export name as Task 1, extended options — the Task 1 health test keeps passing unmodified). Routes added: `GET /auth/login/:provider`, `GET /auth/callback/:provider`, `POST /auth/refresh`, `POST /auth/logout`, `GET /me`.

- [ ] **Step 1: Write the failing test**

`__tests__/server/auth-flow.test.ts`:
```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "../../src/server";
import { createDatabase } from "../../src/db";
import type { OAuthProviderConfig } from "../../src/auth/providers";

let fakeProvider: ReturnType<typeof Bun.serve>;
let portal: ReturnType<typeof createServer>;

beforeAll(() => {
  fakeProvider = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/token" && req.method === "POST") {
        const body = await req.json();
        if (body.code !== "valid-code") {
          return new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 400 });
        }
        return new Response(JSON.stringify({ access_token: "fake-provider-access-token" }), { status: 200 });
      }
      if (url.pathname === "/user" && req.method === "GET") {
        return new Response(JSON.stringify({ id: 999, email: "octocat@example.com", name: "The Octocat" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const providerConfig: OAuthProviderConfig = {
    name: "fake",
    authorizeUrl: `${fakeProvider.url}authorize`,
    tokenUrl: `${fakeProvider.url}token`,
    userInfoUrl: `${fakeProvider.url}user`,
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    scope: "read:user",
    mapProfile: (json: any) => ({
      providerUserId: String(json.id),
      email: json.email ?? null,
      displayName: json.name ?? null,
    }),
  };

  portal = createServer({
    port: 0,
    db: createDatabase(":memory:"),
    providers: { fake: providerConfig },
    accessTokenSecret: "access-secret",
    stateSecret: "state-secret",
  });
});

afterAll(() => {
  fakeProvider.stop();
  portal.stop();
});

async function loginAndGetTokens() {
  const loginResponse = await fetch(`${portal.url}auth/login/fake`, { redirect: "manual" });
  const state = new URL(loginResponse.headers.get("Location")!).searchParams.get("state")!;
  const callbackResponse = await fetch(`${portal.url}auth/callback/fake?code=valid-code&state=${encodeURIComponent(state)}`);
  return callbackResponse.json() as Promise<{ accessToken: string; refreshToken: string }>;
}

describe("full login flow", () => {
  test("login redirects to the provider's authorize URL with the right params", async () => {
    const response = await fetch(`${portal.url}auth/login/fake`, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(`${fakeProvider.url}authorize`);
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  test("callback with a valid code and state issues tokens, and /me returns the profile", async () => {
    const { accessToken, refreshToken } = await loginAndGetTokens();
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();

    const meResponse = await fetch(`${portal.url}me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(meResponse.status).toBe(200);
    const me = await meResponse.json();
    expect(me.email).toBe("octocat@example.com");
    expect(me.provider).toBe("fake");
    expect(me.roles).toEqual([]);
  });

  test("callback rejects an invalid state", async () => {
    const response = await fetch(`${portal.url}auth/callback/fake?code=valid-code&state=garbage`);
    expect(response.status).toBe(400);
  });

  test("refresh issues a new access token and rotates the refresh token", async () => {
    const { refreshToken } = await loginAndGetTokens();

    const refreshResponse = await fetch(`${portal.url}auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = await refreshResponse.json();
    expect(refreshed.accessToken).toBeTruthy();
    expect(refreshed.refreshToken).not.toBe(refreshToken);
  });

  test("logout revokes the refresh token", async () => {
    const { refreshToken } = await loginAndGetTokens();

    await fetch(`${portal.url}auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    const refreshResponse = await fetch(`${portal.url}auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(refreshResponse.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test __tests__/server/auth-flow.test.ts`
Expected: FAIL — `src/server.ts` doesn't yet accept `db`/`providers`/`accessTokenSecret`/`stateSecret` options or serve the auth routes.

- [ ] **Step 3: Implement**

Replace the full contents of `src/server.ts` with:
```ts
import type { Database } from "bun:sqlite";
import { createDatabase } from "./db";
import { findOrCreateUser } from "./auth/users";
import { createRefreshToken, revokeRefreshToken, verifyAndRotateRefreshToken } from "./auth/refresh-tokens";
import { signAccessToken } from "./auth/tokens";
import { createState, verifyState } from "./auth/state";
import { getProviders, type OAuthProviderConfig } from "./auth/providers";
import { buildAuthorizeUrl, exchangeCodeForToken, fetchUserProfile } from "./auth/oauth-client";
import { getAuthenticatedUserId } from "./auth/middleware";

export type ServerOptions = {
  port?: number;
  db?: Database;
  providers?: Record<string, OAuthProviderConfig>;
  accessTokenSecret?: string;
  stateSecret?: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createServer(opts: ServerOptions = {}) {
  const db = opts.db ?? createDatabase(process.env.DATABASE_PATH ?? "portal.sqlite");
  const providers = opts.providers ?? getProviders();
  const accessTokenSecret = opts.accessTokenSecret ?? process.env.ACCESS_TOKEN_SECRET ?? "dev-secret-change-me";
  const stateSecret = opts.stateSecret ?? process.env.STATE_SECRET ?? "dev-state-secret-change-me";

  return Bun.serve({
    port: opts.port ?? 3000,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return json({ status: "ok" });
      }

      const loginMatch = url.pathname.match(/^\/auth\/login\/([^/]+)$/);
      if (loginMatch && req.method === "GET") {
        const provider = providers[loginMatch[1]];
        if (!provider) return json({ error: "unknown provider" }, 404);
        const state = createState(stateSecret);
        const redirectUri = `${url.origin}/auth/callback/${loginMatch[1]}`;
        return Response.redirect(buildAuthorizeUrl(provider, state, redirectUri), 302);
      }

      const callbackMatch = url.pathname.match(/^\/auth\/callback\/([^/]+)$/);
      if (callbackMatch && req.method === "GET") {
        const providerName = callbackMatch[1];
        const provider = providers[providerName];
        if (!provider) return json({ error: "unknown provider" }, 404);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state || !verifyState(state, stateSecret)) {
          return json({ error: "invalid state or missing code" }, 400);
        }
        const redirectUri = `${url.origin}/auth/callback/${providerName}`;
        const providerAccessToken = await exchangeCodeForToken(provider, code, redirectUri);
        const profile = await fetchUserProfile(provider, providerAccessToken);
        const user = findOrCreateUser(db, providerName, profile);
        const accessToken = signAccessToken(user.id, accessTokenSecret);
        const refreshToken = createRefreshToken(db, user.id);
        return json({ accessToken, refreshToken, expiresIn: 900 });
      }

      if (url.pathname === "/auth/refresh" && req.method === "POST") {
        const body = (await req.json()) as { refreshToken?: string };
        if (!body.refreshToken) return json({ error: "missing refreshToken" }, 400);
        const result = verifyAndRotateRefreshToken(db, body.refreshToken);
        if (!result) return json({ error: "invalid or expired refresh token" }, 401);
        const accessToken = signAccessToken(result.userId, accessTokenSecret);
        return json({ accessToken, refreshToken: result.newToken, expiresIn: 900 });
      }

      if (url.pathname === "/auth/logout" && req.method === "POST") {
        const body = (await req.json()) as { refreshToken?: string };
        if (body.refreshToken) revokeRefreshToken(db, body.refreshToken);
        return json({ status: "ok" });
      }

      if (url.pathname === "/me" && req.method === "GET") {
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        if (!userId) return json({ error: "unauthorized" }, 401);
        const row = db
          .query(
            `SELECT id, provider, provider_user_id as providerUserId, email, display_name as displayName
             FROM users WHERE id = ?`
          )
          .get(userId) as
          | { id: string; provider: string; providerUserId: string; email: string | null; displayName: string | null }
          | null;
        if (!row) return json({ error: "unauthorized" }, 401);
        return json({ ...row, roles: [] });
      }

      return json({ error: "not found" }, 404);
    },
  });
}

if (import.meta.main) {
  const server = createServer({ port: Number(process.env.PORT ?? 3000) });
  console.log(`Portal listening on ${server.url}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test`
Expected: PASS — all tests from Tasks 1–8, including the full login-flow integration test.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts __tests__/server/auth-flow.test.ts
git commit -m "feat: wire GitHub OAuth2 login/refresh/logout into the HTTP server"
```
