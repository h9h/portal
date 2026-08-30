# SCS Manifest Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Portal a way to discover, fetch, validate, and periodically refresh manifests from a static list of configured SCS base URLs — the foundation the next tasks (route enforcement, nav composition) will read from. This slice does not wire into the HTTP server or enforce anything yet; it only fetches, validates, and stores.

**Architecture:** Two small, pure-ish modules. `src/scs/manifest.ts` is a pure parser/validator with no I/O: turns an arbitrary JSON value into a typed `SCSManifest` or `null`. `src/scs/manifest-registry.ts` is the stateful piece: given a list of SCS base URLs, it fetches each one's manifest at startup and on a timer, keeping the last-known-good manifest (marked stale) when a fetch fails or returns something malformed.

**Tech Stack:** Bun runtime + `bun:test`, TypeScript, global `fetch` (injectable in tests, same pattern as `src/auth/oauth-client.ts`). No new dependencies.

**Spec:** `specification.md` (Architecture → SCS manifest contract)

## Global Constraints

- Runtime and bundler is bun; TypeScript for frontend and backend-for-frontend. (`Claude.md`)
- Minimize external dependencies — ask before introducing a new one. (`Claude.md`, `specification.md`)
- Every feature needs a set of test cases, run via `bun:test`, files under `./__tests__`. (`Claude.md`)
- Use bun's own functionality before reaching for other libraries. (`Claude.md`)
- Manifest endpoint is `GET /.portal/manifest` on each SCS's base URL; it declares `name`, `routes` (each with `requiredRoles`), and `nav` (each with `requiredRoles`). (`specification.md`)
- SCS discovery is a static, comma-separated list of base URLs (`PORTAL_SCS_URLS`), not self-registration. (`specification.md`)
- A malformed manifest is treated the same as an unreachable SCS: log it, keep the last-known-good manifest (or `null` if none has ever succeeded), mark the entry stale. A transient failure must not remove a previously-known SCS's data. (`specification.md`)
- Manifests are fetched at startup and refreshed on a fixed interval — no manual/admin refresh trigger in this slice. (`specification.md`)

---

### Task 1: Manifest type and validator

**Files:**
- Create: `src/scs/manifest.ts`
- Test: `__tests__/scs/manifest.test.ts`

**Interfaces:**
- Produces: `type RouteEntry = { path: string; requiredRoles: string[] }`, `type NavEntry = { label: string; path: string; requiredRoles: string[] }`, `type SCSManifest = { name: string; routes: RouteEntry[]; nav: NavEntry[] }`, `parseManifest(json: unknown): SCSManifest | null` from `src/scs/manifest.ts`.

- [ ] **Step 1: Write the failing tests**

`__tests__/scs/manifest.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { parseManifest } from "../../src/scs/manifest";

describe("parseManifest", () => {
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
    });
  });

  test("allows empty routes and nav arrays", () => {
    const manifest = parseManifest({ name: "orders", routes: [], nav: [] });
    expect(manifest).toEqual({ name: "orders", routes: [], nav: [] });
  });

  test("ignores unknown top-level fields", () => {
    const manifest = parseManifest({ name: "orders", routes: [], nav: [], extra: "ignored" });
    expect(manifest).toEqual({ name: "orders", routes: [], nav: [] });
  });

  test("rejects a missing name", () => {
    expect(parseManifest({ routes: [], nav: [] })).toBeNull();
  });

  test("rejects an empty name", () => {
    expect(parseManifest({ name: "", routes: [], nav: [] })).toBeNull();
  });

  test("rejects a non-array routes field", () => {
    expect(parseManifest({ name: "orders", routes: "not-an-array", nav: [] })).toBeNull();
  });

  test("rejects a non-array nav field", () => {
    expect(parseManifest({ name: "orders", routes: [], nav: "not-an-array" })).toBeNull();
  });

  test("rejects a route entry missing requiredRoles", () => {
    expect(parseManifest({ name: "orders", routes: [{ path: "/orders" }], nav: [] })).toBeNull();
  });

  test("rejects a route entry with a non-string-array requiredRoles", () => {
    expect(
      parseManifest({ name: "orders", routes: [{ path: "/orders", requiredRoles: [1, 2] }], nav: [] })
    ).toBeNull();
  });

  test("rejects a nav entry missing label", () => {
    expect(
      parseManifest({ name: "orders", routes: [], nav: [{ path: "/orders", requiredRoles: [] }] })
    ).toBeNull();
  });

  test("rejects a completely malformed payload", () => {
    expect(parseManifest("not-an-object")).toBeNull();
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest(undefined)).toBeNull();
    expect(parseManifest(42)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/scs/manifest.test.ts`
Expected: FAIL — `src/scs/manifest.ts` does not exist yet.

- [ ] **Step 3: Implement**

`src/scs/manifest.ts`:
```ts
export type RouteEntry = {
  path: string;
  requiredRoles: string[];
};

export type NavEntry = {
  label: string;
  path: string;
  requiredRoles: string[];
};

export type SCSManifest = {
  name: string;
  routes: RouteEntry[];
  nav: NavEntry[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseRouteEntry(value: unknown): RouteEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== "string" || !isStringArray(obj.requiredRoles)) return null;
  return { path: obj.path, requiredRoles: obj.requiredRoles };
}

function parseNavEntry(value: unknown): NavEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.label !== "string" || typeof obj.path !== "string" || !isStringArray(obj.requiredRoles)) {
    return null;
  }
  return { label: obj.label, path: obj.path, requiredRoles: obj.requiredRoles };
}

export function parseManifest(json: unknown): SCSManifest | null {
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name.length === 0) return null;
  if (!Array.isArray(obj.routes) || !Array.isArray(obj.nav)) return null;

  const routes: RouteEntry[] = [];
  for (const raw of obj.routes) {
    const entry = parseRouteEntry(raw);
    if (!entry) return null;
    routes.push(entry);
  }

  const nav: NavEntry[] = [];
  for (const raw of obj.nav) {
    const entry = parseNavEntry(raw);
    if (!entry) return null;
    nav.push(entry);
  }

  return { name: obj.name, routes, nav };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/scs/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scs/manifest.ts __tests__/scs/manifest.test.ts
git commit -m "feat: add SCS manifest type and validator"
```

---

### Task 2: Manifest registry (discovery, fetch, refresh, stale handling)

**Files:**
- Create: `src/scs/manifest-registry.ts`
- Test: `__tests__/scs/manifest-registry.test.ts`

**Interfaces:**
- Consumes: `parseManifest(json: unknown): SCSManifest | null`, `type SCSManifest` (Task 1, `src/scs/manifest.ts`).
- Produces: `type ManifestEntry = { baseUrl: string; manifest: SCSManifest | null; stale: boolean; lastFetchedAt: number | null }`, `type ManifestRegistryOptions = { refreshIntervalMs?: number; fetchFn?: typeof fetch }`, `type ManifestRegistry = { getManifests(): ManifestEntry[]; stop(): void }`, `parseScsBaseUrls(value: string | undefined): string[]`, `createManifestRegistry(baseUrls: string[], opts?: ManifestRegistryOptions): Promise<ManifestRegistry>` from `src/scs/manifest-registry.ts`.

- [ ] **Step 1: Write the failing tests**

`__tests__/scs/manifest-registry.test.ts`:
```ts
import { describe, test, expect, afterEach } from "bun:test";
import { createManifestRegistry, parseScsBaseUrls } from "../../src/scs/manifest-registry";

const validManifestJson = {
  name: "orders",
  routes: [{ path: "/orders", requiredRoles: ["orders:viewer"] }],
  nav: [{ label: "Orders", path: "/orders", requiredRoles: ["orders:viewer"] }],
};

let servers: ReturnType<typeof Bun.serve>[] = [];
let registries: Awaited<ReturnType<typeof createManifestRegistry>>[] = [];

afterEach(() => {
  for (const registry of registries) registry.stop();
  for (const server of servers) server.stop();
  registries = [];
  servers = [];
});

function startFakeScs(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return server;
}

function baseUrlOf(server: ReturnType<typeof Bun.serve>): string {
  return server.url.toString().replace(/\/$/, "");
}

describe("parseScsBaseUrls", () => {
  test("splits a comma-separated list and trims whitespace", () => {
    expect(parseScsBaseUrls("http://a.local, http://b.local ,http://c.local")).toEqual([
      "http://a.local",
      "http://b.local",
      "http://c.local",
    ]);
  });

  test("returns an empty array for undefined or empty input", () => {
    expect(parseScsBaseUrls(undefined)).toEqual([]);
    expect(parseScsBaseUrls("")).toEqual([]);
  });

  test("filters out empty entries from stray commas", () => {
    expect(parseScsBaseUrls("http://a.local,,http://b.local")).toEqual(["http://a.local", "http://b.local"]);
  });
});

describe("createManifestRegistry", () => {
  test("fetches a healthy SCS's manifest on startup", async () => {
    const scs = startFakeScs((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/.portal/manifest") {
        return new Response(JSON.stringify(validManifestJson), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const registry = await createManifestRegistry([baseUrlOf(scs)]);
    registries.push(registry);

    const [entry] = registry.getManifests();
    expect(entry.manifest).toEqual(validManifestJson);
    expect(entry.stale).toBe(false);
    expect(entry.lastFetchedAt).not.toBeNull();
  });

  test("marks an unreachable SCS as stale with no manifest", async () => {
    const registry = await createManifestRegistry(["http://localhost:1"], {
      fetchFn: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    });
    registries.push(registry);

    const [entry] = registry.getManifests();
    expect(entry.manifest).toBeNull();
    expect(entry.stale).toBe(true);
  });

  test("marks an SCS returning a malformed manifest as stale with no manifest", async () => {
    const scs = startFakeScs(() => new Response(JSON.stringify({ not: "a manifest" }), { status: 200 }));

    const registry = await createManifestRegistry([baseUrlOf(scs)]);
    registries.push(registry);

    const [entry] = registry.getManifests();
    expect(entry.manifest).toBeNull();
    expect(entry.stale).toBe(true);
  });

  test("keeps the last-known-good manifest and marks it stale when a later refresh fails", async () => {
    let shouldFail = false;
    const scs = startFakeScs(() => {
      if (shouldFail) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(validManifestJson), { status: 200 });
    });

    const registry = await createManifestRegistry([baseUrlOf(scs)], { refreshIntervalMs: 20 });
    registries.push(registry);

    expect(registry.getManifests()[0].manifest).toEqual(validManifestJson);

    shouldFail = true;
    await new Promise((resolve) => setTimeout(resolve, 60));

    const entry = registry.getManifests()[0];
    expect(entry.manifest).toEqual(validManifestJson);
    expect(entry.stale).toBe(true);
  });

  test("recovers from stale once the SCS responds again", async () => {
    let shouldFail = true;
    const scs = startFakeScs(() => {
      if (shouldFail) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(validManifestJson), { status: 200 });
    });

    const registry = await createManifestRegistry([baseUrlOf(scs)], { refreshIntervalMs: 20 });
    registries.push(registry);

    expect(registry.getManifests()[0].stale).toBe(true);

    shouldFail = false;
    await new Promise((resolve) => setTimeout(resolve, 60));

    const entry = registry.getManifests()[0];
    expect(entry.manifest).toEqual(validManifestJson);
    expect(entry.stale).toBe(false);
  });

  test("tracks multiple SCSs independently", async () => {
    const healthy = startFakeScs(() => new Response(JSON.stringify(validManifestJson), { status: 200 }));
    const broken = startFakeScs(() => new Response("boom", { status: 500 }));

    const registry = await createManifestRegistry([baseUrlOf(healthy), baseUrlOf(broken)]);
    registries.push(registry);

    const [healthyEntry, brokenEntry] = registry.getManifests();
    expect(healthyEntry.manifest).toEqual(validManifestJson);
    expect(healthyEntry.stale).toBe(false);
    expect(brokenEntry.manifest).toBeNull();
    expect(brokenEntry.stale).toBe(true);
  });

  test("stop() prevents further scheduled refreshes", async () => {
    let fetchCount = 0;
    const scs = startFakeScs(() => {
      fetchCount++;
      return new Response(JSON.stringify(validManifestJson), { status: 200 });
    });

    const registry = await createManifestRegistry([baseUrlOf(scs)], { refreshIntervalMs: 20 });
    registries.push(registry);

    const countAfterStartup = fetchCount;
    registry.stop();

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(fetchCount).toBe(countAfterStartup);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/scs/manifest-registry.test.ts`
Expected: FAIL — `src/scs/manifest-registry.ts` does not exist yet.

- [ ] **Step 3: Implement**

`src/scs/manifest-registry.ts`:
```ts
import { parseManifest, type SCSManifest } from "./manifest";

export type ManifestEntry = {
  baseUrl: string;
  manifest: SCSManifest | null;
  stale: boolean;
  lastFetchedAt: number | null;
};

export type ManifestRegistryOptions = {
  refreshIntervalMs?: number;
  fetchFn?: typeof fetch;
};

export type ManifestRegistry = {
  getManifests(): ManifestEntry[];
  stop(): void;
};

export function parseScsBaseUrls(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export async function createManifestRegistry(
  baseUrls: string[],
  opts: ManifestRegistryOptions = {}
): Promise<ManifestRegistry> {
  const fetchFn = opts.fetchFn ?? fetch;
  const refreshIntervalMs = opts.refreshIntervalMs ?? 60_000;
  const entries = new Map<string, ManifestEntry>();

  async function fetchOne(baseUrl: string): Promise<void> {
    const existing = entries.get(baseUrl);
    try {
      const response = await fetchFn(`${baseUrl}/.portal/manifest`);
      if (!response.ok) throw new Error(`manifest fetch failed with status ${response.status}`);
      const json = await response.json();
      const manifest = parseManifest(json);
      if (!manifest) throw new Error("malformed manifest");
      entries.set(baseUrl, { baseUrl, manifest, stale: false, lastFetchedAt: Date.now() });
    } catch (err) {
      console.error(`manifest fetch failed for ${baseUrl}`, err);
      entries.set(baseUrl, {
        baseUrl,
        manifest: existing?.manifest ?? null,
        stale: true,
        lastFetchedAt: existing?.lastFetchedAt ?? null,
      });
    }
  }

  async function fetchAll(): Promise<void> {
    await Promise.all(baseUrls.map(fetchOne));
  }

  await fetchAll();

  const timer = setInterval(() => {
    fetchAll();
  }, refreshIntervalMs);

  return {
    getManifests(): ManifestEntry[] {
      return baseUrls.map((baseUrl) => entries.get(baseUrl)!);
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/scs/manifest-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS — all prior tests plus this task's, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/scs/manifest-registry.ts __tests__/scs/manifest-registry.test.ts
git commit -m "feat: add SCS manifest registry with fetch, refresh, and stale handling"
```
