# SCS Mutation Support (POST) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an SCS's manifest route declare `POST` (in addition to `GET`), and have Portal's existing data-fetch composition/proxy mechanism enforce and forward it — closing the previously-deferred "mutations aren't handled by this mechanism" gap, entirely server-side, with no `@portal/runtime` change.

**Architecture:** Each manifest route entry gains an optional `methods: string[]` field (default `["GET"]`, fully backward compatible with every manifest written before this stage). Portal's manifest parser validates it (non-empty, only `"GET"`/`"POST"`, and a route with a `component` must include `"GET"` — nothing could ever navigate to a page whose route doesn't respond to `GET`). The route index carries `methods` through unchanged. The server's data-fetch composition handler is broadened from a hardcoded `GET`-only gate to `GET`/`POST`, checks the resolved route's declared `methods` *before* the role check (so a wrong-method request can't be used to probe whether the caller holds the right role), and — for a `POST` — forwards the request body and `Content-Type` header to the SCS unmodified, the same "never interprets the payload" principle the response side already has. `@portal/runtime`'s `portalFetch` already forwards `method`/`body` transparently, so no client-runtime change is needed at all.

**Tech Stack:** Bun + `bun:test`, TypeScript. No new dependencies.

**Spec:** `specification.md` (Architecture → Request flow: the **Data fetch** paragraph; Architecture → SCS manifest contract: the `routes` bullet, the JSON example, and **Fetch and failure handling**; Architecture → Client shell: **Data endpoints**)

## Global Constraints

- `methods` is optional on a manifest route entry; when absent it defaults to `["GET"]`. Every manifest written before this stage keeps behaving exactly as it already did. (`specification.md`)
- Allowed values are exactly `"GET"` and `"POST"` — nothing else. `PUT`/`PATCH`/`DELETE` remain unsupported, matching the rest of Portal's own API (no `DELETE` verb anywhere in this codebase). (`specification.md`)
- A route entry with a `component` must include `"GET"` in its `methods` — rejected as a whole (same as any other malformed manifest) if it doesn't. (`specification.md`)
- One `requiredRoles` list governs every method declared on a given path — no per-method role granularity. An SCS wanting a stricter role for writes than reads uses two separate route entries at two different paths. (`specification.md`)
- The method check happens *before* the role check, so a request with the wrong method gets `405` without ever revealing whether the caller holds the right role for that path. (`specification.md`)
- For a `POST`, Portal forwards the request body and `Content-Type` header to the SCS unmodified. Portal never interprets the payload, on either side of the proxy. (`specification.md`)
- No new CSRF protection is needed: the composition model already relies on bearer-token authentication (not cookies), so a third-party page cannot forge a request carrying the browser's stored access token. (`specification.md`)
- No `@portal/runtime` / client-side change. `portalFetch` already forwards `method`/`body` transparently. (`specification.md`)
- Every feature needs a set of test cases, run via `bun:test`, files under `./__tests__`. (`CLAUDE.md`)

## File Structure

- `src/scs/manifest.ts` — **modify**: `RouteEntry` gains `methods: string[]`; `parseRouteEntry` parses/validates/defaults it.
- `src/rights/route-access.ts` — **modify**: `RouteIndexEntry` gains `methods: string[]`; `buildRouteIndex` copies it through. `checkAccess` is unchanged (stays role/path-only).
- `src/server.ts` — **modify**: the data-fetch composition block's method gate broadens to `GET`/`POST`; a method check runs before the role check; the SCS proxy fetch forwards `method`, `body` (for `POST`), and `Content-Type`.
- Test files: extend `__tests__/scs/manifest.test.ts`, `__tests__/scs/manifest-registry.test.ts`, `__tests__/rights/route-access.test.ts`, `__tests__/server/composition.test.ts`.

---

### Task 1: `methods` field in manifest parsing

**Files:**
- Modify: `src/scs/manifest.ts`
- Test: extend `__tests__/scs/manifest.test.ts`, modify `__tests__/scs/manifest-registry.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RouteEntry.methods: string[]` — always present after parsing (defaulted to `["GET"]` if the raw JSON omitted it). Task 2 reads this field.

- [ ] **Step 1: Write the failing tests**

In `__tests__/scs/manifest.test.ts`, add this new `describe` block (anywhere after the existing `describe("route component field", ...)` block, before `describe("publishesContext / consumesContext fields", ...)`):

```ts
describe("methods field", () => {
  test('defaults to ["GET"] when absent', () => {
    const manifest = parseManifest({ name: "orders", routes: [{ path: "/orders", requiredRoles: [] }], nav: [] });
    expect(manifest?.routes[0].methods).toEqual(["GET"]);
  });

  test("accepts an explicit methods list", () => {
    const manifest = parseManifest({
      name: "orders",
      routes: [{ path: "/orders/create", requiredRoles: ["orders:editor"], methods: ["POST"] }],
      nav: [],
    });
    expect(manifest?.routes[0].methods).toEqual(["POST"]);
  });

  test("accepts a route declaring both GET and POST", () => {
    const manifest = parseManifest({
      name: "orders",
      routes: [{ path: "/orders", requiredRoles: [], methods: ["GET", "POST"], component: "OrdersView" }],
      nav: [],
    });
    expect(manifest?.routes[0].methods).toEqual(["GET", "POST"]);
  });

  test("rejects a non-string-array methods field", () => {
    expect(
      parseManifest({ name: "orders", routes: [{ path: "/orders", requiredRoles: [], methods: "GET" }], nav: [] })
    ).toBeNull();
  });

  test("rejects an empty methods array", () => {
    expect(
      parseManifest({ name: "orders", routes: [{ path: "/orders", requiredRoles: [], methods: [] }], nav: [] })
    ).toBeNull();
  });

  test("rejects a method outside GET/POST", () => {
    expect(
      parseManifest({
        name: "orders",
        routes: [{ path: "/orders", requiredRoles: [], methods: ["DELETE"] }],
        nav: [],
      })
    ).toBeNull();
  });

  test("rejects a component on a route that doesn't declare GET", () => {
    expect(
      parseManifest({
        name: "orders",
        routes: [{ path: "/orders", requiredRoles: [], methods: ["POST"], component: "OrdersView" }],
        nav: [],
      })
    ).toBeNull();
  });

  test("accepts a POST-only route without a component (pure mutation endpoint)", () => {
    const manifest = parseManifest({
      name: "orders",
      routes: [{ path: "/orders/create", requiredRoles: ["orders:editor"], methods: ["POST"] }],
      nav: [],
    });
    expect(manifest?.routes[0]).toEqual({
      path: "/orders/create",
      requiredRoles: ["orders:editor"],
      methods: ["POST"],
    });
  });
});
```

Also update these three **existing** tests in the same file — each currently expects a route object without `methods`, which will now always be present:

In `describe("parseManifest", ...)`, the `"parses a valid manifest"` test currently reads:

```ts
  test("parses a valid manifest", () => {
    const manifest = parseManifest({
      name: "orders",
      routes: [{ path: "/orders", requiredRoles: ["orders:viewer"] }],
      nav: [{ label: "Orders", path: "/orders", requiredRoles: ["orders:viewer"] }],
    });
    expect(manifest).toEqual({
      name: "orders",
      routes: [{ path: "/orders", requiredRoles: ["orders:viewer"] }],
      nav: [{ label: "Orders", path: "/orders", requiredRoles: ["orders:viewer"] }],
      publishesContext: [],
      consumesContext: [],
    });
  });
```

Change the `expect(manifest).toEqual(...)` block's `routes` line to:

```ts
      routes: [{ path: "/orders", requiredRoles: ["orders:viewer"], methods: ["GET"] }],
```

(leave everything else in that test unchanged — the input `parseManifest({...})` call's `routes` line does NOT need `methods` added, since this is exactly what proves the default applies).

In `describe("route component field", ...)`, the `"accepts a route with a component name"` test currently has:

```ts
    expect(manifest?.routes[0]).toEqual({ path: "/orders", requiredRoles: [], component: "OrdersView" });
```

Change to:

```ts
    expect(manifest?.routes[0]).toEqual({ path: "/orders", requiredRoles: [], methods: ["GET"], component: "OrdersView" });
```

In the same `describe` block, the `"omits component when absent (data-only route)"` test currently has:

```ts
    expect(manifest?.routes[0]).toEqual({ path: "/orders/summary", requiredRoles: [] });
```

Change to:

```ts
    expect(manifest?.routes[0]).toEqual({ path: "/orders/summary", requiredRoles: [], methods: ["GET"] });
```

In `__tests__/scs/manifest-registry.test.ts`, `validManifestJson` currently reads:

```ts
const validManifestJson = {
  name: "orders",
  routes: [{ path: "/orders", requiredRoles: ["orders:viewer"] }],
  nav: [{ label: "Orders", path: "/orders", requiredRoles: ["orders:viewer"] }],
  publishesContext: [] as string[],
  consumesContext: [] as string[],
};
```

Change the `routes` line to:

```ts
  routes: [{ path: "/orders", requiredRoles: ["orders:viewer"], methods: ["GET"] }],
```

(This object is served as the fake SCS's raw manifest JSON *and* compared against the parsed result — since `parseManifest` now always adds `methods`, the raw JSON needs to already carry it so both sides of the comparison match.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test __tests__/scs/manifest.test.ts __tests__/scs/manifest-registry.test.ts`
Expected: FAIL — `methods` doesn't exist on `RouteEntry` yet, so the new tests fail and the three modified `toEqual`s don't match the current (unmodified) parser's output.

- [ ] **Step 3: Implement `methods` parsing**

In `src/scs/manifest.ts`, replace:

```ts
export type RouteEntry = {
  path: string;
  requiredRoles: string[];
  component?: string;
};
```

with:

```ts
export type RouteEntry = {
  path: string;
  requiredRoles: string[];
  methods: string[];
  component?: string;
};

const ALLOWED_METHODS = new Set(["GET", "POST"]);
```

Replace:

```ts
function parseRouteEntry(value: unknown): RouteEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== "string" || !isStringArray(obj.requiredRoles)) return null;
  if (obj.component !== undefined && typeof obj.component !== "string") return null;
  return {
    path: obj.path,
    requiredRoles: obj.requiredRoles,
    ...(typeof obj.component === "string" ? { component: obj.component } : {}),
  };
}
```

with:

```ts
function parseRouteEntry(value: unknown): RouteEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== "string" || !isStringArray(obj.requiredRoles)) return null;
  if (obj.component !== undefined && typeof obj.component !== "string") return null;

  let methods = ["GET"];
  if (obj.methods !== undefined) {
    if (!isStringArray(obj.methods) || obj.methods.length === 0) return null;
    if (!obj.methods.every((method) => ALLOWED_METHODS.has(method))) return null;
    methods = obj.methods;
  }
  // A route with a component is meant to be mounted as a page, and a page is
  // only ever reached via a real browser GET navigation — a route that can't
  // answer GET could never be navigated to.
  if (typeof obj.component === "string" && !methods.includes("GET")) return null;

  return {
    path: obj.path,
    requiredRoles: obj.requiredRoles,
    methods,
    ...(typeof obj.component === "string" ? { component: obj.component } : {}),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test __tests__/scs/manifest.test.ts __tests__/scs/manifest-registry.test.ts`
Expected: PASS, all tests in both files.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, no errors. (Other test files that construct `RouteEntry`/`ManifestEntry` fixtures directly — `__tests__/rights/route-access.test.ts`, `__tests__/server/composition.test.ts` — will fail typecheck or specific assertions at this point; that's expected and is Task 2/Task 3's job to fix, not this task's.)

- [ ] **Step 6: Commit**

```bash
git add src/scs/manifest.ts __tests__/scs/manifest.test.ts __tests__/scs/manifest-registry.test.ts
git commit -m "feat: parse and validate a manifest route's methods field"
```

---

### Task 2: `methods` in the route index

**Files:**
- Modify: `src/rights/route-access.ts`
- Test: modify `__tests__/rights/route-access.test.ts`

**Interfaces:**
- Consumes: `RouteEntry.methods` (Task 1).
- Produces: `RouteIndexEntry.methods: string[]` — always present, copied straight through from the manifest route entry. Task 3 reads this field.

- [ ] **Step 1: Update the test fixtures and write the failing tests**

In `__tests__/rights/route-access.test.ts`, replace the `entry` helper:

```ts
function entry(name: string, routes: { path: string; requiredRoles: string[] }[], stale = false): ManifestEntry {
  return {
    baseUrl: `http://${name}.local`,
    manifest: { name, routes, nav: [], publishesContext: [], consumesContext: [] },
    stale,
    lastFetchedAt: stale ? null : Date.now(),
  };
}
```

with:

```ts
function entry(
  name: string,
  routes: { path: string; requiredRoles: string[]; methods?: string[] }[],
  stale = false
): ManifestEntry {
  return {
    baseUrl: `http://${name}.local`,
    manifest: {
      name,
      routes: routes.map((route) => ({ ...route, methods: route.methods ?? ["GET"] })),
      nav: [],
      publishesContext: [],
      consumesContext: [],
    },
    stale,
    lastFetchedAt: stale ? null : Date.now(),
  };
}
```

(This keeps every existing `entry("orders", [{ path: ..., requiredRoles: ... }])` call site working unchanged — `methods` is optional there and defaults to `["GET"]` internally.)

Update the three `toEqual` assertions on `index.routes.get(...)` — each currently omits `methods` from the expected object. The `"indexes routes from a single SCS"` test:

```ts
    expect(index.routes.get("/orders")).toEqual({
      scsName: "orders",
      baseUrl: "http://orders.local",
      requiredRoles: ["orders:viewer"],
    });
```

becomes:

```ts
    expect(index.routes.get("/orders")).toEqual({
      scsName: "orders",
      baseUrl: "http://orders.local",
      requiredRoles: ["orders:viewer"],
      methods: ["GET"],
    });
```

The `"includes a stale SCS's last-known-good routes"` test has the identical shape — apply the identical change (add `methods: ["GET"],` after `requiredRoles: ["orders:viewer"],`).

The `"does not treat one SCS declaring the same path twice as a collision"` test has the identical shape too — apply the identical change there as well.

Update the two inline (non-`entry()`-helper) `ManifestEntry` constructions. The `"propagates a route's component name into the index"` test currently has:

```ts
          routes: [{ path: "/orders", requiredRoles: [], component: "OrdersView" }],
```

Change to:

```ts
          routes: [{ path: "/orders", requiredRoles: [], methods: ["GET"], component: "OrdersView" }],
```

The `"omits component from the index for a data-only route"` test currently has:

```ts
          routes: [{ path: "/orders/summary", requiredRoles: [] }],
```

Change to:

```ts
          routes: [{ path: "/orders/summary", requiredRoles: [], methods: ["GET"] }],
```

Add two new tests at the end of the `describe("buildRouteIndex", ...)` block (after `"omits component from the index for a data-only route"`, before its closing `});`):

```ts

  test("propagates a route's declared methods into the index", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders/create", requiredRoles: ["orders:editor"], methods: ["POST"] }]),
    ]);
    expect(index.routes.get("/orders/create")?.methods).toEqual(["POST"]);
  });

  test("defaults a route's methods to [\"GET\"] in the index when the manifest omitted it", () => {
    const index = buildRouteIndex([entry("orders", [{ path: "/orders", requiredRoles: [] }])]);
    expect(index.routes.get("/orders")?.methods).toEqual(["GET"]);
  });
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `bun test __tests__/rights/route-access.test.ts`
Expected: FAIL — `RouteIndexEntry` doesn't have `methods` yet, so the updated `toEqual`s and the two new tests fail.

- [ ] **Step 3: Implement `methods` in the route index**

In `src/rights/route-access.ts`, replace:

```ts
export type RouteIndexEntry = {
  scsName: string;
  baseUrl: string;
  requiredRoles: string[];
  component?: string;
};
```

with:

```ts
export type RouteIndexEntry = {
  scsName: string;
  baseUrl: string;
  requiredRoles: string[];
  methods: string[];
  component?: string;
};
```

Replace:

```ts
        routes.set(route.path, {
          scsName,
          baseUrl: entry.baseUrl,
          requiredRoles: [...route.requiredRoles],
          ...(route.component ? { component: route.component } : {}),
        });
```

with:

```ts
        routes.set(route.path, {
          scsName,
          baseUrl: entry.baseUrl,
          requiredRoles: [...route.requiredRoles],
          methods: [...route.methods],
          ...(route.component ? { component: route.component } : {}),
        });
```

`checkAccess` itself needs no change — it stays role/path-only; Task 3 does the method check separately in `server.ts`, before calling `checkAccess`.

- [ ] **Step 4: Run the test file to verify it passes**

Run: `bun test __tests__/rights/route-access.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, no errors. (`__tests__/server/composition.test.ts` will still fail — that's Task 3's job.)

- [ ] **Step 6: Commit**

```bash
git add src/rights/route-access.ts __tests__/rights/route-access.test.ts
git commit -m "feat: carry a route's declared methods into the route index"
```

---

### Task 3: Server-side method enforcement, 405, and POST body forwarding

**Files:**
- Modify: `src/server.ts`
- Test: modify `__tests__/server/composition.test.ts`

**Interfaces:**
- Consumes: `RouteIndexEntry.methods` (Task 2).
- Produces: `GET`/`POST` requests to a manifest-declared route are both composed (role-checked, proxied to the SCS with the internal token, body/`Content-Type` forwarded for `POST`); a request whose method isn't in that route's declared `methods` gets `405`.

- [ ] **Step 1: Update the test fixture and write the failing tests**

In `__tests__/server/composition.test.ts`, the shared `scsManifest` type (near the top of the file) currently reads:

```ts
let scsManifest: {
  name: string;
  routes: { path: string; requiredRoles: string[]; component?: string }[];
  nav: [];
  publishesContext?: string[];
};
```

Change to:

```ts
let scsManifest: {
  name: string;
  routes: { path: string; requiredRoles: string[]; methods?: string[]; component?: string }[];
  nav: [];
  publishesContext?: string[];
};
```

Leave the `beforeEach`'s `scsManifest` initialization exactly as it is — do NOT add a second route entry there. Adding one permanently would change what every other test in this file (including `describe("GET /routes", ...)`'s `"an authenticated request returns the full table, unfiltered by the caller's roles"`, which asserts `body.routes` equals a single-element array) sees, breaking tests unrelated to this task. Instead, each new POST test below locally reassigns `scsManifest` for just that test — the same pattern this file's `"includes the component name when the manifest declares one"` test (further down, in `describe("GET /routes", ...)`) already uses: reassign `scsManifest`, then `await new Promise((resolve) => setTimeout(resolve, 40))` to let the registry's periodic refresh (`refreshIntervalMs: 20`, configured in this file's own `beforeEach`) pick up the change before making a request.

In the `beforeEach`, the fake SCS's `fetch` handler currently has a branch for `/orders`:

```ts
      if (url.pathname === "/orders") {
        receivedAuthHeader = req.headers.get("Authorization");
        receivedSearch = url.search;
        if (ordersRedirectTo) {
          return new Response(null, { status: 302, headers: { Location: ordersRedirectTo } });
        }
        return new Response("orders fragment", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
```

Add a new branch right after it, for the new `/orders/create` route, that echoes back what it received so tests can verify forwarding:

```ts
      if (url.pathname === "/orders/create" && req.method === "POST") {
        receivedAuthHeader = req.headers.get("Authorization");
        const receivedBody = await req.text();
        return new Response(
          JSON.stringify({
            receivedMethod: req.method,
            receivedBody,
            receivedContentType: req.headers.get("Content-Type"),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
```

(The enclosing `fetch(req)` handler is already `async` — it uses `await` elsewhere in this file for other branches, so `await req.text()` here is valid without further changes.)

Add a new `describe` block at the end of the file (after the existing `describe("route composition", ...)` block's closing `});`):

```ts

describe("route composition: POST (mutations)", () => {
  async function addOrdersCreateRoute() {
    scsManifest = {
      name: "orders",
      routes: [
        { path: "/orders", requiredRoles: ["orders:admin"] },
        { path: "/orders/create", requiredRoles: ["orders:admin"], methods: ["POST"] },
      ],
      nav: [],
    };
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  test("a POST to a route declaring methods: [\"POST\"] is composed, forwarding the body and Content-Type to the SCS", async () => {
    await addOrdersCreateRoute();
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}orders/create`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ item: "widget" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { receivedMethod: string; receivedBody: string; receivedContentType: string | null };
    expect(body.receivedMethod).toBe("POST");
    expect(body.receivedBody).toBe(JSON.stringify({ item: "widget" }));
    expect(body.receivedContentType).toBe("application/json");
    expect(receivedAuthHeader).toMatch(/^Bearer /);
  });

  test("a POST to a route that only declares GET returns 405", async () => {
    await addOrdersCreateRoute();
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });

    expect(response.status).toBe(405);
  });

  test("a GET to a route that only declares POST returns 405", async () => {
    await addOrdersCreateRoute();
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}orders/create`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });

    expect(response.status).toBe(405);
  });

  test("a POST to an enforceable route the caller lacks the role for still returns a generic 403", async () => {
    await addOrdersCreateRoute();

    const response = await fetch(`${portal.url}orders/create`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
      body: JSON.stringify({ item: "widget" }),
    });

    expect(response.status).toBe(403);
  });

  test("an unauthenticated POST to an enforceable route returns 401, not 405", async () => {
    await addOrdersCreateRoute();

    const response = await fetch(`${portal.url}orders/create`, {
      method: "POST",
      headers: { "X-Portal-Data": "1" },
      body: JSON.stringify({ item: "widget" }),
    });

    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `bun test __tests__/server/composition.test.ts`
Expected: FAIL — `server.ts`'s composition block still only accepts `GET`, so every new POST-based test gets a `404` instead of the expected status (`405`/`201`/`403`/`401`). Pre-existing tests in this file are unaffected by this step alone (the fixture type change and the fake server's new branch are both additive and inert until a test actually opts into the `/orders/create` route).

- [ ] **Step 3: Implement method enforcement and POST forwarding**

In `src/server.ts`, replace:

```ts
      if (manifestRegistry && req.method === "GET") {
        // Bind the current value of routeIndex to a local const so both reads
        // below are guaranteed to see the same snapshot, regardless of any
        // future edit that adds an `await` between them.
        const index = routeIndex;
        const normalizedPath = url.pathname === "/" ? url.pathname : url.pathname.replace(/\/+$/, "");
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        if (!userId) return json({ error: "unauthorized" }, 401);

        const userRoles = getUserRoles(db, userId);
        const result = checkAccess(index, normalizedPath, userRoles);
```

with:

```ts
      if (manifestRegistry && (req.method === "GET" || req.method === "POST")) {
        // Bind the current value of routeIndex to a local const so both reads
        // below are guaranteed to see the same snapshot, regardless of any
        // future edit that adds an `await` between them.
        const index = routeIndex;
        const normalizedPath = url.pathname === "/" ? url.pathname : url.pathname.replace(/\/+$/, "");
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        if (!userId) return json({ error: "unauthorized" }, 401);

        // Checked before the role check below, so a wrong-method request
        // never leaks whether the caller would otherwise have held the
        // right role for this path (specification.md, Request flow). A path
        // the index doesn't know at all falls through to checkAccess's own
        // not_found below, unchanged.
        const declaredRoute = index.routes.get(normalizedPath);
        if (declaredRoute && !declaredRoute.methods.includes(req.method)) {
          return json({ error: "method not allowed" }, 405);
        }

        const userRoles = getUserRoles(db, userId);
        const result = checkAccess(index, normalizedPath, userRoles);
```

Then replace the SCS proxy fetch:

```ts
          const internalToken = signInternalToken(userId, scsRoles, route.baseUrl, internalTokenSecret!);
          try {
            const fragmentResponse = await fetch(`${route.baseUrl}${normalizedPath}${url.search}`, {
              headers: { Authorization: `Bearer ${internalToken}` },
              redirect: "manual",
              signal: AbortSignal.timeout(10_000),
            });
```

with:

```ts
          const internalToken = signInternalToken(userId, scsRoles, route.baseUrl, internalTokenSecret!);
          try {
            const contentType = req.headers.get("Content-Type");
            const fragmentResponse = await fetch(`${route.baseUrl}${normalizedPath}${url.search}`, {
              method: req.method,
              headers: {
                Authorization: `Bearer ${internalToken}`,
                ...(contentType ? { "Content-Type": contentType } : {}),
              },
              body: req.method === "POST" ? await req.arrayBuffer() : undefined,
              redirect: "manual",
              signal: AbortSignal.timeout(10_000),
            });
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `bun test __tests__/server/composition.test.ts`
Expected: PASS, all tests (both the 5 new ones and every pre-existing test in the file).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, no errors — every task's changes are now in place.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts __tests__/server/composition.test.ts
git commit -m "feat: compose POST requests through the SCS data-fetch proxy"
```
