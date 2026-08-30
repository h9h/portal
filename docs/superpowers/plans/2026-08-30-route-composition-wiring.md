# Route Composition Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire authentication, route enforcement, and SCS fragment fetching into `src/server.ts` so a real request to an SCS-declared route is actually authenticated, authorized, and proxied — closing the gap the previous plan explicitly left open ("route enforcement merged" did not mean "routes are enforced").

**Architecture:** A new self-contained internal-token module (`src/auth/internal-tokens.ts`) for Portal→SCS auth. Two small, additive-in-spirit-but-signature-changing modifications to already-merged modules: `RouteIndexEntry` gains a `baseUrl` field (`src/rights/route-access.ts`), and `ManifestRegistry` gains a subscribable `onUpdate` method so a cached route index can be rebuilt exactly when manifest data changes rather than per-request or on an unsynced timer (`src/scs/manifest-registry.ts`). Finally, `src/server.ts` gains an optional `manifestRegistry` option; when present, a `GET`-only catch-all handler authenticates, normalizes the path, enforces access, mints a scoped internal token, fetches the matched SCS's fragment, and forwards it.

**Tech Stack:** Bun runtime + `bun:test`, TypeScript, global `fetch` (injectable in tests). No new dependencies.

**Spec:** `specification.md` (Architecture → Request flow, Identity/sessions/rights → Portal → SCS, Route enforcement)

## Global Constraints

- Runtime and bundler is bun; TypeScript for frontend and backend-for-frontend. (`Claude.md`)
- Minimize external dependencies — ask before introducing a new one. (`Claude.md`, `specification.md`)
- Every feature needs a set of test cases, run via `bun:test`, files under `./__tests__`. (`Claude.md`)
- Each manifest route maps to exactly one SCS; composing the response means fetching that one SCS's fragment and returning it as-is (forwarding content-type), no shell/template wrapping, no multi-fragment merging. (`specification.md`)
- Only `GET` requests are enforced/composed; other methods to an otherwise-enforceable path are not handled by this mechanism. (`specification.md`)
- Before checking the route index, the request path is normalized by stripping a single trailing slash (except `/` itself); the query string is not part of route matching but is still forwarded to the SCS. (`specification.md`)
- A `forbidden` result returns a generic 403 body with no `requiredRoles` — required roles are logged server-side only. (`specification.md`)
- The Portal→SCS internal token is signed with its own secret (`INTERNAL_TOKEN_SECRET`), separate from the browser-facing access token's secret, and its roles claim is filtered to only the target SCS's namespaced roles. (`specification.md`)
- `checkAccess` assumes an already-authenticated caller and an already-normalized path (`src/rights/route-access.ts`'s existing JSDoc) — this plan's server wiring is exactly the code responsible for upholding both preconditions.
- Secrets resolve via `resolveSecret` in `src/server.ts`: explicit option, then env var, then a dev default with a warning — but fail fast (throw at construction) if unset in production. Follow this exact existing pattern for `INTERNAL_TOKEN_SECRET`.

---

### Task 1: Internal token module

**Files:**
- Create: `src/auth/internal-tokens.ts`
- Test: `__tests__/auth/internal-tokens.test.ts`

**Interfaces:**
- Produces: `type InternalTokenPayload = { sub: string; roles: string[]; exp: number }`, `signInternalToken(userId: string, roles: string[], secret: string, ttlSeconds?: number): string` (default `ttlSeconds = 60`), `verifyInternalToken(token: string, secret: string): InternalTokenPayload | null` from `src/auth/internal-tokens.ts`.

This module is structurally close to the existing `src/auth/tokens.ts` (`signAccessToken`/`verifyAccessToken`) but carries a `roles: string[]` claim and uses a much shorter default TTL (60s, vs. the browser-facing token's 900s) since it's minted fresh for each individual outbound SCS request, never held or reused by a client across requests.

- [ ] **Step 1: Write the failing tests**

`__tests__/auth/internal-tokens.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { signInternalToken, verifyInternalToken } from "../../src/auth/internal-tokens";

const SECRET = "test-secret";

function constructTokenWithPayload(payloadStr: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(payloadStr).toString("base64url");
  const signature = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("internal tokens", () => {
  test("a freshly signed token verifies and carries the user id and roles", () => {
    const token = signInternalToken("user-1", ["orders:admin"], SECRET);
    const payload = verifyInternalToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("user-1");
    expect(payload!.roles).toEqual(["orders:admin"]);
  });

  test("a token can carry an empty roles array", () => {
    const token = signInternalToken("user-1", [], SECRET);
    const payload = verifyInternalToken(token, SECRET);
    expect(payload!.roles).toEqual([]);
  });

  test("an expired token fails verification", () => {
    const token = signInternalToken("user-1", ["orders:admin"], SECRET, -1);
    expect(verifyInternalToken(token, SECRET)).toBeNull();
  });

  test("a token signed with a different secret fails verification", () => {
    const token = signInternalToken("user-1", ["orders:admin"], SECRET);
    expect(verifyInternalToken(token, "wrong-secret")).toBeNull();
  });

  test("a tampered payload fails verification", () => {
    const token = signInternalToken("user-1", ["orders:admin"], SECRET);
    const [header, , signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: "user-2", roles: ["orders:admin"], exp: 9999999999 })
    ).toString("base64url");
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    expect(verifyInternalToken(tampered, SECRET)).toBeNull();
  });

  test("a validly-signed token with invalid JSON payload returns null", () => {
    const token = constructTokenWithPayload("not valid json{");
    expect(verifyInternalToken(token, SECRET)).toBeNull();
  });

  test("a validly-signed token missing required fields returns null", () => {
    const missingRoles = constructTokenWithPayload(JSON.stringify({ sub: "user-1", exp: 9999999999 }));
    expect(verifyInternalToken(missingRoles, SECRET)).toBeNull();

    const missingSub = constructTokenWithPayload(JSON.stringify({ roles: [], exp: 9999999999 }));
    expect(verifyInternalToken(missingSub, SECRET)).toBeNull();

    const rolesNotArray = constructTokenWithPayload(
      JSON.stringify({ sub: "user-1", roles: "orders:admin", exp: 9999999999 })
    );
    expect(verifyInternalToken(rolesNotArray, SECRET)).toBeNull();

    const rolesNotStrings = constructTokenWithPayload(
      JSON.stringify({ sub: "user-1", roles: [1, 2], exp: 9999999999 })
    );
    expect(verifyInternalToken(rolesNotStrings, SECRET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/auth/internal-tokens.test.ts`
Expected: FAIL — `src/auth/internal-tokens.ts` does not exist yet.

- [ ] **Step 3: Implement**

`src/auth/internal-tokens.ts`:
```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export type InternalTokenPayload = {
  sub: string;
  roles: string[];
  exp: number;
};

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signInternalToken(userId: string, roles: string[], secret: string, ttlSeconds = 60): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: InternalTokenPayload = {
    sub: userId,
    roles,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadEncoded = base64url(JSON.stringify(payload));
  const signature = sign(`${header}.${payloadEncoded}`, secret);
  return `${header}.${payloadEncoded}.${signature}`;
}

export function verifyInternalToken(token: string, secret: string): InternalTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expectedSignature = sign(`${header}.${payload}`, secret);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof decoded !== "object" || decoded === null) return null;
  const obj = decoded as Record<string, unknown>;

  if (
    typeof obj.sub !== "string" ||
    typeof obj.exp !== "number" ||
    !Array.isArray(obj.roles) ||
    !obj.roles.every((role) => typeof role === "string")
  ) {
    return null;
  }

  const payloadObj = decoded as InternalTokenPayload;
  if (payloadObj.exp < Math.floor(Date.now() / 1000)) return null;
  return payloadObj;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/auth/internal-tokens.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/internal-tokens.ts __tests__/auth/internal-tokens.test.ts
git commit -m "feat: add Portal-to-SCS internal token signing and verification"
```

---

### Task 2: Extend the route index with each route's SCS base URL

**Files:**
- Modify: `src/rights/route-access.ts`
- Modify: `__tests__/rights/route-access.test.ts`

**Interfaces:**
- Consumes: nothing new (still only `ManifestEntry` from `src/scs/manifest-registry.ts`, unchanged).
- Produces (changed): `type RouteIndexEntry = { scsName: string; baseUrl: string; requiredRoles: string[] }` — adds `baseUrl` to the existing type. `buildRouteIndex` and `checkAccess` signatures are otherwise unchanged; `checkAccess`'s returned `RouteIndex` entries now also carry `baseUrl`, which Task 4 needs to know where to fetch a matched route's fragment from.

This is a breaking change to an already-merged type — every existing test asserting an exact `RouteIndexEntry` shape via `toEqual` must be updated to include `baseUrl`. The `entry()` test helper (already in the test file) synthesizes `baseUrl: http://${name}.local`, so the expected value in each updated assertion is derived from that same pattern.

- [ ] **Step 1: Update the production code**

In `src/rights/route-access.ts`, change the `RouteIndexEntry` type:
```ts
export type RouteIndexEntry = {
  scsName: string;
  baseUrl: string;
  requiredRoles: string[];
};
```

And in `buildRouteIndex`, change the line that populates a new index entry (inside the `else` branch of the `for (const route of entry.manifest.routes)` loop) from:
```ts
        routes.set(route.path, { scsName, requiredRoles: [...route.requiredRoles] });
```
to:
```ts
        routes.set(route.path, { scsName, baseUrl: entry.baseUrl, requiredRoles: [...route.requiredRoles] });
```

No other line in `buildRouteIndex` or `checkAccess` changes.

- [ ] **Step 2: Update the existing tests**

In `__tests__/rights/route-access.test.ts`, update these three `toEqual` assertions (all within `describe("buildRouteIndex", ...)`) to include `baseUrl`:

Replace:
```ts
    expect(index.routes.get("/orders")).toEqual({ scsName: "orders", requiredRoles: ["orders:viewer"] });
```
(appears at the end of the "indexes routes from a single SCS" test) with:
```ts
    expect(index.routes.get("/orders")).toEqual({
      scsName: "orders",
      baseUrl: "http://orders.local",
      requiredRoles: ["orders:viewer"],
    });
```

Replace the same line where it appears in the "includes a stale SCS's last-known-good routes" test with the identical replacement above (same expected values — the `entry()` helper always derives `baseUrl` from `name` the same way, and this test also uses `name: "orders"`).

Replace:
```ts
    expect(index.routes.get("/orders")).toEqual({ scsName: "orders", requiredRoles: ["orders:viewer"] });
```
at the end of the "does not treat one SCS declaring the same path twice as a collision" test with:
```ts
    expect(index.routes.get("/orders")).toEqual({
      scsName: "orders",
      baseUrl: "http://orders.local",
      requiredRoles: ["orders:viewer"],
    });
```

Do not change the "indexes routes from multiple SCSs with distinct paths" test — it only asserts `.scsName`, not a full object, so it's unaffected. Do not change any test in `describe("checkAccess", ...)` or `describe("integration: role storage + route enforcement", ...)` — none of them assert on `RouteIndexEntry`'s exact shape; they only assert on `AccessResult`, which is unaffected by this change.

- [ ] **Step 3: Run tests to verify they pass**

Run: `bun test __tests__/rights/route-access.test.ts`
Expected: PASS — all 16 existing tests in this file (8 `buildRouteIndex` + 7 `checkAccess` + 1 integration) still pass with the updated assertions.

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: PASS — no regressions anywhere else (nothing outside this file currently references `RouteIndexEntry`'s shape).

- [ ] **Step 5: Commit**

```bash
git add src/rights/route-access.ts __tests__/rights/route-access.test.ts
git commit -m "feat: add baseUrl to RouteIndexEntry so a matched route's SCS can be located"
```

---

### Task 3: Manifest registry gains a subscribable update hook

**Files:**
- Modify: `src/scs/manifest-registry.ts`
- Modify: `__tests__/scs/manifest-registry.test.ts`

**Interfaces:**
- Produces (changed): `type ManifestRegistry = { getManifests(): ManifestEntry[]; onUpdate(listener: () => void): () => void; stop(): void }` — adds an `onUpdate` subscribe method (returns an unsubscribe function) to the existing type. `createManifestRegistry`'s signature and `ManifestRegistryOptions` are unchanged.

**Design note:** a constructor-time `onUpdate` option (fire-once-per-refresh callback passed into `createManifestRegistry`'s options) cannot work for this plan's actual use case — Task 4's `createServer` receives an *already-constructed* `ManifestRegistry` via `ServerOptions`, so it needs to subscribe to future updates *after* construction, not supply a callback at construction time. A subscribable method on the returned object is the only shape that supports that. This does not change the underlying design decided during brainstorming (the registry notifies a caller when its data changes, so a cached route index gets rebuilt exactly when needed) — only the mechanism by which a caller connects to that notification.

- [ ] **Step 1: Write the failing test**

Add this test to `__tests__/scs/manifest-registry.test.ts`, inside the existing `describe("createManifestRegistry", ...)` block (add it anywhere among the other tests in that block — order doesn't matter):
```ts
  test("calls onUpdate listeners after each successful refresh, but not for the initial fetch", async () => {
    const scs = startFakeScs(() => new Response(JSON.stringify(validManifestJson), { status: 200 }));

    const registry = await createManifestRegistry([baseUrlOf(scs)], { refreshIntervalMs: 20 });
    registries.push(registry);

    let updateCount = 0;
    registry.onUpdate(() => {
      updateCount++;
    });

    expect(updateCount).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(updateCount).toBeGreaterThanOrEqual(2);
  });

  test("onUpdate's returned unsubscribe function stops further notifications", async () => {
    const scs = startFakeScs(() => new Response(JSON.stringify(validManifestJson), { status: 200 }));

    const registry = await createManifestRegistry([baseUrlOf(scs)], { refreshIntervalMs: 20 });
    registries.push(registry);

    let updateCount = 0;
    const unsubscribe = registry.onUpdate(() => {
      updateCount++;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(updateCount).toBeGreaterThanOrEqual(1);

    unsubscribe();
    const countAfterUnsubscribe = updateCount;

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(updateCount).toBe(countAfterUnsubscribe);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/scs/manifest-registry.test.ts`
Expected: FAIL — `registry.onUpdate` is not a function yet.

- [ ] **Step 3: Implement**

In `src/scs/manifest-registry.ts`, change the `ManifestRegistry` type:
```ts
export type ManifestRegistry = {
  getManifests(): ManifestEntry[];
  onUpdate(listener: () => void): () => void;
  stop(): void;
};
```

Inside `createManifestRegistry`, add a `listeners` set (declare it alongside the existing `const entries = new Map<string, ManifestEntry>();` line):
```ts
  const listeners = new Set<() => void>();
```

Change the `fetchAll` function to notify listeners after all fetches in that batch complete:
```ts
  async function fetchAll(): Promise<void> {
    await Promise.all(urls.map(fetchOne));
    for (const listener of listeners) listener();
  }
```

Add the `onUpdate` method to the returned object (alongside the existing `getManifests` and `stop` methods):
```ts
    onUpdate(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
```

The full returned object should now read:
```ts
  return {
    getManifests(): ManifestEntry[] {
      return urls.map((baseUrl) => entries.get(baseUrl)!);
    },
    onUpdate(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop(): void {
      clearInterval(timer);
    },
  };
```

No other line in the file changes. In particular, the initial `await fetchAll();` (which runs before `createManifestRegistry` returns, and therefore before any caller has had a chance to call `.onUpdate()`) correctly does not — and cannot — notify any listener for that first fetch; callers are expected to read `registry.getManifests()` directly once for their initial state, then use `onUpdate` only for subsequent changes. This is why the first new test asserts `updateCount` is `0` immediately after construction, before any refresh tick has happened.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/scs/manifest-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/scs/manifest-registry.ts __tests__/scs/manifest-registry.test.ts
git commit -m "feat: add a subscribable onUpdate hook to the manifest registry"
```

---

### Task 4: Wire authentication, enforcement, and fragment fetching into the server

**Files:**
- Modify: `src/server.ts`
- Test: `__tests__/server/composition.test.ts`

**Interfaces:**
- Consumes: `buildRouteIndex`, `checkAccess`, `type RouteIndex`, `type RouteIndexEntry` (Task 2, `src/rights/route-access.ts`); `getUserRoles` (existing, `src/rights/roles.ts`); `signInternalToken` (Task 1, `src/auth/internal-tokens.ts`); `type ManifestRegistry`, `createManifestRegistry`, `parseScsBaseUrls` (Task 3 for the type, otherwise pre-existing, `src/scs/manifest-registry.ts`); `getAuthenticatedUserId` (existing, `src/auth/middleware.ts`).
- Produces (changed): `ServerOptions` gains `manifestRegistry?: ManifestRegistry` and `internalTokenSecret?: string`. `createServer`'s behavior is additive: when `manifestRegistry` is not provided (every existing test), behavior is unchanged — falls through to the existing final `404`.

- [ ] **Step 1: Write the failing integration tests**

`__tests__/server/composition.test.ts`:
```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer } from "../../src/server";
import { createDatabase } from "../../src/db";
import { createManifestRegistry } from "../../src/scs/manifest-registry";
import { signAccessToken } from "../../src/auth/tokens";
import { verifyInternalToken } from "../../src/auth/internal-tokens";
import { assignRole } from "../../src/rights/roles";
import { findOrCreateUser } from "../../src/auth/users";

const ACCESS_SECRET = "access-secret";
const INTERNAL_SECRET = "internal-secret";

let fakeScs: ReturnType<typeof Bun.serve>;
let scsManifest: { name: string; routes: { path: string; requiredRoles: string[] }[]; nav: [] };
let receivedAuthHeader: string | null;
let receivedSearch: string = "";
let registry: Awaited<ReturnType<typeof createManifestRegistry>>;
let portal: ReturnType<typeof createServer>;
let db: ReturnType<typeof createDatabase>;
let userId: string;
let accessToken: string;

beforeEach(async () => {
  scsManifest = {
    name: "orders",
    routes: [{ path: "/orders", requiredRoles: ["orders:admin"] }],
    nav: [],
  };
  receivedAuthHeader = null;

  fakeScs = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.portal/manifest") {
        return new Response(JSON.stringify(scsManifest), { status: 200 });
      }
      if (url.pathname === "/orders") {
        receivedAuthHeader = req.headers.get("Authorization");
        receivedSearch = url.search;
        return new Response("orders fragment", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response("not found", { status: 404 });
    },
  });

  registry = await createManifestRegistry([fakeScs.url.toString().replace(/\/$/, "")], { refreshIntervalMs: 20 });

  db = createDatabase(":memory:");
  const user = findOrCreateUser(db, "github", { providerUserId: "1", email: null, displayName: null });
  userId = user.id;
  accessToken = signAccessToken(userId, ACCESS_SECRET);

  portal = createServer({
    port: 0,
    db,
    accessTokenSecret: ACCESS_SECRET,
    stateSecret: "state-secret",
    internalTokenSecret: INTERNAL_SECRET,
    manifestRegistry: registry,
  });
});

afterEach(() => {
  portal.stop();
  registry.stop();
  fakeScs.stop();
});

describe("route composition", () => {
  test("an unauthenticated request to an enforceable route returns 401", async () => {
    const response = await fetch(`${portal.url}orders`);
    expect(response.status).toBe(401);
  });

  test("an authenticated request without the required role returns a generic 403", async () => {
    const response = await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; requiredRoles?: unknown };
    expect(body.error).toBeTruthy();
    expect(body.requiredRoles).toBeUndefined();
  });

  test("an authenticated request with the required role fetches and forwards the SCS fragment", async () => {
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(await response.text()).toBe("orders fragment");

    expect(receivedAuthHeader).toMatch(/^Bearer /);
    const internalToken = receivedAuthHeader!.slice("Bearer ".length);
    const payload = verifyInternalToken(internalToken, INTERNAL_SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(userId);
    expect(payload!.roles).toEqual(["orders:admin"]);
  });

  test("roles from unrelated SCSs are not forwarded in the internal token", async () => {
    assignRole(db, userId, "orders:admin");
    assignRole(db, userId, "billing:admin");

    await fetch(`${portal.url}orders`, { headers: { Authorization: `Bearer ${accessToken}` } });

    const internalToken = receivedAuthHeader!.slice("Bearer ".length);
    const payload = verifyInternalToken(internalToken, INTERNAL_SECRET);
    expect(payload!.roles).toEqual(["orders:admin"]);
  });

  test("a path no manifest declares returns 404", async () => {
    const response = await fetch(`${portal.url}unknown`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(404);
  });

  test("a trailing slash on the request path is normalized before matching", async () => {
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}orders/`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
  });

  test("a query string doesn't affect route matching but is forwarded to the SCS", async () => {
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}orders?page=2`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    expect(receivedSearch).toBe("?page=2");
  });

  test("a public route (empty requiredRoles) is accessible to any authenticated user", async () => {
    scsManifest = { name: "orders", routes: [{ path: "/orders", requiredRoles: [] }], nav: [] };
    await new Promise((resolve) => setTimeout(resolve, 40));

    const response = await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
  });

  test("the cached route index reflects a manifest change after the registry refreshes", async () => {
    assignRole(db, userId, "orders:admin");
    const before = await fetch(`${portal.url}orders`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(before.status).toBe(200);

    scsManifest = { name: "orders", routes: [{ path: "/orders", requiredRoles: ["orders:superadmin"] }], nav: [] };
    await new Promise((resolve) => setTimeout(resolve, 40));

    const after = await fetch(`${portal.url}orders`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(after.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/server/composition.test.ts`
Expected: FAIL — `src/server.ts` doesn't accept `manifestRegistry`/`internalTokenSecret` options or serve any enforced route yet.

- [ ] **Step 3: Implement**

In `src/server.ts`, add these imports alongside the existing ones:
```ts
import { buildRouteIndex, checkAccess, type RouteIndex } from "./rights/route-access";
import { getUserRoles } from "./rights/roles";
import { signInternalToken } from "./auth/internal-tokens";
import { createManifestRegistry, parseScsBaseUrls, type ManifestRegistry } from "./scs/manifest-registry";
```

Add two fields to `ServerOptions`:
```ts
export type ServerOptions = {
  port?: number;
  db?: Database;
  providers?: Record<string, OAuthProviderConfig>;
  accessTokenSecret?: string;
  stateSecret?: string;
  internalTokenSecret?: string;
  baseUrl?: string;
  manifestRegistry?: ManifestRegistry;
};
```

Inside `createServer`, after the existing `const configuredBaseUrl = ...` line, add:
```ts
  const internalTokenSecret = resolveSecret(
    opts.internalTokenSecret,
    "INTERNAL_TOKEN_SECRET",
    "dev-internal-secret-change-me"
  );
  const manifestRegistry = opts.manifestRegistry;
  let routeIndex: RouteIndex = manifestRegistry
    ? buildRouteIndex(manifestRegistry.getManifests())
    : { routes: new Map(), collisions: [] };
  manifestRegistry?.onUpdate(() => {
    routeIndex = buildRouteIndex(manifestRegistry.getManifests());
  });
```

Inside the `fetch` handler, immediately before the final `return json({ error: "not found" }, 404);` line, add:
```ts
      if (manifestRegistry && req.method === "GET") {
        const normalizedPath = url.pathname === "/" ? url.pathname : url.pathname.replace(/\/+$/, "");
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        if (!userId) return json({ error: "unauthorized" }, 401);

        const userRoles = getUserRoles(db, userId);
        const result = checkAccess(routeIndex, normalizedPath, userRoles);

        if (result.status === "forbidden") {
          console.error(
            `forbidden: user ${userId} missing one of [${result.requiredRoles.join(", ")}] for ${normalizedPath}`
          );
          return json({ error: "forbidden" }, 403);
        }

        if (result.status === "allowed") {
          const route = routeIndex.routes.get(normalizedPath)!;
          const scsRoles = userRoles.filter((role) => role.startsWith(`${route.scsName}:`));
          const internalToken = signInternalToken(userId, scsRoles, internalTokenSecret);
          try {
            const fragmentResponse = await fetch(`${route.baseUrl}${normalizedPath}${url.search}`, {
              headers: { Authorization: `Bearer ${internalToken}` },
            });
            const body = await fragmentResponse.arrayBuffer();
            return new Response(body, {
              status: fragmentResponse.status,
              headers: {
                "Content-Type": fragmentResponse.headers.get("Content-Type") ?? "application/octet-stream",
              },
            });
          } catch (err) {
            console.error("scs fragment fetch failed", err);
            return json({ error: "scs fetch failed" }, 502);
          }
        }

        // result.status === "not_found": fall through to the 404 below.
      }

```

Finally, replace the existing production entrypoint block at the bottom of the file:
```ts
if (import.meta.main) {
  const server = createServer({ port: Number(process.env.PORT ?? 3000) });
  console.log(`Portal listening on ${server.url}`);
}
```
with:
```ts
if (import.meta.main) {
  const scsBaseUrls = parseScsBaseUrls(process.env.PORTAL_SCS_URLS);
  const manifestRegistry = scsBaseUrls.length > 0 ? await createManifestRegistry(scsBaseUrls) : undefined;
  const server = createServer({ port: Number(process.env.PORT ?? 3000), manifestRegistry });
  console.log(`Portal listening on ${server.url}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/server/composition.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS — all prior tests (including every existing `__tests__/server/*.test.ts` file, none of which pass a `manifestRegistry`, so their behavior must be completely unchanged) plus this task's new tests.

- [ ] **Step 6: Run the typecheck**

Run: `bunx tsc --noEmit`
Expected: clean, no output.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts __tests__/server/composition.test.ts
git commit -m "feat: wire authentication, route enforcement, and SCS fragment fetching into the server"
```
