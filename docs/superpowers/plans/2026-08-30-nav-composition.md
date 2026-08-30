# Nav Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Portal a role-filtered navigation menu, exposed at `GET /nav`, built from the manifest registry's current data — the last piece of the original architecture spec (login, route enforcement, SCS composition, nav) to be implemented. Bundled in: fix `GET /me`'s hardcoded `roles: []` to return the user's real roles now that `getUserRoles` exists.

**Architecture:** One new pure module, `src/rights/nav.ts`, mirroring `src/rights/route-access.ts`'s filtering logic but without route-access's collision detection (nav entries are display-only, not an enforcement target, so two SCSs contributing a nav entry for the same path is harmless). One small addition to `src/server.ts`: a `GET /nav` handler that authenticates, reads the manifest registry's current snapshot directly (no separate cache — `buildNav` is a cheap linear filter, unlike `buildRouteIndex`'s Map/collision-detection work, so there's no need to cache it the way the route index is cached and refreshed via `onUpdate`), and returns the filtered list.

**Tech Stack:** Bun runtime + `bun:test`, TypeScript. No new dependencies.

**Spec:** `specification.md` (Architecture → Context model → "This stage's nav model")

## Global Constraints

- Runtime and bundler is bun; TypeScript for frontend and backend-for-frontend. (`Claude.md`)
- Minimize external dependencies — ask before introducing a new one. (`Claude.md`, `specification.md`)
- Every feature needs a set of test cases, run via `bun:test`, files under `./__tests__`. (`Claude.md`)
- `GET /nav` returns the full role-filtered union of nav entries across every configured SCS — no domain/entity scoping this stage. (`specification.md`)
- Each returned entry is `{ label, path, domain }`, where `domain` is the owning SCS's manifest-declared `name`. (`specification.md`)
- An entry with empty `requiredRoles` is visible to any authenticated user; entries from a stale-but-previously-successful SCS remain visible — same rules as route enforcement. (`specification.md`)
- Nav entries are never collision-checked against each other, unlike routes — two SCSs contributing an entry for the same path is not an error. (`specification.md`)
- `GET /nav` requires authentication the same way `/me` does (401 if unauthenticated); when no `manifestRegistry` is configured, it still returns `200 { nav: [] }` rather than 404 — the endpoint always exists, it just has nothing to list.

---

### Task 1: Nav composition

**Files:**
- Create: `src/rights/nav.ts`
- Test: `__tests__/rights/nav.test.ts`

**Interfaces:**
- Consumes: `type ManifestEntry = { baseUrl: string; manifest: SCSManifest | null; stale: boolean; lastFetchedAt: number | null }` from `src/scs/manifest-registry.ts` (already exists, unmodified); `SCSManifest`'s `nav: NavEntry[]` field, where `NavEntry = { label: string; path: string; requiredRoles: string[] }`, from `src/scs/manifest.ts` (already exists, unmodified).
- Produces: `type NavItem = { label: string; path: string; domain: string }`, `buildNav(entries: ManifestEntry[], userRoles: string[]): NavItem[]` from `src/rights/nav.ts`.

- [ ] **Step 1: Write the failing tests**

`__tests__/rights/nav.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { buildNav } from "../../src/rights/nav";
import type { ManifestEntry } from "../../src/scs/manifest-registry";

function entry(
  name: string,
  nav: { label: string; path: string; requiredRoles: string[] }[],
  stale = false
): ManifestEntry {
  return {
    baseUrl: `http://${name}.local`,
    manifest: { name, routes: [], nav },
    stale,
    lastFetchedAt: stale ? null : Date.now(),
  };
}

function unreachableEntry(baseUrl: string): ManifestEntry {
  return { baseUrl, manifest: null, stale: true, lastFetchedAt: null };
}

describe("buildNav", () => {
  test("includes nav entries from multiple SCSs, tagged with their domain", () => {
    const nav = buildNav(
      [
        entry("orders", [{ label: "Orders", path: "/orders", requiredRoles: [] }]),
        entry("billing", [{ label: "Billing", path: "/billing", requiredRoles: [] }]),
      ],
      []
    );
    expect(nav).toEqual([
      { label: "Orders", path: "/orders", domain: "orders" },
      { label: "Billing", path: "/billing", domain: "billing" },
    ]);
  });

  test("includes an entry with empty requiredRoles regardless of the user's roles", () => {
    const nav = buildNav([entry("orders", [{ label: "Orders", path: "/orders", requiredRoles: [] }])], []);
    expect(nav).toEqual([{ label: "Orders", path: "/orders", domain: "orders" }]);
  });

  test("excludes an entry when the user holds none of its required roles", () => {
    const nav = buildNav(
      [entry("orders", [{ label: "Orders", path: "/orders", requiredRoles: ["orders:admin"] }])],
      ["billing:viewer"]
    );
    expect(nav).toEqual([]);
  });

  test("includes an entry when the user holds the required role", () => {
    const nav = buildNav(
      [entry("orders", [{ label: "Orders", path: "/orders", requiredRoles: ["orders:admin"] }])],
      ["orders:admin"]
    );
    expect(nav).toEqual([{ label: "Orders", path: "/orders", domain: "orders" }]);
  });

  test("includes an entry when the user holds at least one of several required roles", () => {
    const nav = buildNav(
      [
        entry("orders", [
          { label: "Orders", path: "/orders", requiredRoles: ["orders:viewer", "orders:admin"] },
        ]),
      ],
      ["orders:admin"]
    );
    expect(nav).toEqual([{ label: "Orders", path: "/orders", domain: "orders" }]);
  });

  test("skips an SCS with no manifest (never successfully fetched)", () => {
    const nav = buildNav([unreachableEntry("http://broken.local")], []);
    expect(nav).toEqual([]);
  });

  test("includes a stale SCS's last-known-good nav entries", () => {
    const nav = buildNav([entry("orders", [{ label: "Orders", path: "/orders", requiredRoles: [] }], true)], []);
    expect(nav).toEqual([{ label: "Orders", path: "/orders", domain: "orders" }]);
  });

  test("handles an SCS with an empty nav array", () => {
    const nav = buildNav([entry("orders", [])], []);
    expect(nav).toEqual([]);
  });

  test("returns an empty array for no entries", () => {
    expect(buildNav([], [])).toEqual([]);
  });

  test("does not exclude nav entries that share a path across different SCSs (no collision check, unlike routes)", () => {
    const nav = buildNav(
      [
        entry("orders", [{ label: "Orders Home", path: "/shared", requiredRoles: [] }]),
        entry("billing", [{ label: "Billing Home", path: "/shared", requiredRoles: [] }]),
      ],
      []
    );
    expect(nav).toEqual([
      { label: "Orders Home", path: "/shared", domain: "orders" },
      { label: "Billing Home", path: "/shared", domain: "billing" },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/rights/nav.test.ts`
Expected: FAIL — `src/rights/nav.ts` does not exist yet.

- [ ] **Step 3: Implement**

`src/rights/nav.ts`:
```ts
import type { ManifestEntry } from "../scs/manifest-registry";

export type NavItem = {
  label: string;
  path: string;
  domain: string;
};

export function buildNav(entries: ManifestEntry[], userRoles: string[]): NavItem[] {
  const nav: NavItem[] = [];
  for (const entry of entries) {
    if (!entry.manifest) continue;
    for (const item of entry.manifest.nav) {
      const visible = item.requiredRoles.length === 0 || item.requiredRoles.some((role) => userRoles.includes(role));
      if (visible) {
        nav.push({ label: item.label, path: item.path, domain: entry.manifest.name });
      }
    }
  }
  return nav;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/rights/nav.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rights/nav.ts __tests__/rights/nav.test.ts
git commit -m "feat: add role-filtered nav composition"
```

---

### Task 2: Wire GET /nav into the server, fix /me's roles stub

**Files:**
- Modify: `src/server.ts`
- Test: `__tests__/server/nav.test.ts`

**Interfaces:**
- Consumes: `buildNav` (Task 1, `src/rights/nav.ts`); `getUserRoles` (existing, `src/rights/roles.ts`); `getAuthenticatedUserId` (existing, `src/auth/middleware.ts`) — all already imported into `src/server.ts` except `buildNav`.
- Produces (changed): no new `ServerOptions` fields. `GET /nav` is a new route. `GET /me`'s response now includes real roles instead of a hardcoded `[]`.

- [ ] **Step 1: Write the failing tests**

`__tests__/server/nav.test.ts`:
```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer } from "../../src/server";
import { createDatabase } from "../../src/db";
import { createManifestRegistry } from "../../src/scs/manifest-registry";
import { signAccessToken } from "../../src/auth/tokens";
import { assignRole } from "../../src/rights/roles";
import { findOrCreateUser } from "../../src/auth/users";

const ACCESS_SECRET = "access-secret";

let fakeScs: ReturnType<typeof Bun.serve>;
let registry: Awaited<ReturnType<typeof createManifestRegistry>>;
let portal: ReturnType<typeof createServer>;
let db: ReturnType<typeof createDatabase>;
let userId: string;
let accessToken: string;

beforeEach(async () => {
  fakeScs = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.portal/manifest") {
        return new Response(
          JSON.stringify({
            name: "orders",
            routes: [],
            nav: [
              { label: "Orders Home", path: "/orders", requiredRoles: [] },
              { label: "Orders Admin", path: "/orders/admin", requiredRoles: ["orders:admin"] },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  registry = await createManifestRegistry([fakeScs.url.toString().replace(/\/$/, "")]);

  db = createDatabase(":memory:");
  const user = findOrCreateUser(db, "github", { providerUserId: "1", email: null, displayName: null });
  userId = user.id;
  accessToken = signAccessToken(userId, ACCESS_SECRET);

  portal = createServer({
    port: 0,
    db,
    accessTokenSecret: ACCESS_SECRET,
    stateSecret: "state-secret",
    internalTokenSecret: "internal-secret",
    manifestRegistry: registry,
  });
});

afterEach(() => {
  portal.stop();
  registry.stop();
  fakeScs.stop();
});

describe("GET /nav", () => {
  test("an unauthenticated request returns 401", async () => {
    const response = await fetch(`${portal.url}nav`);
    expect(response.status).toBe(401);
  });

  test("returns only the nav entries the user's roles satisfy", async () => {
    const response = await fetch(`${portal.url}nav`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { nav: { label: string; path: string; domain: string }[] };
    expect(body.nav).toEqual([{ label: "Orders Home", path: "/orders", domain: "orders" }]);
  });

  test("includes a role-gated entry once the user holds the required role", async () => {
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}nav`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json()) as { nav: { label: string; path: string; domain: string }[] };
    expect(body.nav).toEqual([
      { label: "Orders Home", path: "/orders", domain: "orders" },
      { label: "Orders Admin", path: "/orders/admin", domain: "orders" },
    ]);
  });
});

describe("GET /nav with no manifestRegistry configured", () => {
  test("returns an empty nav array rather than an error", async () => {
    const noRegistryPortal = createServer({
      port: 0,
      db: createDatabase(":memory:"),
      accessTokenSecret: ACCESS_SECRET,
      stateSecret: "state-secret",
    });
    try {
      const response = await fetch(`${noRegistryPortal.url}nav`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { nav: unknown[] };
      expect(body.nav).toEqual([]);
    } finally {
      noRegistryPortal.stop();
    }
  });
});

describe("GET /me", () => {
  test("returns the user's real roles instead of a hardcoded empty array", async () => {
    assignRole(db, userId, "orders:admin");
    assignRole(db, userId, "billing:viewer");

    const response = await fetch(`${portal.url}me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { roles: string[] };
    expect(body.roles.sort()).toEqual(["billing:viewer", "orders:admin"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/server/nav.test.ts`
Expected: FAIL — `src/server.ts` has no `/nav` route yet, and `/me` still returns a hardcoded `roles: []`.

- [ ] **Step 3: Implement**

In `src/server.ts`, add this import alongside the existing ones:
```ts
import { buildNav } from "./rights/nav";
```

Add a new route handler immediately after the existing `/me` block (after its closing `}`) and before the `if (manifestRegistry && req.method === "GET")` composition block:
```ts
      if (url.pathname === "/nav" && req.method === "GET") {
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        if (!userId) return json({ error: "unauthorized" }, 401);
        const userRoles = getUserRoles(db, userId);
        const nav = manifestRegistry ? buildNav(manifestRegistry.getManifests(), userRoles) : [];
        return json({ nav });
      }
```

Change the existing `/me` handler's final line from:
```ts
        return json({ ...row, roles: [] });
```
to:
```ts
        return json({ ...row, roles: getUserRoles(db, userId) });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/server/nav.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS — all prior tests plus this task's, no regressions. In particular, no existing test in `__tests__/server/auth-flow.test.ts` or `__tests__/server/composition.test.ts` should break — `/me`'s response gained real role data but no existing test asserts `roles` equals a hardcoded `[]` in a way that would now fail (the existing `/me` test in `auth-flow.test.ts` only checks `email`/`provider`/`roles` for a user with no roles assigned, so `getUserRoles` returning `[]` for that user is still correct).

- [ ] **Step 6: Run the typecheck**

Run: `bunx tsc --noEmit`
Expected: clean, no output.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts __tests__/server/nav.test.ts
git commit -m "feat: add GET /nav endpoint, return real roles from GET /me"
```
