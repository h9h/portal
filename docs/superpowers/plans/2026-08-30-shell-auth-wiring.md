# Shell Auth Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user actually log in through the client shell — close the gap left at the end of the frontend-shell plan, where the shell could only ever reach "please log in" with no way to progress.

**Architecture:** `GET /auth/callback/:provider` stops returning a JSON body (unreadable by anything, since a bare browser navigation only ever gets served the shell HTML) and instead redirects to `/` with the token pair in the URL fragment on success, or an error indicator on an exchange failure. The shell reads and clears that fragment on boot, storing tokens in `sessionStorage` via a new internal `src/runtime/auth.ts` module. `portalFetch` (already built) gains automatic `Authorization` header attachment and a transparent refresh-and-retry on 401, deduped across concurrent callers. A new public `GET /auth/providers` lets the shell render real sign-in links without ever seeing provider secrets. `usePortalLogout()` closes the loop.

**Tech Stack:** Bun runtime + `bun:test`, TypeScript, the already-approved `react`/`react-dom`/`@happy-dom/global-registrator` from the frontend-shell plan. No new dependencies.

**Spec:** `specification.md` (Architecture → Client shell: Authentication hand-off, Token storage and refresh, Login screen; Identity, sessions, and rights → Browser ↔ Portal)

## Global Constraints

- Fragment hand-off format is exact: success → `/#access_token=<token>&refresh_token=<token>&expires_in=900`; an OAuth exchange failure → `/#error=oauth_failed`. The pre-existing 400 (invalid state/missing code) and 404 (unknown provider) failure responses are unchanged — only the exchange-failure (try/catch) path changes from a JSON 502 to this redirect. (`specification.md`)
- Token storage lives in `sessionStorage`, one JSON blob under one key. (`specification.md`)
- `getStoredTokens`/`storeTokens`/`clearTokens` (`src/runtime/auth.ts`) are **not** part of `@portal/runtime`'s public barrel (`src/runtime/index.ts`) — they're shell-internal plumbing an SCS bundle must never be able to reach; only `usePortalLogout` and `portalFetch` are public-facing for this feature. The shell imports `src/runtime/auth.ts` directly via a relative path, bypassing the public barrel.
- `portalFetch` attaches `Authorization: Bearer <accessToken>` automatically when a token is stored; on a 401 (and only when a token was actually attached — an unauthenticated call was never going to succeed a retry either), it attempts exactly one `POST /auth/refresh` and retries the original request once. Concurrent 401s share one in-flight refresh attempt via a module-level memoized promise (refresh tokens rotate on use — two simultaneous refresh calls would otherwise race). (`specification.md`)
- `GET /auth/providers` is public (no authentication), returns `[{ "name": string, "label": string }, ...]`, and must never expose `clientId`/`clientSecret`/`tokenUrl`/etc. (`specification.md`)
- `usePortalLogout()`: clears stored tokens, best-effort `POST /auth/logout` (revocation failure must not block the client-side clear), then a real `window.location.assign("/")` — no separate reactive auth-state plumbing. (`specification.md`)
- Every feature needs a set of test cases, run via `bun:test`, files under `./__tests__`. (`CLAUDE.md`)
- Minimize external dependencies. (`CLAUDE.md`) — this plan adds none.
- Client-side role/route checks remain UX only, never the security boundary — nothing in this plan changes that; the server-side checks this token flow feeds are unchanged. (`specification.md`, established precedent)

## File Structure

- `src/auth/providers.ts` — **modify**: `OAuthProviderConfig` gains `label: string`; the `github` entry gets `label: "GitHub"`.
- `src/server.ts` — **modify**: new `GET /auth/providers`; `GET /auth/callback/:provider`'s success and exchange-failure responses become redirects instead of JSON bodies.
- `src/runtime/auth.ts` — **new**: `getStoredTokens`/`storeTokens`/`clearTokens`, `sessionStorage`-backed. Internal — not re-exported from `src/runtime/index.ts`.
- `src/runtime/fetch.ts` — **modify**: `portalFetch` attaches `Authorization`, refreshes-and-retries on 401 with cross-call dedup.
- `src/runtime/logout.ts` — **new**: `usePortalLogout()`.
- `src/runtime/index.ts` — **modify**: export `usePortalLogout`.
- `src/frontend/shell-entry.tsx` — **modify**: boot sequence reads/clears the URL fragment, fetches `/auth/providers` when unauthenticated, renders real sign-in links + any login error.
- Test files: extend `__tests__/auth/providers.test.ts`, `__tests__/server/auth-flow.test.ts`, `__tests__/server/admin-bootstrap.test.ts`, `__tests__/frontend/shell-entry.test.tsx`; new `__tests__/runtime/auth.test.ts`, `__tests__/runtime/logout.test.tsx`; extend `__tests__/runtime/fetch.test.ts`.

---

### Task 1: Provider labels + `GET /auth/providers`

**Files:**
- Modify: `src/auth/providers.ts`, `src/server.ts`
- Test: extend `__tests__/auth/providers.test.ts`, extend `__tests__/server/auth-flow.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `OAuthProviderConfig.label: string`; `GET /auth/providers` → `200 [{ name: string, label: string }, ...]`, no auth required.

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/auth/providers.test.ts` (new `describe` block after the existing one):
```ts
describe("getProviders labels", () => {
  test("github has a display label distinct from its provider key", () => {
    const { name, label } = getProviders({}).github;
    expect(name).toBe("github");
    expect(label).toBe("GitHub");
  });
});
```

Add to `__tests__/server/auth-flow.test.ts` (new `describe` block; reuses this file's existing `fakeProviderConfig`/`portal` from `beforeAll` — note `fakeProviderConfig` will need a `label` field added too, see Step 1b):
```ts
describe("GET /auth/providers", () => {
  test("lists configured providers by name and label, with no secrets", async () => {
    const response = await fetch(`${portal.url}auth/providers`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown[];
    expect(body).toEqual([{ name: "fake", label: "Fake Provider" }]);
  });

  test("requires no authentication", async () => {
    // (same request as above, no Authorization header — already implicit,
    // this test exists to make the "no auth required" contract explicit
    // and catch a future accidental auth-gate regression)
    const response = await fetch(`${portal.url}auth/providers`);
    expect(response.status).not.toBe(401);
  });
});
```

**Step 1b**: `auth-flow.test.ts`'s `fakeProviderConfig` object (in `beforeAll`) needs `label: "Fake Provider"` added alongside its existing fields, since `OAuthProviderConfig` will require it after Step 3.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/auth/providers.test.ts __tests__/server/auth-flow.test.ts`
Expected: FAIL — `label` doesn't exist on the type yet, `/auth/providers` doesn't exist yet.

- [ ] **Step 3: Implement**

In `src/auth/providers.ts`, add `label: string` to `OAuthProviderConfig` and to the `github` entry:
```ts
export type OAuthProviderConfig = {
  name: string;
  label: string;
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
      label: "GitHub",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      ...
```
(keep every other field exactly as-is, just insert `label: "GitHub",` after `name: "github",`)

In `src/server.ts`, add the new endpoint. Place it right after the `/health` block and before `/auth/login/:provider`, grouped with the other `/auth/*` fixed routes:
```ts
      if (url.pathname === "/auth/providers" && req.method === "GET") {
        return json(Object.values(providers).map((provider) => ({ name: provider.name, label: provider.label })));
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/auth/providers.test.ts __tests__/server/auth-flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/auth/providers.ts src/server.ts __tests__/auth/providers.test.ts __tests__/server/auth-flow.test.ts
git commit -m "feat: add provider display labels and GET /auth/providers"
```

---

### Task 2: OAuth callback hands off via a redirect, not a JSON body

**⚠ This task changes the response shape of a real browser navigation, and breaks two existing test helpers that parse the old JSON shape.** `GET /auth/callback/:provider`'s success and exchange-failure paths now redirect instead of returning JSON — this is a deliberate, spec'd change. `__tests__/server/auth-flow.test.ts`'s `loginAndGetTokens()` helper and `__tests__/server/admin-bootstrap.test.ts`'s `login()` helper (a different plan, already merged) both currently call `callbackResponse.json()` — both need rewriting to parse the redirect's fragment instead. The 400 (invalid state/missing code) and 404 (unknown provider) responses are unaffected — leave those tests exactly as they are.

**Files:**
- Modify: `src/server.ts`
- Test: `__tests__/server/auth-flow.test.ts`, `__tests__/server/admin-bootstrap.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /auth/callback/:provider` success → `302` redirect to `<origin>/#access_token=<jwt>&refresh_token=<jwt>&expires_in=900`; exchange failure → `302` redirect to `<origin>/#error=oauth_failed`.

- [ ] **Step 1: Write the failing tests**

Replace `__tests__/server/auth-flow.test.ts`'s `loginAndGetTokens()` helper:
```ts
async function loginAndGetTokens() {
  const loginResponse = await fetch(`${portal.url}auth/login/fake`, { redirect: "manual" });
  const state = new URL(loginResponse.headers.get("Location")!).searchParams.get("state")!;
  const callbackResponse = await fetch(
    `${portal.url}auth/callback/fake?code=valid-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual" }
  );
  const location = new URL(callbackResponse.headers.get("Location")!);
  const fragment = new URLSearchParams(location.hash.slice(1));
  return {
    accessToken: fragment.get("access_token")!,
    refreshToken: fragment.get("refresh_token")!,
  };
}
```
(every existing test that calls this helper — "callback with a valid code and state issues tokens...", "refresh issues a new access token...", "a rotated refresh token can itself be used...", "logging out with a rotated refresh token...", "logout revokes the refresh token" — needs no changes to its own body; they all go through the helper and get fixed automatically)

Add a new test proving the redirect shape itself, right after "callback with a valid code and state issues tokens, and /me returns the profile":
```ts
  test("callback with a valid code and state redirects to / with the token pair in the URL fragment", async () => {
    const loginResponse = await fetch(`${portal.url}auth/login/fake`, { redirect: "manual" });
    const state = new URL(loginResponse.headers.get("Location")!).searchParams.get("state")!;

    const callbackResponse = await fetch(
      `${portal.url}auth/callback/fake?code=valid-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" }
    );
    expect(callbackResponse.status).toBe(302);
    const location = new URL(callbackResponse.headers.get("Location")!);
    expect(location.pathname).toBe("/");
    const fragment = new URLSearchParams(location.hash.slice(1));
    expect(fragment.get("access_token")).toBeTruthy();
    expect(fragment.get("refresh_token")).toBeTruthy();
    expect(fragment.get("expires_in")).toBe("900");
  });
```

Replace the "callback with a bad code returns a clean error, not a crash" test with:
```ts
  test("callback with a bad code redirects to the shell with an error, not a crash", async () => {
    const loginResponse = await fetch(`${portal.url}auth/login/fake`, { redirect: "manual" });
    const state = new URL(loginResponse.headers.get("Location")!).searchParams.get("state")!;

    const callbackResponse = await fetch(
      `${portal.url}auth/callback/fake?code=wrong-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" }
    );
    expect(callbackResponse.status).toBe(302);
    const location = new URL(callbackResponse.headers.get("Location")!);
    expect(location.pathname).toBe("/");
    const fragment = new URLSearchParams(location.hash.slice(1));
    expect(fragment.get("error")).toBe("oauth_failed");
  });
```

In `__tests__/server/admin-bootstrap.test.ts`, replace the `login()` helper:
```ts
async function login(portal: ReturnType<typeof createServer>) {
  const loginResponse = await fetch(`${portal.url}auth/login/fake`, { redirect: "manual" });
  const state = new URL(loginResponse.headers.get("Location")!).searchParams.get("state")!;
  const callbackResponse = await fetch(
    `${portal.url}auth/callback/fake?code=valid-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual" }
  );
  const location = new URL(callbackResponse.headers.get("Location")!);
  const fragment = new URLSearchParams(location.hash.slice(1));
  return { accessToken: fragment.get("access_token")! };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/server/auth-flow.test.ts __tests__/server/admin-bootstrap.test.ts`
Expected: FAIL — the callback still returns JSON, not a redirect.

- [ ] **Step 3: Implement**

In `src/server.ts`, replace the callback handler's success and catch branches:
```ts
      const callbackMatch = url.pathname.match(/^\/auth\/callback\/([^/]+)$/);
      if (callbackMatch && req.method === "GET") {
        const providerName = callbackMatch[1];
        const provider = getProvider(providers, providerName);
        if (!provider) return json({ error: "unknown provider" }, 404);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state || !verifyState(state, stateSecret)) {
          return json({ error: "invalid state or missing code" }, 400);
        }
        const redirectUri = `${configuredBaseUrl ?? url.origin}/auth/callback/${providerName}`;
        const shellOrigin = configuredBaseUrl ?? url.origin;
        try {
          const providerAccessToken = await exchangeCodeForToken(provider, code, redirectUri);
          const profile = await fetchUserProfile(provider, providerAccessToken);
          const user = findOrCreateUser(db, providerName, profile);
          if (user.email && adminEmails.includes(user.email)) {
            assignRole(db, user.id, "portal:admin");
          }
          const accessToken = signAccessToken(user.id, accessTokenSecret);
          const refreshToken = createRefreshToken(db, user.id);
          // A real browser navigation lands here — under the page/data-fetch
          // split, a bare navigation only ever gets served the shell HTML, so
          // a JSON body would just be shown as raw text with nothing able to
          // read it. Hand the tokens off via the URL fragment instead: never
          // sent to the server on the request that follows, so it doesn't
          // appear in logs or get forwarded via Referer. The shell reads and
          // clears this on boot (see shell-entry.tsx, Task 6).
          const fragment = new URLSearchParams({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: "900",
          });
          return Response.redirect(`${shellOrigin}/#${fragment}`, 302);
        } catch (err) {
          console.error("oauth callback failed", err);
          return Response.redirect(`${shellOrigin}/#error=oauth_failed`, 302);
        }
      }
```
(the `if (!provider) ...` and `if (!code || !state || ...) ...` branches above stay exactly as they are — only the try body's success return and the catch's error return change)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/server/auth-flow.test.ts __tests__/server/admin-bootstrap.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean — this confirms no other file depends on the old JSON callback shape.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts __tests__/server/auth-flow.test.ts __tests__/server/admin-bootstrap.test.ts
git commit -m "feat: hand off OAuth tokens via a redirect fragment instead of a JSON body"
```

---

### Task 3: Client-side token storage (`src/runtime/auth.ts`)

**Files:**
- Create: `src/runtime/auth.ts`, `__tests__/runtime/auth.test.ts`

**Interfaces:**
- Consumes: nothing new (uses the browser's `sessionStorage`, available via `withDom()`).
- Produces: `type StoredSession = { accessToken: string; refreshToken: string }`, `getStoredTokens(): StoredSession | null`, `storeTokens(session: StoredSession): void`, `clearTokens(): void`. **Not** re-exported from `src/runtime/index.ts` — internal to `src/runtime/`, consumed by Task 4's `fetch.ts`, Task 5's `logout.ts`, and Task 6's `shell-entry.tsx` (the latter two via direct relative imports, not through the public barrel).

- [ ] **Step 1: Write the failing tests**

Create `__tests__/runtime/auth.test.ts`:
```ts
import { describe, test, expect, afterEach } from "bun:test";
import { withDom } from "../helpers/dom";

withDom();

// sessionStorage persists across every test in this file (withDom() registers
// happy-dom once per file, not per test) — clear it after each test so one
// test's stored session never leaks into the next.
afterEach(() => {
  sessionStorage.clear();
});

describe("getStoredTokens / storeTokens / clearTokens", () => {
  test("getStoredTokens returns null when nothing has been stored", async () => {
    const { getStoredTokens } = await import("../../src/runtime/auth");
    expect(getStoredTokens()).toBeNull();
  });

  test("storeTokens then getStoredTokens round-trips the session", async () => {
    const { getStoredTokens, storeTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "a.b.c", refreshToken: "r-1" });
    expect(getStoredTokens()).toEqual({ accessToken: "a.b.c", refreshToken: "r-1" });
  });

  test("storeTokens overwrites a previously stored session", async () => {
    const { getStoredTokens, storeTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "old", refreshToken: "old-r" });
    storeTokens({ accessToken: "new", refreshToken: "new-r" });
    expect(getStoredTokens()).toEqual({ accessToken: "new", refreshToken: "new-r" });
  });

  test("clearTokens removes the stored session", async () => {
    const { getStoredTokens, storeTokens, clearTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "a.b.c", refreshToken: "r-1" });
    clearTokens();
    expect(getStoredTokens()).toBeNull();
  });

  test("getStoredTokens returns null for malformed stored JSON, without throwing", async () => {
    const { getStoredTokens } = await import("../../src/runtime/auth");
    sessionStorage.setItem("portal:session", "not valid json{{{");
    expect(getStoredTokens()).toBeNull();
  });

  test("getStoredTokens returns null for a stored value missing the expected shape", async () => {
    const { getStoredTokens } = await import("../../src/runtime/auth");
    sessionStorage.setItem("portal:session", JSON.stringify({ accessToken: "a.b.c" })); // no refreshToken
    expect(getStoredTokens()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test __tests__/runtime/auth.test.ts`
Expected: FAIL — `src/runtime/auth.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/runtime/auth.ts`:
```ts
const STORAGE_KEY = "portal:session";

export type StoredSession = {
  accessToken: string;
  refreshToken: string;
};

// sessionStorage can throw (private/incognito browsing in some browsers,
// storage quota) — reads/writes here must never crash the app; worst case,
// the user is treated as logged out.

export function getStoredTokens(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") return null;
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
  } catch {
    return null;
  }
}

export function storeTokens(session: StoredSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // see comment above — a failed store just means the user stays logged out
  }
}

export function clearTokens(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // see comment above
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test __tests__/runtime/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/auth.ts __tests__/runtime/auth.test.ts
git commit -m "feat: add sessionStorage-backed token storage (internal to the runtime)"
```

---

### Task 4: `portalFetch` — attach Authorization, refresh-and-retry on 401

**Files:**
- Modify: `src/runtime/fetch.ts`
- Test: extend `__tests__/runtime/fetch.test.ts`

**Interfaces:**
- Consumes: `getStoredTokens`, `storeTokens`, `clearTokens` from `./auth` (Task 3).
- Produces: `portalFetch`'s exported signature is unchanged (`(input: string, init?: RequestInit) => Promise<Response>`) — only its behavior gains the Authorization attachment and the transparent refresh-and-retry.

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/runtime/fetch.test.ts` (this file's existing tests don't use `withDom()` since `portalFetch` had no storage dependency before — these new tests need it, since `getStoredTokens`/`storeTokens` read `sessionStorage`; add `withDom()` at the top of the file and an `afterEach` clearing `sessionStorage`, matching Task 3's pattern):
```ts
import { describe, test, expect, mock, afterEach } from "bun:test";
import { withDom } from "../helpers/dom";

withDom();

afterEach(() => {
  sessionStorage.clear();
});

// ... existing "attaches the X-Portal-Data marker header" and "preserves
// caller-supplied headers" tests stay exactly as they are ...

describe("portalFetch — Authorization + refresh", () => {
  test("attaches Authorization when a token is stored", async () => {
    const { storeTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "access-1", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    globalThis.fetch = mock((_input: any, init?: RequestInit) => {
      calls.push(init!);
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      await portalFetch("/orders");
      const headers = new Headers(calls[0].headers);
      expect(headers.get("Authorization")).toBe("Bearer access-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("attaches no Authorization header when no token is stored", async () => {
    const originalFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    globalThis.fetch = mock((_input: any, init?: RequestInit) => {
      calls.push(init!);
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      await portalFetch("/orders");
      const headers = new Headers(calls[0].headers);
      expect(headers.has("Authorization")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("on a 401, refreshes once and retries the original request with the new token", async () => {
    const { storeTokens, getStoredTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "expired", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    const requests: { url: string; auth: string | null }[] = [];
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, auth: headers.get("Authorization") });
      if (url === "/auth/refresh") {
        return Promise.resolve(
          new Response(JSON.stringify({ accessToken: "fresh", refreshToken: "refresh-2" }), { status: 200 })
        );
      }
      if (headers.get("Authorization") === "Bearer expired") {
        return Promise.resolve(new Response("unauthorized", { status: 401 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      const response = await portalFetch("/orders");
      expect(response.status).toBe(200);
      expect(getStoredTokens()).toEqual({ accessToken: "fresh", refreshToken: "refresh-2" });
      // exactly 3 calls: the failing /orders attempt, the refresh, the retry
      expect(requests).toHaveLength(3);
      expect(requests[2].auth).toBe("Bearer fresh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("if refresh itself fails, the original 401 is returned and stored tokens are cleared", async () => {
    const { storeTokens, getStoredTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "expired", refreshToken: "revoked" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((input: any) => {
      if (String(input) === "/auth/refresh") return Promise.resolve(new Response("unauthorized", { status: 401 }));
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      const response = await portalFetch("/orders");
      expect(response.status).toBe(401);
      expect(getStoredTokens()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a 401 with no stored token at all does not attempt a refresh", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = mock((input: any) => {
      calls.push(String(input));
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      const response = await portalFetch("/routes");
      expect(response.status).toBe(401);
      expect(calls).toEqual(["/routes"]); // no /auth/refresh call
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("two concurrent 401s share one in-flight refresh instead of each calling /auth/refresh", async () => {
    const { storeTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "expired", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    let refreshCallCount = 0;
    let resolveRefresh: (() => void) | null = null;
    const refreshGate = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url === "/auth/refresh") {
        refreshCallCount += 1;
        await refreshGate; // hold every refresh call open until the test releases it
        return new Response(JSON.stringify({ accessToken: "fresh", refreshToken: "refresh-2" }), { status: 200 });
      }
      const headers = new Headers(init?.headers);
      if (headers.get("Authorization") === "Bearer expired") return new Response("unauthorized", { status: 401 });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      const first = portalFetch("/orders");
      const second = portalFetch("/billing");
      // give both calls a chance to hit their initial 401 and start refreshing
      await new Promise((resolve) => setTimeout(resolve, 0));
      resolveRefresh!();
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(refreshCallCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test __tests__/runtime/fetch.test.ts`
Expected: FAIL — `portalFetch` doesn't attach `Authorization` or retry on 401 yet.

- [ ] **Step 3: Implement**

Replace `src/runtime/fetch.ts`:
```ts
import { getStoredTokens, storeTokens, clearTokens } from "./auth";

// Deduped across concurrent callers: refresh tokens rotate on use (see
// specification.md), so two simultaneous refresh attempts would race and
// the loser would fail with an already-invalidated token.
let refreshInFlight: Promise<boolean> | null = null;

function refreshTokens(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const stored = getStoredTokens();
      if (!stored) return false;
      try {
        const response = await fetch("/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: stored.refreshToken }),
        });
        if (!response.ok) {
          clearTokens();
          return false;
        }
        const body = (await response.json()) as { accessToken: string; refreshToken: string };
        storeTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken });
        return true;
      } catch {
        clearTokens();
        return false;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

function buildHeaders(init: RequestInit, accessToken: string | undefined): Headers {
  const headers = new Headers(init.headers);
  headers.set("X-Portal-Data", "1");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

export async function portalFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const stored = getStoredTokens();
  const response = await fetch(input, { ...init, headers: buildHeaders(init, stored?.accessToken) });
  if (response.status !== 401 || !stored) return response;

  const refreshed = await refreshTokens();
  if (!refreshed) return response;

  const newStored = getStoredTokens();
  return fetch(input, { ...init, headers: buildHeaders(init, newStored?.accessToken) });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test __tests__/runtime/fetch.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/fetch.ts __tests__/runtime/fetch.test.ts
git commit -m "feat: portalFetch attaches Authorization and transparently refreshes on 401"
```

---

### Task 5: `usePortalLogout()`

**Files:**
- Create: `src/runtime/logout.ts`, `__tests__/runtime/logout.test.tsx`
- Modify: `src/runtime/index.ts`

**Interfaces:**
- Consumes: `getStoredTokens`, `clearTokens` from `./auth` (Task 3).
- Produces: `usePortalLogout(): () => Promise<void>`, re-exported from `src/runtime/index.ts` (the public `@portal/runtime` barrel — this one IS public, unlike the storage functions).

- [ ] **Step 1: Write the failing tests**

Create `__tests__/runtime/logout.test.tsx`:
```tsx
import { describe, test, expect, mock, afterEach } from "bun:test";
import { withDom } from "../helpers/dom";

withDom();

afterEach(() => {
  sessionStorage.clear();
});

describe("usePortalLogout", () => {
  test("clears stored tokens, calls POST /auth/logout with the refresh token, and navigates to /", async () => {
    const { storeTokens, getStoredTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "a.b.c", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    const originalAssign = window.location.assign;
    const calls: { url: string; body: unknown }[] = [];
    let assignedTo: string | null = null;
    globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(init.body as string) : null });
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;
    (window.location as unknown as { assign: (url: string) => void }).assign = (url: string) => {
      assignedTo = url;
    };

    try {
      const { createRoot } = await import("react-dom/client");
      const { act } = await import("react");
      const { usePortalLogout } = await import("../../src/runtime/logout");

      let logout: (() => Promise<void>) | null = null;
      function Probe() {
        logout = usePortalLogout();
        return null;
      }
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Probe />);
      });

      await act(async () => {
        await logout!();
      });

      expect(getStoredTokens()).toBeNull();
      expect(calls).toEqual([{ url: "/auth/logout", body: { refreshToken: "refresh-1" } }]);
      expect(assignedTo).toBe("/");
    } finally {
      globalThis.fetch = originalFetch;
      window.location.assign = originalAssign;
    }
  });

  test("clears local state and navigates even if the server call fails", async () => {
    const { storeTokens, getStoredTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "a.b.c", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    const originalAssign = window.location.assign;
    let assignedTo: string | null = null;
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    (window.location as unknown as { assign: (url: string) => void }).assign = (url: string) => {
      assignedTo = url;
    };

    try {
      const { createRoot } = await import("react-dom/client");
      const { act } = await import("react");
      const { usePortalLogout } = await import("../../src/runtime/logout");

      let logout: (() => Promise<void>) | null = null;
      function Probe() {
        logout = usePortalLogout();
        return null;
      }
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Probe />);
      });

      await act(async () => {
        await logout!();
      });

      expect(getStoredTokens()).toBeNull();
      expect(assignedTo).toBe("/");
    } finally {
      globalThis.fetch = originalFetch;
      window.location.assign = originalAssign;
    }
  });

  test("logging out with no stored session skips the server call but still navigates", async () => {
    const originalFetch = globalThis.fetch;
    const originalAssign = window.location.assign;
    const calls: string[] = [];
    let assignedTo: string | null = null;
    globalThis.fetch = mock(async (input: any) => {
      calls.push(String(input));
      return new Response("ok");
    }) as unknown as typeof fetch;
    (window.location as unknown as { assign: (url: string) => void }).assign = (url: string) => {
      assignedTo = url;
    };

    try {
      const { createRoot } = await import("react-dom/client");
      const { act } = await import("react");
      const { usePortalLogout } = await import("../../src/runtime/logout");

      let logout: (() => Promise<void>) | null = null;
      function Probe() {
        logout = usePortalLogout();
        return null;
      }
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Probe />);
      });

      await act(async () => {
        await logout!();
      });

      expect(calls).toEqual([]);
      expect(assignedTo).toBe("/");
    } finally {
      globalThis.fetch = originalFetch;
      window.location.assign = originalAssign;
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test __tests__/runtime/logout.test.tsx`
Expected: FAIL — `src/runtime/logout.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/runtime/logout.ts`:
```ts
import { useCallback } from "react";
import { getStoredTokens, clearTokens } from "./auth";

export function usePortalLogout(): () => Promise<void> {
  return useCallback(async () => {
    const stored = getStoredTokens();
    clearTokens();
    if (stored) {
      try {
        await fetch("/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: stored.refreshToken }),
        });
      } catch {
        // best-effort: the local session is already cleared either way
      }
    }
    window.location.assign("/");
  }, []);
}
```

Update `src/runtime/index.ts` to add:
```ts
export { usePortalLogout } from "./logout";
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test __tests__/runtime/logout.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/logout.ts src/runtime/index.ts __tests__/runtime/logout.test.tsx
git commit -m "feat: add usePortalLogout()"
```

---

### Task 6: Shell boot reads the fragment, renders a real login screen

**⚠ This task changes `shell-entry.tsx`'s existing "shows a login prompt when /me is 401" test's mock setup** — the App now also fetches `/auth/providers` when unauthenticated, which that test's `mockFetchSequence` doesn't currently mock (it would fall through to the mock's 500 catch-all and push the app into the "error" state instead of "login"). Fix the mock list, don't weaken the assertion.

**Files:**
- Modify: `src/frontend/shell-entry.tsx`
- Test: extend `__tests__/frontend/shell-entry.test.tsx`

**Interfaces:**
- Consumes: `storeTokens` from `../runtime/auth` (Task 3, direct relative import — not through `@portal/runtime`'s public barrel); `portalFetch` from `@portal/runtime` (already imported).
- Produces: on boot, the shell now consumes and clears `window.location.hash`; when unauthenticated, fetches and renders real provider sign-in links plus any login error.

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/frontend/shell-entry.test.tsx`. First, fix the existing 401 test (find `"shows a login prompt when /me is 401"` and replace its body):
```tsx
  test("shows a login prompt with real sign-in links when /me is 401", async () => {
    const restore = mockFetchSequence([
      { path: "/me", status: 401, body: { error: "unauthorized" } },
      { path: "/auth/providers", status: 200, body: [{ name: "github", label: "GitHub" }] },
    ]);
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { App } = await import("../../src/frontend/shell-entry");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<App />);
      });
      await flush(act);

      expect(container.textContent).toContain("GitHub");
      const link = container.querySelector("a") as HTMLAnchorElement | null;
      expect(link?.getAttribute("href")).toBe("/auth/login/github");
    } finally {
      await act(async () => {
        root.unmount();
      });
      restore();
    }
  });
```

Add new tests (in the same `describe("shell App", ...)` block) for the hash-handling behavior:
```tsx
  test("a successful-login hash stores tokens, strips the hash, and proceeds to boot as authenticated", async () => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
      "https://localhost:3000/#access_token=fresh-access&refresh_token=fresh-refresh&expires_in=900"
    );
    const restore = mockFetchSequence([
      { path: "/me", status: 200, body: { id: "u1", roles: [] } },
      { path: "/routes", status: 200, body: { routes: [], contextOwners: {} } },
    ]);
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { App } = await import("../../src/frontend/shell-entry");
    const { getStoredTokens } = await import("../../src/runtime/auth");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<App />);
      });
      await flush(act);

      expect(getStoredTokens()).toEqual({ accessToken: "fresh-access", refreshToken: "fresh-refresh" });
      expect(window.location.hash).toBe("");
      expect(container.textContent).toContain("Not found"); // no routes declared in this test's mock
    } finally {
      await act(async () => {
        root.unmount();
      });
      restore();
      sessionStorage.clear();
    }
  });

  test("a failed-login hash shows a login error above the sign-in links, and strips the hash", async () => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
      "https://localhost:3000/#error=oauth_failed"
    );
    const restore = mockFetchSequence([
      { path: "/me", status: 401, body: { error: "unauthorized" } },
      { path: "/auth/providers", status: 200, body: [{ name: "github", label: "GitHub" }] },
    ]);
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { App } = await import("../../src/frontend/shell-entry");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<App />);
      });
      await flush(act);

      expect(container.textContent).toContain("failed");
      expect(container.textContent).toContain("GitHub");
      expect(window.location.hash).toBe("");
    } finally {
      await act(async () => {
        root.unmount();
      });
      restore();
    }
  });
```
(both new tests must clean up `sessionStorage` — the first does so explicitly in its `finally`; the second never stores anything so needs no cleanup, but confirm this is actually true given the implementation before assuming it)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test __tests__/frontend/shell-entry.test.tsx`
Expected: FAIL — the login screen doesn't fetch providers or render links yet; the hash isn't read yet.

- [ ] **Step 3: Implement**

In `src/frontend/shell-entry.tsx`, add the import (alongside the existing ones):
```tsx
import { storeTokens } from "../runtime/auth";
```

Add a `Provider` type near the top (alongside `Me`/`RoutesResponse`):
```tsx
type Provider = { name: string; label: string };
```

Add `providers` and `loginError` state to `App`, alongside the existing `useState` calls:
```tsx
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loginError, setLoginError] = useState<string | null>(null);
```

At the very top of the boot effect's `try` block (before the existing `const meResponse = await portalFetch("/me");` line), add the hash-consuming step:
```tsx
      try {
        // Auth hand-off: a successful/failed OAuth callback redirects here
        // with the token pair (or an error) in the URL fragment, since a
        // bare browser navigation can only ever be served the shell HTML —
        // there's no code running yet able to read a JSON response body.
        // Consume it once, then scrub it from the URL so it doesn't linger
        // in history or get re-read on a later reload.
        const hash = new URLSearchParams(window.location.hash.slice(1));
        if (hash.has("access_token") && hash.has("refresh_token")) {
          storeTokens({ accessToken: hash.get("access_token")!, refreshToken: hash.get("refresh_token")! });
        } else if (hash.has("error")) {
          setLoginError("Sign-in failed. Please try again.");
        }
        if (window.location.hash) {
          history.replaceState(null, "", window.location.pathname + window.location.search);
        }

        const meResponse = await portalFetch("/me");
```

Change the existing 401 branch to also fetch and store the provider list:
```tsx
        if (meResponse.status === 401) {
          setMe(null);
          const providersResponse = await portalFetch("/auth/providers");
          setProviders((await providersResponse.json()) as Provider[]);
          setStatus("login");
          return;
        }
```

Change the `"login"` status render to show real links plus any error:
```tsx
  if (status === "login") {
    return (
      <div>
        {loginError && <p>{loginError}</p>}
        {providers.map((provider) => (
          <a key={provider.name} href={`/auth/login/${provider.name}`}>
            Sign in with {provider.label}
          </a>
        ))}
      </div>
    );
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test __tests__/frontend/shell-entry.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/shell-entry.tsx __tests__/frontend/shell-entry.test.tsx
git commit -m "feat: shell reads the auth hand-off fragment and renders real sign-in links"
```

---

### Task 7: End-to-end integration test

**Files:**
- Test: new `describe` block in `__tests__/server/auth-flow.test.ts` (reusing this file's existing fake-provider `beforeAll` setup)

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: no new production code — pure verification that a real `portalFetch` call, against a real server, with a real (deliberately expired) access token and a real refresh token, actually completes the full refresh-and-retry round trip; and that `GET /auth/providers` + the callback redirect agree end-to-end with what the shell expects.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/server/auth-flow.test.ts` (new imports needed at the top: `signAccessToken` from `../../src/auth/tokens`, `withDom` from `../helpers/dom` — call `withDom()` once, near the top of the file, since this test needs `sessionStorage`; existing tests in this file don't use DOM APIs and are unaffected by `withDom()` being present, since it's scoped to this one file. `storeTokens`/`getStoredTokens`/`portalFetch` are imported dynamically inside the test body, matching this plan's other DOM-dependent tests):
```ts
describe("end-to-end: portalFetch transparently refreshes an expired access token", () => {
  test("a real expired access token triggers exactly one refresh, then the retried request succeeds", async () => {
    const { storeTokens, getStoredTokens } = await import("../../src/runtime/auth");
    const { portalFetch } = await import("../../src/runtime/fetch");

    // Log in for real, to get a genuine user + a real, valid refresh token —
    // then deliberately overwrite the access token with one already expired
    // (signAccessToken's ttlSeconds parameter makes this trivial), so the
    // very first portalFetch call is guaranteed to hit a real 401 from the
    // real server, not a contrived mock. Decode the userId straight out of
    // the real access token's own payload rather than logging in a second
    // time (a second login would just re-authenticate as the same
    // fake-provider user anyway, since findOrCreateUser is keyed on
    // provider + providerUserId — decoding is simpler and avoids the
    // redundant round trip).
    const { accessToken, refreshToken } = await loginAndGetTokens();
    const userId = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8")).sub as string;
    const expiredAccessToken = signAccessToken(userId, "access-secret", -1);
    storeTokens({ accessToken: expiredAccessToken, refreshToken });

    const response = await portalFetch(`${portal.url}me`);
    expect(response.status).toBe(200);
    const me = (await response.json()) as { id: string };
    expect(me.id).toBe(userId);

    const stored = getStoredTokens();
    expect(stored?.accessToken).not.toBe(expiredAccessToken);
    expect(stored?.refreshToken).not.toBe(refreshToken); // rotated

    sessionStorage.clear();
  });

  test("GET /auth/providers matches what the shell's login screen expects to render", async () => {
    const response = await fetch(`${portal.url}auth/providers`);
    const body = (await response.json()) as { name: string; label: string }[];
    expect(body).toContainEqual({ name: "fake", label: "Fake Provider" });
  });
});
```

Note: this file's `beforeAll` already constructs `portal` with `accessTokenSecret: "access-secret"` — the literal above matches it. If a future edit to this file's `beforeAll` ever changes that value, update this test's literal to match (there's no shared exported constant to import instead).

- [ ] **Step 2: Run to verify it fails, then implement any real gap it exposes**

Run: `bun test __tests__/server/auth-flow.test.ts`
Expected: this exercises only already-built code from Tasks 1–6, so it should pass without any further implementation — if it doesn't, that means an earlier task has a real bug; fix that task's code (not this test) and re-run.

- [ ] **Step 3: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add __tests__/server/auth-flow.test.ts
git commit -m "test: add end-to-end coverage of the transparent-refresh round trip"
```
