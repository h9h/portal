# Route Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Portal the two pieces route enforcement needs: storage for user→role assignments, and a pure function that decides whether a given user may access a given route path, based on the manifest registry's current data. This slice does not wire into the HTTP server — no admin API to assign roles, no route handler that calls this at request time. Both are future work built on top of this.

**Architecture:** Three small modules. `src/rights/roles.ts` is a thin sqlite-backed CRUD layer over a new `user_roles` table (mirrors the existing pattern in `src/auth/users.ts`). `src/rights/route-access.ts` is pure, no I/O: `buildRouteIndex` turns the manifest registry's current snapshot into a flat path→route lookup (detecting cross-SCS path collisions along the way), and `checkAccess` decides allowed/not-found/forbidden for a path and a set of user roles against that index.

**Tech Stack:** Bun runtime + `bun:test`, `bun:sqlite`, TypeScript. No new dependencies.

**Spec:** `specification.md` (Architecture → Identity, sessions, and rights → Roles, Route enforcement)

## Global Constraints

- Runtime and bundler is bun; TypeScript for frontend and backend-for-frontend. (`Claude.md`)
- Minimize external dependencies — ask before introducing a new one. (`Claude.md`, `specification.md`)
- Every feature needs a set of test cases, run via `bun:test`, files under `./__tests__`. (`Claude.md`)
- Use bun's own functionality before reaching for other libraries. (`Claude.md`)
- Roles are namespaced per SCS as flat strings (e.g. `orders:admin`); Portal stores assignments but does not define role meaning. (`specification.md`)
- Route matching is exact-path only for this stage — no params, no prefixes. (`specification.md`)
- A route declaring `"requiredRoles": []` is public — any authenticated user may access it. (`specification.md`)
- The route index is built from every SCS with a manifest, including stale entries (last-known-good routes remain enforceable). (`specification.md`)
- If two different SCSs declare the same route path, that path is excluded from the enforceable index (resolves not-found) and the collision is reported separately, never silently resolved by picking a winner. (`specification.md`)

---

### Task 1: Role storage

**Files:**
- Modify: `src/db.ts`
- Create: `src/rights/roles.ts`
- Test: `__tests__/rights/roles.test.ts`

**Interfaces:**
- Consumes: `Database` from `bun:sqlite` (already used throughout the codebase).
- Produces: `assignRole(db: Database, userId: string, role: string): void`, `revokeRole(db: Database, userId: string, role: string): void`, `getUserRoles(db: Database, userId: string): string[]` from `src/rights/roles.ts`.

- [ ] **Step 1: Write the failing tests**

`__tests__/rights/roles.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { createDatabase } from "../../src/db";
import { assignRole, revokeRole, getUserRoles } from "../../src/rights/roles";

describe("role storage", () => {
  test("a newly created user has no roles", () => {
    const db = createDatabase(":memory:");
    expect(getUserRoles(db, "user-1")).toEqual([]);
  });

  test("assigning a role makes it show up in getUserRoles", () => {
    const db = createDatabase(":memory:");
    assignRole(db, "user-1", "orders:admin");
    expect(getUserRoles(db, "user-1")).toEqual(["orders:admin"]);
  });

  test("assigning the same role twice is idempotent", () => {
    const db = createDatabase(":memory:");
    assignRole(db, "user-1", "orders:admin");
    assignRole(db, "user-1", "orders:admin");
    expect(getUserRoles(db, "user-1")).toEqual(["orders:admin"]);
  });

  test("a user can hold multiple roles", () => {
    const db = createDatabase(":memory:");
    assignRole(db, "user-1", "orders:admin");
    assignRole(db, "user-1", "billing:viewer");
    expect(getUserRoles(db, "user-1").sort()).toEqual(["billing:viewer", "orders:admin"]);
  });

  test("revoking a role removes it", () => {
    const db = createDatabase(":memory:");
    assignRole(db, "user-1", "orders:admin");
    revokeRole(db, "user-1", "orders:admin");
    expect(getUserRoles(db, "user-1")).toEqual([]);
  });

  test("revoking a role the user doesn't have is a no-op", () => {
    const db = createDatabase(":memory:");
    expect(() => revokeRole(db, "user-1", "orders:admin")).not.toThrow();
    expect(getUserRoles(db, "user-1")).toEqual([]);
  });

  test("roles are scoped per user", () => {
    const db = createDatabase(":memory:");
    assignRole(db, "user-1", "orders:admin");
    expect(getUserRoles(db, "user-2")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/rights/roles.test.ts`
Expected: FAIL — `src/rights/roles.ts` does not exist yet, and `src/db.ts` has no `user_roles` table.

- [ ] **Step 3: Implement**

Modify `src/db.ts` by adding a third `db.exec(...)` call, after the existing `refresh_tokens` table creation and before the `return db;` line:
```ts
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (user_id, role)
    );
  `);
```

Create `src/rights/roles.ts`:
```ts
import { Database } from "bun:sqlite";

export function assignRole(db: Database, userId: string, role: string): void {
  db.query(`INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)`).run(userId, role);
}

export function revokeRole(db: Database, userId: string, role: string): void {
  db.query(`DELETE FROM user_roles WHERE user_id = ? AND role = ?`).run(userId, role);
}

export function getUserRoles(db: Database, userId: string): string[] {
  const rows = db.query(`SELECT role FROM user_roles WHERE user_id = ?`).all(userId) as { role: string }[];
  return rows.map((row) => row.role);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/rights/roles.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS — all prior tests plus this task's, no regressions (the `user_roles` table addition to `createDatabase` must not break any existing test that calls it).

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/rights/roles.ts __tests__/rights/roles.test.ts
git commit -m "feat: add user role storage"
```

---

### Task 2: Route index

**Files:**
- Create: `src/rights/route-access.ts`
- Test: `__tests__/rights/route-access.test.ts`

**Interfaces:**
- Consumes: `type ManifestEntry = { baseUrl: string; manifest: SCSManifest | null; stale: boolean; lastFetchedAt: number | null }` from `src/scs/manifest-registry.ts`; `type SCSManifest = { name: string; routes: RouteEntry[]; nav: NavEntry[] }` and `type RouteEntry = { path: string; requiredRoles: string[] }` from `src/scs/manifest.ts` (both already exist, unmodified).
- Produces: `type RouteIndexEntry = { scsName: string; requiredRoles: string[] }`, `type RouteCollision = { path: string; scsNames: string[] }`, `type RouteIndex = { routes: Map<string, RouteIndexEntry>; collisions: RouteCollision[] }`, `buildRouteIndex(entries: ManifestEntry[]): RouteIndex` from `src/rights/route-access.ts`.

- [ ] **Step 1: Write the failing tests**

`__tests__/rights/route-access.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { buildRouteIndex } from "../../src/rights/route-access";
import type { ManifestEntry } from "../../src/scs/manifest-registry";

function entry(name: string, routes: { path: string; requiredRoles: string[] }[], stale = false): ManifestEntry {
  return {
    baseUrl: `http://${name}.local`,
    manifest: { name, routes, nav: [] },
    stale,
    lastFetchedAt: stale ? null : Date.now(),
  };
}

function unreachableEntry(baseUrl: string): ManifestEntry {
  return { baseUrl, manifest: null, stale: true, lastFetchedAt: null };
}

describe("buildRouteIndex", () => {
  test("indexes routes from a single SCS", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: ["orders:viewer"] }]),
    ]);
    expect(index.routes.get("/orders")).toEqual({ scsName: "orders", requiredRoles: ["orders:viewer"] });
    expect(index.collisions).toEqual([]);
  });

  test("indexes routes from multiple SCSs with distinct paths", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: [] }]),
      entry("billing", [{ path: "/billing", requiredRoles: [] }]),
    ]);
    expect(index.routes.get("/orders")?.scsName).toBe("orders");
    expect(index.routes.get("/billing")?.scsName).toBe("billing");
    expect(index.collisions).toEqual([]);
  });

  test("excludes a colliding path from the index and reports the collision", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/shared", requiredRoles: [] }]),
      entry("billing", [{ path: "/shared", requiredRoles: [] }]),
    ]);
    expect(index.routes.has("/shared")).toBe(false);
    expect(index.collisions).toEqual([{ path: "/shared", scsNames: ["billing", "orders"] }]);
  });

  test("skips an SCS with no manifest (never successfully fetched)", () => {
    const index = buildRouteIndex([unreachableEntry("http://broken.local")]);
    expect(index.routes.size).toBe(0);
    expect(index.collisions).toEqual([]);
  });

  test("includes a stale SCS's last-known-good routes", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: ["orders:viewer"] }], true),
    ]);
    expect(index.routes.get("/orders")).toEqual({ scsName: "orders", requiredRoles: ["orders:viewer"] });
  });

  test("handles an SCS with an empty routes array", () => {
    const index = buildRouteIndex([entry("orders", [])]);
    expect(index.routes.size).toBe(0);
    expect(index.collisions).toEqual([]);
  });

  test("returns an empty index for no entries", () => {
    const index = buildRouteIndex([]);
    expect(index.routes.size).toBe(0);
    expect(index.collisions).toEqual([]);
  });

  test("does not treat one SCS declaring the same path twice as a collision", () => {
    const index = buildRouteIndex([
      entry("orders", [
        { path: "/orders", requiredRoles: ["orders:viewer"] },
        { path: "/orders", requiredRoles: ["orders:admin"] },
      ]),
    ]);
    expect(index.collisions).toEqual([]);
    expect(index.routes.get("/orders")).toEqual({ scsName: "orders", requiredRoles: ["orders:viewer"] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/rights/route-access.test.ts`
Expected: FAIL — `src/rights/route-access.ts` does not exist yet.

- [ ] **Step 3: Implement**

`src/rights/route-access.ts`:
```ts
import type { ManifestEntry } from "../scs/manifest-registry";

export type RouteIndexEntry = {
  scsName: string;
  requiredRoles: string[];
};

export type RouteCollision = {
  path: string;
  scsNames: string[];
};

export type RouteIndex = {
  routes: Map<string, RouteIndexEntry>;
  collisions: RouteCollision[];
};

export function buildRouteIndex(entries: ManifestEntry[]): RouteIndex {
  const routes = new Map<string, RouteIndexEntry>();
  const claimants = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (!entry.manifest) continue;
    const scsName = entry.manifest.name;
    for (const route of entry.manifest.routes) {
      const existingClaimants = claimants.get(route.path);
      if (existingClaimants) {
        existingClaimants.add(scsName);
      } else {
        claimants.set(route.path, new Set([scsName]));
        routes.set(route.path, { scsName, requiredRoles: route.requiredRoles });
      }
    }
  }

  const collisions: RouteCollision[] = [];
  for (const [path, scsNames] of claimants) {
    if (scsNames.size > 1) {
      collisions.push({ path, scsNames: [...scsNames].sort() });
      routes.delete(path);
    }
  }

  return { routes, collisions };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/rights/route-access.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rights/route-access.ts __tests__/rights/route-access.test.ts
git commit -m "feat: build a route index from the manifest registry, detecting cross-SCS collisions"
```

---

### Task 3: Access check

**Files:**
- Modify: `src/rights/route-access.ts`
- Modify: `__tests__/rights/route-access.test.ts`

**Interfaces:**
- Consumes: `type RouteIndex`, `buildRouteIndex` (Task 2, same file).
- Produces: `type AccessResult = { status: "allowed" } | { status: "not_found" } | { status: "forbidden"; requiredRoles: string[] }`, `checkAccess(index: RouteIndex, path: string, userRoles: string[]): AccessResult` from `src/rights/route-access.ts`.

- [ ] **Step 1: Write the failing tests**

Modify `__tests__/rights/route-access.test.ts` in two places: replace the existing `import { buildRouteIndex } from "../../src/rights/route-access";` line with:
```ts
import { buildRouteIndex, checkAccess } from "../../src/rights/route-access";
```
Then append a new `describe` block after the closing `});` of the existing `describe("buildRouteIndex", ...)` block:
```ts
describe("checkAccess", () => {
  test("allows a request to a public route (empty requiredRoles) regardless of user roles", () => {
    const index = buildRouteIndex([entry("orders", [{ path: "/orders", requiredRoles: [] }])]);
    expect(checkAccess(index, "/orders", [])).toEqual({ status: "allowed" });
  });

  test("allows a request when the user holds the required role", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: ["orders:viewer"] }]),
    ]);
    expect(checkAccess(index, "/orders", ["orders:viewer"])).toEqual({ status: "allowed" });
  });

  test("allows a request when the user holds at least one of several required roles", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: ["orders:viewer", "orders:admin"] }]),
    ]);
    expect(checkAccess(index, "/orders", ["orders:admin"])).toEqual({ status: "allowed" });
  });

  test("forbids a request when the user holds none of the required roles", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: ["orders:admin"] }]),
    ]);
    expect(checkAccess(index, "/orders", ["billing:viewer"])).toEqual({
      status: "forbidden",
      requiredRoles: ["orders:admin"],
    });
  });

  test("forbids a request when the user has no roles at all", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: ["orders:admin"] }]),
    ]);
    expect(checkAccess(index, "/orders", [])).toEqual({
      status: "forbidden",
      requiredRoles: ["orders:admin"],
    });
  });

  test("reports not_found for a path no manifest declares", () => {
    const index = buildRouteIndex([entry("orders", [{ path: "/orders", requiredRoles: [] }])]);
    expect(checkAccess(index, "/unknown", ["orders:admin"])).toEqual({ status: "not_found" });
  });

  test("reports not_found for a path excluded due to a cross-SCS collision", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/shared", requiredRoles: [] }]),
      entry("billing", [{ path: "/shared", requiredRoles: [] }]),
    ]);
    expect(checkAccess(index, "/shared", ["orders:admin", "billing:admin"])).toEqual({ status: "not_found" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/rights/route-access.test.ts`
Expected: FAIL — `checkAccess` is not exported from `src/rights/route-access.ts` yet.

- [ ] **Step 3: Implement**

Append to `src/rights/route-access.ts` (after `buildRouteIndex`):
```ts
export type AccessResult =
  | { status: "allowed" }
  | { status: "not_found" }
  | { status: "forbidden"; requiredRoles: string[] };

export function checkAccess(index: RouteIndex, path: string, userRoles: string[]): AccessResult {
  const route = index.routes.get(path);
  if (!route) return { status: "not_found" };
  if (route.requiredRoles.length === 0) return { status: "allowed" };
  const hasRequiredRole = route.requiredRoles.some((role) => userRoles.includes(role));
  if (hasRequiredRole) return { status: "allowed" };
  return { status: "forbidden", requiredRoles: route.requiredRoles };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/rights/route-access.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS — all prior tests plus this task's, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/rights/route-access.ts __tests__/rights/route-access.test.ts
git commit -m "feat: add checkAccess for allowed/not_found/forbidden route decisions"
```
