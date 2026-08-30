# Frontend Shell + Shared Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Portal a client-side SPA shell that mounts SCS-contributed React components as the user navigates (no full page reloads), plus a cross-SCS shared context store so one SCS's component can publish data another SCS's component consumes.

**Architecture:** A server-side split of every `GET` into two flows by a data-marker header (`X-Portal-Data: 1`): unmarked requests always get a static shell HTML page (SPA fallback, any path, any auth state); marked requests go through the existing role-gated SCS proxy unchanged. The shell is a small React app, bootstrapped once, that resolves the current path against a new `GET /routes` table, dynamically imports the owning SCS's component bundle through a new Portal-proxied `GET /_scs/<scsName>/bundle.js`, and mounts it. A new `@portal/runtime` module (built by Portal, loaded by both the shell and every SCS bundle via an import map so they share one React instance) exposes the shared-context hooks, a navigation hook, and a fetch helper that attaches the marker header.

**Tech Stack:** Bun runtime + `bun:test`, TypeScript, real `react`/`react-dom` (this plan adds them — see Task 4), `@happy-dom/global-registrator` for DOM-based tests (Task 1). `Bun.build()` (no external bundler) produces every browser-served JS asset. No other new dependencies.

**Spec:** `specification.md` (Architecture → Request flow, SCS manifest contract, Client shell, Shared context; Identity, sessions, and rights → Route enforcement)

## Global Constraints

- Runtime and bundler is bun; TypeScript for frontend and backend-for-frontend. Minimize external dependencies. (`CLAUDE.md`)
- Every feature needs a set of test cases, run via `bun:test`, files under `./__tests__`. (`CLAUDE.md`)
- Portal's own fixed routes always win, checked by exact `pathname` equality: `/health`, `/auth/*`, `/me`, `/nav`, `/admin/*`, `/_scs/*`, `/_shell/*`, `/routes`. (`specification.md`)
- **Page navigation** (`GET` without `X-Portal-Data: 1`): always returns the shell bootstrap HTML — any path, any auth state, no route-index/auth check at all. (`specification.md`)
- **Data fetch** (`GET` with `X-Portal-Data: 1`): unchanged from the existing composition model — `checkAccess`-gated (401/403/404), proxied to the SCS with an internal token. (`specification.md`)
- `GET /routes` requires authentication (401 if unauthenticated) but is **not** role-filtered — it returns every declared route with its required roles. (`specification.md`)
- `GET /_scs/<scsName>/bundle.js` requires authentication (401) but is **not** role-gated (bundles carry code, not user data); 502 on an unreachable/redirecting SCS, matching the existing fragment-fetch failure shape. (`specification.md`)
- `GET /_shell/*` requires **no** authentication at all — these are Portal's own first-party assets, needed to render even the login screen. (`specification.md`)
- Shared-context key ownership is declared per-SCS in its manifest's `publishesContext`; a key claimed by two different base URLs is excluded from the valid set and logged, mirroring the existing route-collision rule exactly — no merge, no last-writer-wins. (`specification.md`)
- `usePublishContext` for a key the calling SCS doesn't own (undeclared, owned by someone else, or collision-voided) is a no-op with `console.warn` — never a thrown exception. (`specification.md`)
- Client-side role/route checks (the shell's own routing) are UX only, never the security boundary — the real enforcement is always the server-side data-fetch flow. (`specification.md`)
- This stage mounts exactly one component per navigation, into a single content region — no multi-SCS-component-per-page composition yet. (`specification.md`)
- No automatic `<a>` click interception this stage — `usePortalNavigate()` is called explicitly. (`specification.md`)
- Manifest fields added by this plan (`bundle`, `routes[].component`, `publishesContext`, `consumesContext`) are all optional at parse time (default `[]` for the two context arrays, `undefined` for `bundle`/`component`) — every existing manifest fixture in the test suite that predates this plan must keep parsing successfully unchanged.

## File Structure

- `src/scs/manifest.ts` — **modify**: extend `SCSManifest`/`RouteEntry` types and `parseManifest` with the four new fields.
- `src/rights/route-access.ts` — **modify**: `RouteIndexEntry` gains `component?: string`, propagated by `buildRouteIndex`.
- `src/rights/context-index.ts` — **new**: `buildContextIndex`, a near-exact mirror of `buildRouteIndex` for `publishesContext` ownership/collision.
- `src/runtime/store.ts` — **new**: the plain external pub/sub store, no React/DOM dependency.
- `src/runtime/context.ts` — **new**: `usePublishedContext`, `usePublishContext`, `PortalRuntimeProvider` (React hooks/component built on the store).
- `src/runtime/navigate.ts` — **new**: `usePortalNavigate`, `useCurrentPath` (client-side history/navigation).
- `src/runtime/fetch.ts` — **new**: `portalFetch` (attaches the data-marker header).
- `src/runtime/index.ts` — **new**: barrel re-exporting the above — this file, bundled, becomes `@portal/runtime`.
- `src/frontend/router.ts` — **new**: `RouteTableEntry` type + `resolveRoute` (pure client-side route resolution, no DOM).
- `src/frontend/shell-entry.tsx` — **new**: the shell's React app (`App` component — boot, resolve, mount, error boundary). No side effects; only exports `App`.
- `src/frontend/shell-boot.tsx` — **new**: the real bundle entrypoint — imports `App` and calls `createRoot(...).render(<App />)`. Kept separate from `shell-entry.tsx` so a test importing `App` never triggers a real DOM-mount side effect.
- `src/shell/route-table.ts` — **new**: `buildRouteTable`, `buildContextOwners` (server-side, flattens the route/context indexes for `GET /routes`).
- `src/shell/bootstrap-html.ts` — **new**: `renderShellHtml()`, the static bootstrap page (import map + root div + script tag).
- `src/shell/vendor/react-entry.ts`, `src/shell/vendor/react-dom-entry.ts` — **new**: tiny re-export entry points `Bun.build` bundles into standalone vendor assets.
- `src/shell/bundle.ts` — **new**: `getShellAssets()` — lazily builds and caches all four browser-served bundles via `Bun.build()`.
- `src/server.ts` — **modify**: wire in the context index, `GET /routes`, `GET /_scs/:scsName/bundle.js`, `GET /_shell/*`, and the page-navigation/data-fetch content-negotiation split.
- `tsconfig.json`, `bunfig.toml` — **modify**: switch JSX to React's automatic runtime, add DOM lib types, add the `@portal/runtime` path alias.
- `CLAUDE.md` — **modify**: fix the now-stale JSX convention description.
- `package.json` — **modify**: add `react`, `react-dom` (runtime deps), `@types/react`, `@types/react-dom`, `@happy-dom/global-registrator` (dev deps).
- `__tests__/helpers/dom.ts` — **new**: `withDom()`, scoped happy-dom registration for the specific test files that need a DOM.

---

### Task 1: Frontend build environment

**Files:**
- Modify: `tsconfig.json`, `bunfig.toml`, `package.json`, `CLAUDE.md`
- Create: `__tests__/helpers/dom.ts`, `__tests__/frontend/dom-smoke.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: a JSX toolchain that compiles real React components with no manual `h`/`React` import (`jsx: "react-jsx"`); DOM types available to the TypeScript checker (`lib: ["ESNext", "DOM", "DOM.Iterable"]`); a `withDom()` test helper any later DOM-needing test file can call at its top level to scope happy-dom's globals to just that file's test run (register in `beforeAll`, unregister in `afterAll` — **not** a global `bun:test` preload, to avoid happy-dom's `fetch`/`Response`/`Headers`/`URL` polyfills silently overriding the native Bun implementations every existing server test already depends on).

- [ ] **Step 1: Add dependencies**

Run: `bun add -d @happy-dom/global-registrator`

- [ ] **Step 2: Update `tsconfig.json`**

Change `compilerOptions` from:
```json
    "lib": ["ESNext"],
    ...
    "jsx": "react",
    "jsxFactory": "h",
    "jsxFragmentFactory": "Fragment",
```
to:
```json
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    ...
    "jsx": "react-jsx",
    "jsxImportSource": "react",
```
(remove `jsxFactory`/`jsxFragmentFactory` entirely — they're unused in `react-jsx` mode.)

- [ ] **Step 3: Update `bunfig.toml`**

Change:
```toml
jsx = "react"
jsxFactory = "h"
jsxFragment = "Fragment"
jsxImportSource = "react"
```
to:
```toml
jsx = "react-jsx"
jsxImportSource = "react"
```

- [ ] **Step 4: Write the DOM test helper**

Create `__tests__/helpers/dom.ts`:
```ts
import { beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Scopes happy-dom's globals (document, window, HTMLElement, ...) to exactly
// the test file that calls this at its top level — register()/unregister()
// run around that file's own suite, so no other test file (including the
// ~168 existing server tests that rely on Bun's native fetch/Response) ever
// sees happy-dom's globals.
export function withDom(): void {
  beforeAll(() => {
    GlobalRegistrator.register();
  });
  afterAll(() => {
    GlobalRegistrator.unregister();
  });
}
```

- [ ] **Step 5: Write the failing smoke test**

Create `__tests__/frontend/dom-smoke.test.tsx`:
```tsx
import { describe, test, expect } from "bun:test";
import { withDom } from "../helpers/dom";

withDom();

describe("JSX + happy-dom smoke test", () => {
  test("a JSX element renders into a happy-dom container via react-dom/client", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react-dom/test-utils");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<div>hello</div>);
    });

    expect(container.textContent).toBe("hello");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test __tests__/frontend/dom-smoke.test.tsx`
Expected: FAIL — `react`/`react-dom` aren't installed yet, and/or `document` is not defined without the JSX config in place.

- [ ] **Step 7: Add react/react-dom and their types**

Run: `bun add react react-dom` then `bun add -d @types/react @types/react-dom`

- [ ] **Step 8: Run the smoke test to verify it passes**

Run: `bun test __tests__/frontend/dom-smoke.test.tsx`
Expected: PASS. If the JSX doesn't compile, double check Step 2/3's exact key names against `bunx tsc --noEmit`'s error output and Bun's current `bunfig.toml` JSX documentation — do not guess further, read the actual error.

- [ ] **Step 9: Run the full existing suite to confirm no collision**

Run: `bun test`
Expected: all pre-existing tests (168 as of this plan's base commit) still pass — this is the empirical check that happy-dom's scoped registration in Step 4 does not leak into or collide with any other test file's use of native `fetch`/`Response`/`Headers`/`URL`. If any pre-existing test fails, do not proceed — the scoping in Step 4 has a gap; investigate before continuing.

- [ ] **Step 10: Fix `bunx tsc --noEmit`**

Run: `bunx tsc --noEmit`
Expected: clean. Fix any type errors surfaced by the `lib`/`jsx` changes before proceeding (there should be none from this task alone, since no other file uses JSX yet).

- [ ] **Step 11: Update `CLAUDE.md`**

In `CLAUDE.md`'s "Tech stack and conventions" section, change:
```
- Frontend framework: JSX (see `bunfig.toml` — `jsxFactory = "h"`, `jsxImportSource = "react"`).
```
to:
```
- Frontend framework: real `react`/`react-dom`, JSX via React's automatic runtime (see `bunfig.toml`/`tsconfig.json` — `jsx = "react-jsx"`, `jsxImportSource = "react"`). DOM-dependent tests use `@happy-dom/global-registrator`, scoped per-file via `__tests__/helpers/dom.ts`'s `withDom()` — never as a global `bun:test` preload.
```

- [ ] **Step 12: Commit**

```bash
git add tsconfig.json bunfig.toml package.json bun.lock CLAUDE.md __tests__/helpers/dom.ts __tests__/frontend/dom-smoke.test.tsx
git commit -m "feat: switch to React's automatic JSX runtime, add happy-dom test helper"
```

---

### Task 2: Manifest schema extensions

**Files:**
- Modify: `src/scs/manifest.ts`, `__tests__/scs/manifest.test.ts`, `__tests__/rights/route-access.test.ts`, `__tests__/rights/nav.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SCSManifest` gains `bundle?: string`, `publishesContext: string[]`, `consumesContext: string[]` (the latter two always present as arrays post-parse, defaulting to `[]` when absent from raw input). `RouteEntry` gains `component?: string`. `parseManifest` validates all four leniently (present-but-wrong-type is still rejected; absent is fine).

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/scs/manifest.test.ts` (new `describe` blocks after the existing ones; the existing "parses a valid manifest", "allows empty routes and nav arrays", and "ignores unknown top-level fields" tests' `.toEqual(...)` expectations must also be updated — see Step 1b):

```ts
describe("bundle field", () => {
  test("accepts a manifest with a bundle path", () => {
    const manifest = parseManifest({ name: "orders", bundle: "/.portal/bundle.js", routes: [], nav: [] });
    expect(manifest?.bundle).toBe("/.portal/bundle.js");
  });

  test("omits bundle when absent", () => {
    const manifest = parseManifest({ name: "orders", routes: [], nav: [] });
    expect(manifest?.bundle).toBeUndefined();
  });

  test("rejects a non-string bundle", () => {
    expect(parseManifest({ name: "orders", bundle: 42, routes: [], nav: [] })).toBeNull();
  });

  test("rejects an empty-string bundle", () => {
    expect(parseManifest({ name: "orders", bundle: "", routes: [], nav: [] })).toBeNull();
  });
});

describe("route component field", () => {
  test("accepts a route with a component name", () => {
    const manifest = parseManifest({
      name: "orders",
      routes: [{ path: "/orders", requiredRoles: [], component: "OrdersView" }],
      nav: [],
    });
    expect(manifest?.routes[0]).toEqual({ path: "/orders", requiredRoles: [], component: "OrdersView" });
  });

  test("omits component when absent (data-only route)", () => {
    const manifest = parseManifest({
      name: "orders",
      routes: [{ path: "/orders/summary", requiredRoles: [] }],
      nav: [],
    });
    expect(manifest?.routes[0]).toEqual({ path: "/orders/summary", requiredRoles: [] });
    expect(manifest?.routes[0].component).toBeUndefined();
  });

  test("rejects a non-string component", () => {
    expect(
      parseManifest({ name: "orders", routes: [{ path: "/orders", requiredRoles: [], component: 42 }], nav: [] })
    ).toBeNull();
  });
});

describe("publishesContext / consumesContext fields", () => {
  test("accepts declared publish and consume keys", () => {
    const manifest = parseManifest({
      name: "profile",
      routes: [],
      nav: [],
      publishesContext: ["profile"],
      consumesContext: ["contactData"],
    });
    expect(manifest?.publishesContext).toEqual(["profile"]);
    expect(manifest?.consumesContext).toEqual(["contactData"]);
  });

  test("defaults both to an empty array when absent", () => {
    const manifest = parseManifest({ name: "orders", routes: [], nav: [] });
    expect(manifest?.publishesContext).toEqual([]);
    expect(manifest?.consumesContext).toEqual([]);
  });

  test("rejects a non-string-array publishesContext", () => {
    expect(parseManifest({ name: "orders", routes: [], nav: [], publishesContext: [1, 2] })).toBeNull();
  });

  test("rejects a non-string-array consumesContext", () => {
    expect(parseManifest({ name: "orders", routes: [], nav: [], consumesContext: "not-an-array" })).toBeNull();
  });
});
```

**Step 1b**: update the three pre-existing assertions in the same file that construct a full expected object via `.toEqual(...)`, adding the two new always-present array fields:
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

  test("allows empty routes and nav arrays", () => {
    const manifest = parseManifest({ name: "orders", routes: [], nav: [] });
    expect(manifest).toEqual({ name: "orders", routes: [], nav: [], publishesContext: [], consumesContext: [] });
  });

  test("ignores unknown top-level fields", () => {
    const manifest = parseManifest({ name: "orders", routes: [], nav: [], extra: "ignored" });
    expect(manifest).toEqual({ name: "orders", routes: [], nav: [], publishesContext: [], consumesContext: [] });
  });
```

**Step 1c**: `SCSManifest`'s two new array fields are non-optional on the type (always present after parsing, even though optional in raw JSON input). This breaks TypeScript compilation for any test helper elsewhere that builds an `SCSManifest`-typed object literal directly (not through `parseManifest`) without the two new fields. Fix `entry()` in `__tests__/rights/route-access.test.ts`:
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
and `entry()` in `__tests__/rights/nav.test.ts`:
```ts
function entry(
  name: string,
  nav: { label: string; path: string; requiredRoles: string[] }[],
  stale = false
): ManifestEntry {
  return {
    baseUrl: `http://${name}.local`,
    manifest: { name, routes: [], nav, publishesContext: [], consumesContext: [] },
    stale,
    lastFetchedAt: stale ? null : Date.now(),
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/scs/manifest.test.ts`
Expected: FAIL — the new fields aren't parsed/typed yet. `bunx tsc --noEmit` should also fail on the two test-helper files from Step 1c until Step 3 lands.

- [ ] **Step 3: Implement**

Replace the contents of `src/scs/manifest.ts`:
```ts
export type RouteEntry = {
  path: string;
  requiredRoles: string[];
  component?: string;
};

export type NavEntry = {
  label: string;
  path: string;
  requiredRoles: string[];
};

export type SCSManifest = {
  name: string;
  bundle?: string;
  routes: RouteEntry[];
  nav: NavEntry[];
  publishesContext: string[];
  consumesContext: string[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

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
  if (obj.bundle !== undefined && (typeof obj.bundle !== "string" || obj.bundle.length === 0)) return null;
  if (!Array.isArray(obj.routes) || !Array.isArray(obj.nav)) return null;
  if (obj.publishesContext !== undefined && !isStringArray(obj.publishesContext)) return null;
  if (obj.consumesContext !== undefined && !isStringArray(obj.consumesContext)) return null;

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

  return {
    name: obj.name,
    ...(typeof obj.bundle === "string" ? { bundle: obj.bundle } : {}),
    routes,
    nav,
    publishesContext: isStringArray(obj.publishesContext) ? obj.publishesContext : [],
    consumesContext: isStringArray(obj.consumesContext) ? obj.consumesContext : [],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/scs/manifest.test.ts __tests__/rights/route-access.test.ts __tests__/rights/nav.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean. This confirms no other file constructs an `SCSManifest` literal directly (`__tests__/scs/manifest-registry.test.ts` and the various fake-SCS-server test fixtures in `__tests__/server/*.test.ts` all go through `parseManifest` via real HTTP responses, not direct object literals, so they should be unaffected — verify this is actually true rather than assuming).

- [ ] **Step 6: Commit**

```bash
git add src/scs/manifest.ts __tests__/scs/manifest.test.ts __tests__/rights/route-access.test.ts __tests__/rights/nav.test.ts
git commit -m "feat: add bundle, component, publishesContext, consumesContext to the manifest schema"
```

---

### Task 3: Context ownership index

**Files:**
- Create: `src/rights/context-index.ts`, `__tests__/rights/context-index.test.ts`

**Interfaces:**
- Consumes: `ManifestEntry` from `src/scs/manifest-registry.ts` (unchanged type, now carrying `publishesContext` per Task 2).
- Produces: `ContextIndex = { owners: Map<string, string>; collisions: ContextCollision[] }`, `buildContextIndex(entries: ManifestEntry[]): ContextIndex`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/rights/context-index.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { buildContextIndex } from "../../src/rights/context-index";
import type { ManifestEntry } from "../../src/scs/manifest-registry";

function entry(name: string, publishesContext: string[], baseUrl?: string): ManifestEntry {
  return {
    baseUrl: baseUrl ?? `http://${name}.local`,
    manifest: { name, routes: [], nav: [], publishesContext, consumesContext: [] },
    stale: false,
    lastFetchedAt: Date.now(),
  };
}

function unreachableEntry(baseUrl: string): ManifestEntry {
  return { baseUrl, manifest: null, stale: true, lastFetchedAt: null };
}

describe("buildContextIndex", () => {
  test("indexes a single SCS's declared keys", () => {
    const index = buildContextIndex([entry("profile", ["profile"])]);
    expect(index.owners.get("profile")).toBe("profile");
    expect(index.collisions).toEqual([]);
  });

  test("indexes keys from multiple SCSs with no overlap", () => {
    const index = buildContextIndex([entry("profile", ["profile"]), entry("contactData", ["contactData"])]);
    expect(index.owners.get("profile")).toBe("profile");
    expect(index.owners.get("contactData")).toBe("contactData");
    expect(index.collisions).toEqual([]);
  });

  test("excludes a colliding key from owners and reports the collision", () => {
    const index = buildContextIndex([
      entry("profile", ["shared"], "http://a.local"),
      entry("otherProfile", ["shared"], "http://b.local"),
    ]);
    expect(index.owners.has("shared")).toBe(false);
    expect(index.collisions).toEqual([{ key: "shared", scsNames: ["otherProfile", "profile"] }]);
  });

  test("does not treat one SCS declaring the same key on repeat manifests as a collision", () => {
    const index = buildContextIndex([entry("profile", ["profile"], "http://a.local")]);
    expect(index.collisions).toEqual([]);
    expect(index.owners.get("profile")).toBe("profile");
  });

  test("skips an SCS with no manifest (never successfully fetched)", () => {
    const index = buildContextIndex([unreachableEntry("http://broken.local")]);
    expect(index.owners.size).toBe(0);
    expect(index.collisions).toEqual([]);
  });

  test("handles an SCS that publishes nothing", () => {
    const index = buildContextIndex([entry("orders", [])]);
    expect(index.owners.size).toBe(0);
    expect(index.collisions).toEqual([]);
  });

  test("returns an empty index for no entries", () => {
    const index = buildContextIndex([]);
    expect(index.owners.size).toBe(0);
    expect(index.collisions).toEqual([]);
  });

  test("two different base URLs colliding on a key even if they declare the same manifest name", () => {
    const index = buildContextIndex([
      entry("profile", ["shared"], "http://a.local"),
      entry("profile", ["shared"], "http://b.local"),
    ]);
    expect(index.owners.has("shared")).toBe(false);
    expect(index.collisions).toEqual([{ key: "shared", scsNames: ["profile"] }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test __tests__/rights/context-index.test.ts`
Expected: FAIL — `src/rights/context-index.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/rights/context-index.ts` (structurally mirrors `buildRouteIndex` in `src/rights/route-access.ts`):
```ts
import type { ManifestEntry } from "../scs/manifest-registry";

export type ContextCollision = {
  key: string;
  scsNames: string[];
};

export type ContextIndex = {
  owners: Map<string, string>;
  collisions: ContextCollision[];
};

export function buildContextIndex(entries: ManifestEntry[]): ContextIndex {
  const owners = new Map<string, string>();
  // key -> (baseUrl -> declared name), same reasoning as buildRouteIndex's
  // claimants map: keyed on the trusted base URL, not the self-declared name.
  const claimants = new Map<string, Map<string, string>>();

  for (const entry of entries) {
    if (!entry.manifest) continue;
    const scsName = entry.manifest.name;
    for (const key of entry.manifest.publishesContext) {
      const existingClaimants = claimants.get(key);
      if (existingClaimants) {
        existingClaimants.set(entry.baseUrl, scsName);
      } else {
        claimants.set(key, new Map([[entry.baseUrl, scsName]]));
        owners.set(key, scsName);
      }
    }
  }

  const collisions: ContextCollision[] = [];
  for (const [key, byBaseUrl] of claimants) {
    if (byBaseUrl.size > 1) {
      collisions.push({ key, scsNames: [...new Set(byBaseUrl.values())].sort() });
      owners.delete(key);
    }
  }

  return { owners, collisions };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/rights/context-index.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS — purely additive.

- [ ] **Step 6: Commit**

```bash
git add src/rights/context-index.ts __tests__/rights/context-index.test.ts
git commit -m "feat: add context ownership index (collision detection mirroring routes)"
```

---

### Task 4: Shared context, navigation, and data-fetch runtime (`@portal/runtime`)

**Files:**
- Create: `src/runtime/store.ts`, `src/runtime/context.ts`, `src/runtime/navigate.ts`, `src/runtime/fetch.ts`, `src/runtime/index.ts`
- Test: `__tests__/runtime/store.test.ts`, `__tests__/runtime/context.test.tsx`, `__tests__/runtime/navigate.test.tsx`, `__tests__/runtime/fetch.test.ts`
- Modify: `tsconfig.json` (path alias)

**Interfaces:**
- Consumes: `react` (already added in Task 1).
- Produces (all re-exported from `src/runtime/index.ts`, which is what `@portal/runtime` resolves to via the tsconfig path alias and, later, the browser import map):
  - `usePublishedContext(key: string): unknown`
  - `usePublishContext(key: string): (value: unknown) => void`
  - `PortalRuntimeProvider(props: { scsName: string; contextOwners: Record<string, string>; children: ReactNode }): ReactElement`
  - `type PortalIdentity = { scsName: string; contextOwners: Record<string, string> }`
  - `usePortalNavigate(): (path: string) => void`
  - `useCurrentPath(): string`
  - `portalFetch(input: string, init?: RequestInit): Promise<Response>`

- [ ] **Step 1: Add the tsconfig path alias**

In `tsconfig.json`'s `compilerOptions`, add:
```json
    "paths": {
      "@portal/runtime": ["./src/runtime/index.ts"]
    }
```
(This lets TypeScript resolve `@portal/runtime` imports for type-checking. `Bun.build`'s bundler, used later in Task 9, ignores this — it treats `@portal/runtime` as an external by literal specifier string, independent of tsconfig path mapping. Verify with `bunx tsc --noEmit` after Step 1 alone doesn't need to pass yet, since the module doesn't exist — just confirm no *new* unrelated errors appear.)

- [ ] **Step 2: Write the failing store tests (no DOM needed)**

Create `__tests__/runtime/store.test.ts`:
```ts
import { describe, test, expect, mock } from "bun:test";
import { createContextStore } from "../../src/runtime/store";

describe("createContextStore", () => {
  test("get returns undefined for a key never set", () => {
    const store = createContextStore();
    expect(store.get("profile")).toBeUndefined();
  });

  test("set then get returns the value", () => {
    const store = createContextStore();
    store.set("profile", { name: "Ada" });
    expect(store.get("profile")).toEqual({ name: "Ada" });
  });

  test("subscribe is notified on set for that key", () => {
    const store = createContextStore();
    const listener = mock(() => {});
    store.subscribe("profile", listener);
    store.set("profile", { name: "Ada" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("subscribe is not notified for a different key", () => {
    const store = createContextStore();
    const listener = mock(() => {});
    store.subscribe("profile", listener);
    store.set("contactData", { address: "1 Main St" });
    expect(listener).not.toHaveBeenCalled();
  });

  test("unsubscribing stops further notifications", () => {
    const store = createContextStore();
    const listener = mock(() => {});
    const unsubscribe = store.subscribe("profile", listener);
    unsubscribe();
    store.set("profile", { name: "Ada" });
    expect(listener).not.toHaveBeenCalled();
  });

  test("multiple subscribers to the same key are all notified", () => {
    const store = createContextStore();
    const a = mock(() => {});
    const b = mock(() => {});
    store.subscribe("profile", a);
    store.subscribe("profile", b);
    store.set("profile", { name: "Ada" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test("a listener that unsubscribes itself during notification does not break other listeners", () => {
    const store = createContextStore();
    let unsubscribeA: () => void;
    const a = mock(() => unsubscribeA());
    const b = mock(() => {});
    unsubscribeA = store.subscribe("profile", a);
    store.subscribe("profile", b);
    store.set("profile", { name: "Ada" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test __tests__/runtime/store.test.ts`
Expected: FAIL — `src/runtime/store.ts` doesn't exist yet.

- [ ] **Step 4: Implement the store**

Create `src/runtime/store.ts`:
```ts
type Listener = () => void;

export type ContextStore = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  subscribe(key: string, listener: Listener): () => void;
};

export function createContextStore(): ContextStore {
  const values = new Map<string, unknown>();
  const listeners = new Map<string, Set<Listener>>();

  return {
    get(key) {
      return values.get(key);
    },
    set(key, value) {
      values.set(key, value);
      const keyListeners = listeners.get(key);
      if (keyListeners) {
        // Snapshot before iterating: a listener unsubscribing itself (or
        // another listener) mid-notify must not corrupt this notification pass.
        for (const listener of [...keyListeners]) listener();
      }
    },
    subscribe(key, listener) {
      let keyListeners = listeners.get(key);
      if (!keyListeners) {
        keyListeners = new Set();
        listeners.set(key, keyListeners);
      }
      keyListeners.add(listener);
      return () => {
        keyListeners!.delete(listener);
        if (keyListeners!.size === 0) listeners.delete(key);
      };
    },
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test __tests__/runtime/store.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing context/hooks tests (DOM needed)**

Create `__tests__/runtime/context.test.tsx`:
```tsx
import { describe, test, expect, mock, spyOn } from "bun:test";
import { withDom } from "../helpers/dom";

withDom();

describe("usePublishedContext / usePublishContext / PortalRuntimeProvider", () => {
  test("a value published by an owning SCS is read by usePublishedContext", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react-dom/test-utils");
    const { usePublishedContext, usePublishContext, PortalRuntimeProvider } = await import("../../src/runtime/context");

    const seen: unknown[] = [];

    function Publisher() {
      const publish = usePublishContext("profile");
      React.useEffect(() => {
        publish({ name: "Ada" });
      }, [publish]);
      return null;
    }
    function Reader() {
      const value = usePublishedContext("profile");
      seen.push(value);
      return null;
    }
    const React = await import("react");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <PortalRuntimeProvider scsName="profile" contextOwners={{ profile: "profile" }}>
          <Publisher />
          <Reader />
        </PortalRuntimeProvider>
      );
    });

    expect(seen[seen.length - 1]).toEqual({ name: "Ada" });
  });

  test("usePublishContext is a no-op with a warning for an unowned key", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react-dom/test-utils");
    const { usePublishedContext, usePublishContext, PortalRuntimeProvider } = await import("../../src/runtime/context");
    const React = await import("react");

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    function Publisher() {
      const publish = usePublishContext("contactData"); // owned by "contactData", not "profile"
      React.useEffect(() => {
        publish({ address: "1 Main St" });
      }, [publish]);
      return null;
    }
    const seen: unknown[] = [];
    function Reader() {
      seen.push(usePublishedContext("contactData"));
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <PortalRuntimeProvider scsName="profile" contextOwners={{ contactData: "contactData" }}>
          <Publisher />
          <Reader />
        </PortalRuntimeProvider>
      );
    });

    expect(seen[seen.length - 1]).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("usePublishContext for a collision-voided key (absent from contextOwners) is a no-op with a warning", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react-dom/test-utils");
    const { usePublishedContext, usePublishContext, PortalRuntimeProvider } = await import("../../src/runtime/context");
    const React = await import("react");

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    function Publisher() {
      const publish = usePublishContext("shared");
      React.useEffect(() => {
        publish("value");
      }, [publish]);
      return null;
    }
    const seen: unknown[] = [];
    function Reader() {
      seen.push(usePublishedContext("shared"));
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <PortalRuntimeProvider scsName="profile" contextOwners={{}}>
          <Publisher />
          <Reader />
        </PortalRuntimeProvider>
      );
    });

    expect(seen[seen.length - 1]).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("usePublishContext outside any PortalRuntimeProvider is a no-op with a warning", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react-dom/test-utils");
    const { usePublishContext } = await import("../../src/runtime/context");

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    function Publisher() {
      const publish = usePublishContext("profile");
      publish("value"); // called directly during render is fine for this assertion's purpose
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const { act: act2 } = await import("react-dom/test-utils");
    act2(() => {
      root.render(<Publisher />);
    });

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("a reader in a different mounted tree sees updates published from another tree (shared singleton store)", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react-dom/test-utils");
    const { usePublishedContext, usePublishContext, PortalRuntimeProvider } = await import("../../src/runtime/context");
    const React = await import("react");

    function Publisher() {
      const publish = usePublishContext("profile");
      React.useEffect(() => {
        publish({ name: "Grace" });
      }, [publish]);
      return null;
    }
    const seen: unknown[] = [];
    function Reader() {
      seen.push(usePublishedContext("profile"));
      return null;
    }

    const containerA = document.createElement("div");
    const containerB = document.createElement("div");
    document.body.appendChild(containerA);
    document.body.appendChild(containerB);
    const rootA = createRoot(containerA);
    const rootB = createRoot(containerB);

    act(() => {
      rootA.render(
        <PortalRuntimeProvider scsName="profile" contextOwners={{ profile: "profile" }}>
          <Publisher />
        </PortalRuntimeProvider>
      );
    });
    act(() => {
      rootB.render(
        <PortalRuntimeProvider scsName="contactData" contextOwners={{ profile: "profile" }}>
          <Reader />
        </PortalRuntimeProvider>
      );
    });

    expect(seen[seen.length - 1]).toEqual({ name: "Grace" });
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `bun test __tests__/runtime/context.test.tsx`
Expected: FAIL — `src/runtime/context.ts` doesn't exist yet.

- [ ] **Step 8: Implement the context hooks**

Create `src/runtime/context.ts`:
```ts
import { createContext, createElement, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import { createContextStore } from "./store";

// One module-level store: since `@portal/runtime` is loaded once (as a
// single browser module, shared via the import map — see Client shell in
// specification.md), every mounted component from every SCS reads/writes
// this same singleton, regardless of which SCS's bundle it came from.
const store = createContextStore();

export type PortalIdentity = {
  scsName: string;
  contextOwners: Record<string, string>;
};

const IdentityContext = createContext<PortalIdentity | null>(null);

export function PortalRuntimeProvider(props: PortalIdentity & { children: ReactNode }) {
  const { children, ...identity } = props;
  return createElement(IdentityContext.Provider, { value: identity }, children);
}

export function usePublishedContext(key: string): unknown {
  return useSyncExternalStore(
    useCallback((onChange) => store.subscribe(key, onChange), [key]),
    () => store.get(key)
  );
}

export function usePublishContext(key: string): (value: unknown) => void {
  const identity = useContext(IdentityContext);
  return useCallback(
    (value: unknown) => {
      if (!identity) {
        console.warn(`usePublishContext("${key}") called outside a PortalRuntimeProvider; ignored.`);
        return;
      }
      if (identity.contextOwners[key] !== identity.scsName) {
        console.warn(
          `usePublishContext("${key}") ignored: not owned by "${identity.scsName}" ` +
            `(owner: ${identity.contextOwners[key] ?? "none — undeclared or collision-voided"}).`
        );
        return;
      }
      store.set(key, value);
    },
    [identity, key]
  );
}
```

- [ ] **Step 9: Run to verify it passes**

Run: `bun test __tests__/runtime/context.test.tsx`
Expected: PASS.

- [ ] **Step 10: Write the failing navigate tests (DOM needed)**

Create `__tests__/runtime/navigate.test.tsx`:
```tsx
import { describe, test, expect } from "bun:test";
import { withDom } from "../helpers/dom";

withDom();

describe("usePortalNavigate / useCurrentPath", () => {
  test("useCurrentPath reflects the current location", async () => {
    history.pushState(null, "", "/orders");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react-dom/test-utils");
    const { useCurrentPath } = await import("../../src/runtime/navigate");

    const seen: string[] = [];
    function Reader() {
      seen.push(useCurrentPath());
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Reader />);
    });

    expect(seen[seen.length - 1]).toBe("/orders");
  });

  test("usePortalNavigate updates history and is reflected by useCurrentPath in another mounted tree", async () => {
    history.pushState(null, "", "/orders");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react-dom/test-utils");
    const { usePortalNavigate, useCurrentPath } = await import("../../src/runtime/navigate");
    const React = await import("react");

    function Navigator() {
      const navigate = usePortalNavigate();
      React.useEffect(() => {
        navigate("/billing");
      }, [navigate]);
      return null;
    }
    const seen: string[] = [];
    function Reader() {
      seen.push(useCurrentPath());
      return null;
    }

    const containerA = document.createElement("div");
    const containerB = document.createElement("div");
    document.body.appendChild(containerA);
    document.body.appendChild(containerB);
    const rootA = createRoot(containerA);
    const rootB = createRoot(containerB);

    act(() => {
      rootB.render(<Reader />);
    });
    act(() => {
      rootA.render(<Navigator />);
    });

    expect(seen[seen.length - 1]).toBe("/billing");
    expect(window.location.pathname).toBe("/billing");
  });

  test("a browser back/forward (popstate) is reflected by useCurrentPath", async () => {
    history.pushState(null, "", "/orders");
    history.pushState(null, "", "/billing");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react-dom/test-utils");
    const { useCurrentPath } = await import("../../src/runtime/navigate");

    const seen: string[] = [];
    function Reader() {
      seen.push(useCurrentPath());
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Reader />);
    });
    expect(seen[seen.length - 1]).toBe("/billing");

    act(() => {
      history.back();
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(seen[seen.length - 1]).toBe("/orders");
  });
});
```

- [ ] **Step 11: Run to verify it fails**

Run: `bun test __tests__/runtime/navigate.test.tsx`
Expected: FAIL — `src/runtime/navigate.ts` doesn't exist yet.

- [ ] **Step 12: Implement navigation**

Create `src/runtime/navigate.ts`:
```ts
import { useCallback, useSyncExternalStore } from "react";

type Listener = () => void;
const listeners = new Set<Listener>();

export function usePortalNavigate(): (path: string) => void {
  return useCallback((path: string) => {
    history.pushState(null, "", path);
    for (const listener of [...listeners]) listener();
  }, []);
}

export function useCurrentPath(): string {
  return useSyncExternalStore(
    (onChange) => {
      const onPopState = () => onChange();
      window.addEventListener("popstate", onPopState);
      listeners.add(onChange);
      return () => {
        window.removeEventListener("popstate", onPopState);
        listeners.delete(onChange);
      };
    },
    () => window.location.pathname
  );
}
```

- [ ] **Step 13: Run to verify it passes**

Run: `bun test __tests__/runtime/navigate.test.tsx`
Expected: PASS.

- [ ] **Step 14: Write and implement `portalFetch` (no DOM needed)**

Create `__tests__/runtime/fetch.test.ts`:
```ts
import { describe, test, expect, mock } from "bun:test";
import { portalFetch } from "../../src/runtime/fetch";

describe("portalFetch", () => {
  test("attaches the X-Portal-Data marker header", async () => {
    const originalFetch = globalThis.fetch;
    const calls: [string, RequestInit | undefined][] = [];
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
      calls.push([String(input), init]);
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;

    try {
      await portalFetch("/orders");
      const [, init] = calls[0];
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Portal-Data")).toBe("1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves caller-supplied headers alongside the marker", async () => {
    const originalFetch = globalThis.fetch;
    const calls: [string, RequestInit | undefined][] = [];
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
      calls.push([String(input), init]);
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;

    try {
      await portalFetch("/orders", { headers: { "Content-Type": "application/json" } });
      const [, init] = calls[0];
      const headers = new Headers(init?.headers);
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("X-Portal-Data")).toBe("1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

Create `src/runtime/fetch.ts`:
```ts
export function portalFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Portal-Data", "1");
  return fetch(input, { ...init, headers });
}
```

- [ ] **Step 15: Run to verify it passes**

Run: `bun test __tests__/runtime/fetch.test.ts`
Expected: PASS.

- [ ] **Step 16: Write the barrel**

Create `src/runtime/index.ts`:
```ts
export { usePublishedContext, usePublishContext, PortalRuntimeProvider, type PortalIdentity } from "./context";
export { usePortalNavigate, useCurrentPath } from "./navigate";
export { portalFetch } from "./fetch";
```

- [ ] **Step 17: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 18: Commit**

```bash
git add tsconfig.json src/runtime __tests__/runtime
git commit -m "feat: add @portal/runtime (shared context, navigation, data-fetch marker)"
```

---

### Task 5: Client-side router

**Files:**
- Create: `src/frontend/router.ts`, `__tests__/frontend/router.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RouteTableEntry = { path: string; scsName: string; requiredRoles: string[]; component?: string }`, `RouteResolution` (a discriminated union), `resolveRoute(table: RouteTableEntry[], path: string, userRoles: string[]): RouteResolution`. This type is the contract Task 6's server-side `buildRouteTable` and Task 9's shell both depend on.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/frontend/router.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { resolveRoute, type RouteTableEntry } from "../../src/frontend/router";

const table: RouteTableEntry[] = [
  { path: "/orders", scsName: "orders", requiredRoles: ["orders:viewer"], component: "OrdersView" },
  { path: "/orders/summary", scsName: "orders", requiredRoles: ["orders:viewer"] }, // data-only, no component
  { path: "/public", scsName: "misc", requiredRoles: [], component: "PublicView" },
];

describe("resolveRoute", () => {
  test("returns not_found for a path with no matching entry", () => {
    expect(resolveRoute(table, "/unknown", [])).toEqual({ status: "not_found" });
  });

  test("returns forbidden when the user lacks every required role", () => {
    expect(resolveRoute(table, "/orders", [])).toEqual({ status: "forbidden", requiredRoles: ["orders:viewer"] });
  });

  test("returns matched when the user holds a required role", () => {
    expect(resolveRoute(table, "/orders", ["orders:viewer"])).toEqual({
      status: "matched",
      entry: table[0],
    });
  });

  test("returns matched for a public route (empty requiredRoles) regardless of roles", () => {
    expect(resolveRoute(table, "/public", [])).toEqual({ status: "matched", entry: table[2] });
  });

  test("returns no_component for a matched data-only route", () => {
    expect(resolveRoute(table, "/orders/summary", ["orders:viewer"])).toEqual({ status: "no_component" });
  });

  test("path matching is exact — a trailing slash does not match", () => {
    expect(resolveRoute(table, "/orders/", ["orders:viewer"])).toEqual({ status: "not_found" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test __tests__/frontend/router.test.ts`
Expected: FAIL — `src/frontend/router.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/frontend/router.ts`:
```ts
export type RouteTableEntry = {
  path: string;
  scsName: string;
  requiredRoles: string[];
  component?: string;
};

export type RouteResolution =
  | { status: "not_found" }
  | { status: "forbidden"; requiredRoles: string[] }
  | { status: "no_component" }
  | { status: "matched"; entry: RouteTableEntry };

// Client-side only — a UX gate to decide what to render, never the security
// boundary. Exact-path matching, same as the server-side route index (no
// trailing-slash normalization, no parameterized/prefix routes).
export function resolveRoute(table: RouteTableEntry[], path: string, userRoles: string[]): RouteResolution {
  const entry = table.find((r) => r.path === path);
  if (!entry) return { status: "not_found" };
  const allowed = entry.requiredRoles.length === 0 || entry.requiredRoles.some((r) => userRoles.includes(r));
  if (!allowed) return { status: "forbidden", requiredRoles: entry.requiredRoles };
  if (!entry.component) return { status: "no_component" };
  return { status: "matched", entry };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test __tests__/frontend/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/router.ts __tests__/frontend/router.test.ts
git commit -m "feat: add client-side exact-path route resolver"
```

---

### Task 6: Server — route table + context owners (`GET /routes`)

**Files:**
- Modify: `src/rights/route-access.ts`, `src/server.ts`
- Create: `src/shell/route-table.ts`, `__tests__/shell/route-table.test.ts`
- Test: extend `__tests__/rights/route-access.test.ts`, add a new `describe("GET /routes", ...)` block to `__tests__/server/composition.test.ts`

**Interfaces:**
- Consumes: `RouteTableEntry` (type only) from `src/frontend/router.ts` (Task 5); `RouteIndex` from `src/rights/route-access.ts`; `ContextIndex` from `src/rights/context-index.ts` (Task 3).
- Produces: `RouteIndexEntry` gains `component?: string`; `buildRouteTable(index: RouteIndex): RouteTableEntry[]`; `buildContextOwners(index: ContextIndex): Record<string, string>`; `GET /routes` on the server, returning `{ routes: RouteTableEntry[]; contextOwners: Record<string,string> }`.

- [ ] **Step 1: Write the failing `RouteIndexEntry.component` tests**

Add to `__tests__/rights/route-access.test.ts` (new test in the existing `describe("buildRouteIndex", ...)` block):
```ts
  test("propagates a route's component name into the index", () => {
    const index = buildRouteIndex([
      {
        baseUrl: "http://orders.local",
        manifest: {
          name: "orders",
          routes: [{ path: "/orders", requiredRoles: [], component: "OrdersView" }],
          nav: [],
          publishesContext: [],
          consumesContext: [],
        },
        stale: false,
        lastFetchedAt: Date.now(),
      },
    ]);
    expect(index.routes.get("/orders")?.component).toBe("OrdersView");
  });

  test("omits component from the index for a data-only route", () => {
    const index = buildRouteIndex([
      {
        baseUrl: "http://orders.local",
        manifest: {
          name: "orders",
          routes: [{ path: "/orders/summary", requiredRoles: [] }],
          nav: [],
          publishesContext: [],
          consumesContext: [],
        },
        stale: false,
        lastFetchedAt: Date.now(),
      },
    ]);
    expect(index.routes.get("/orders/summary")?.component).toBeUndefined();
  });
```
(The existing `entry()` helper already produces a full `ManifestEntry`, but it hardcodes `requiredRoles` without a `component` field and doesn't accept one — these two new tests build the `ManifestEntry` inline instead of extending `entry()`'s signature, to avoid touching every existing call site of `entry()`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test __tests__/rights/route-access.test.ts`
Expected: FAIL — `RouteIndexEntry` has no `component` field yet.

- [ ] **Step 3: Extend `RouteIndexEntry` and `buildRouteIndex`**

In `src/rights/route-access.ts`, change:
```ts
export type RouteIndexEntry = {
  scsName: string;
  baseUrl: string;
  requiredRoles: string[];
};
```
to:
```ts
export type RouteIndexEntry = {
  scsName: string;
  baseUrl: string;
  requiredRoles: string[];
  component?: string;
};
```
and inside `buildRouteIndex`, change:
```ts
        routes.set(route.path, { scsName, baseUrl: entry.baseUrl, requiredRoles: [...route.requiredRoles] });
```
to:
```ts
        routes.set(route.path, {
          scsName,
          baseUrl: entry.baseUrl,
          requiredRoles: [...route.requiredRoles],
          ...(route.component ? { component: route.component } : {}),
        });
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test __tests__/rights/route-access.test.ts`
Expected: PASS. Existing tests in this file that `.toEqual(...)` a `RouteIndexEntry` without `component` must still pass unchanged — `component` is only present as a key when truthy, so an entry with no component has no `component` key at all, matching those existing exact-equality assertions.

- [ ] **Step 5: Write the failing `buildRouteTable`/`buildContextOwners` tests**

Create `__tests__/shell/route-table.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { buildRouteTable, buildContextOwners } from "../../src/shell/route-table";
import { buildRouteIndex } from "../../src/rights/route-access";
import { buildContextIndex } from "../../src/rights/context-index";
import type { ManifestEntry } from "../../src/scs/manifest-registry";

function entry(name: string, opts: { routes?: any[]; publishesContext?: string[] } = {}): ManifestEntry {
  return {
    baseUrl: `http://${name}.local`,
    manifest: {
      name,
      routes: opts.routes ?? [],
      nav: [],
      publishesContext: opts.publishesContext ?? [],
      consumesContext: [],
    },
    stale: false,
    lastFetchedAt: Date.now(),
  };
}

describe("buildRouteTable", () => {
  test("flattens the route index into a table, carrying component through", () => {
    const index = buildRouteIndex([
      entry("orders", { routes: [{ path: "/orders", requiredRoles: ["orders:viewer"], component: "OrdersView" }] }),
    ]);
    expect(buildRouteTable(index)).toEqual([
      { path: "/orders", scsName: "orders", requiredRoles: ["orders:viewer"], component: "OrdersView" },
    ]);
  });

  test("a data-only route (no component) has no component key in the table entry", () => {
    const index = buildRouteIndex([entry("orders", { routes: [{ path: "/orders/summary", requiredRoles: [] }] })]);
    const table = buildRouteTable(index);
    expect(table[0]).toEqual({ path: "/orders/summary", scsName: "orders", requiredRoles: [] });
    expect(table[0].component).toBeUndefined();
  });

  test("returns an empty table for an empty index", () => {
    expect(buildRouteTable(buildRouteIndex([]))).toEqual([]);
  });
});

describe("buildContextOwners", () => {
  test("returns a plain object mapping key to owning scsName", () => {
    const index = buildContextIndex([entry("profile", { publishesContext: ["profile"] })]);
    expect(buildContextOwners(index)).toEqual({ profile: "profile" });
  });

  test("returns an empty object when nothing is published", () => {
    expect(buildContextOwners(buildContextIndex([]))).toEqual({});
  });

  test("a collision-voided key is absent", () => {
    const index = buildContextIndex([
      { ...entry("a", { publishesContext: ["shared"] }), baseUrl: "http://a.local" },
      { ...entry("b", { publishesContext: ["shared"] }), baseUrl: "http://b.local" },
    ]);
    expect(buildContextOwners(index)).toEqual({});
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `bun test __tests__/shell/route-table.test.ts`
Expected: FAIL — `src/shell/route-table.ts` doesn't exist yet.

- [ ] **Step 7: Implement**

Create `src/shell/route-table.ts`:
```ts
import type { RouteIndex } from "../rights/route-access";
import type { ContextIndex } from "../rights/context-index";
import type { RouteTableEntry } from "../frontend/router";

export function buildRouteTable(index: RouteIndex): RouteTableEntry[] {
  const table: RouteTableEntry[] = [];
  for (const [path, entry] of index.routes) {
    table.push({
      path,
      scsName: entry.scsName,
      requiredRoles: entry.requiredRoles,
      ...(entry.component ? { component: entry.component } : {}),
    });
  }
  return table;
}

export function buildContextOwners(index: ContextIndex): Record<string, string> {
  return Object.fromEntries(index.owners);
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `bun test __tests__/shell/route-table.test.ts`
Expected: PASS.

- [ ] **Step 9: Wire `GET /routes` into the server**

In `src/server.ts`, add to the imports:
```ts
import { buildContextIndex, type ContextIndex } from "./rights/context-index";
import { buildRouteTable, buildContextOwners } from "./shell/route-table";
```
Add a `contextIndex` variable alongside the existing `routeIndex`, rebuilt in the same places `routeIndex` is:
```ts
  let routeIndex: RouteIndex = { routes: new Map(), collisions: [] };
  let contextIndex: ContextIndex = { owners: new Map(), collisions: [] };
```
and inside the existing `if (manifestRegistry) { ... }` block, change:
```ts
    routeIndex = buildRouteIndex(manifestRegistry.getManifests());
    logCollisionsIfChanged(routeIndex);
    manifestRegistry.onUpdate(() => {
      routeIndex = buildRouteIndex(manifestRegistry.getManifests());
      logCollisionsIfChanged(routeIndex);
    });
```
to:
```ts
    routeIndex = buildRouteIndex(manifestRegistry.getManifests());
    contextIndex = buildContextIndex(manifestRegistry.getManifests());
    logCollisionsIfChanged(routeIndex);
    logContextCollisionsIfChanged(contextIndex);
    manifestRegistry.onUpdate(() => {
      routeIndex = buildRouteIndex(manifestRegistry.getManifests());
      contextIndex = buildContextIndex(manifestRegistry.getManifests());
      logCollisionsIfChanged(routeIndex);
      logContextCollisionsIfChanged(contextIndex);
    });
```
Add a `logContextCollisionsIfChanged` function right after the existing `logCollisionsIfChanged`, following the exact same shape (separate `lastLogged` state so route and context collision logging don't clobber each other):
```ts
  let lastLoggedContextCollisions = "";
  function logContextCollisionsIfChanged(index: ContextIndex): void {
    try {
      if (index.collisions.length === 0) return;
      const serialized = JSON.stringify(index.collisions);
      if (serialized === lastLoggedContextCollisions) return;
      lastLoggedContextCollisions = serialized;
      console.error("shared-context key collisions detected (keys disabled until resolved):", index.collisions);
    } catch {
      // never allow a logging failure to propagate into the caller.
    }
  }
```
Add the `GET /routes` handler right after the existing `/nav` block:
```ts
      if (url.pathname === "/routes" && req.method === "GET") {
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        if (!userId) return json({ error: "unauthorized" }, 401);
        return json({ routes: buildRouteTable(routeIndex), contextOwners: buildContextOwners(contextIndex) });
      }
```

- [ ] **Step 10: Write the failing `GET /routes` server tests**

Add to `__tests__/server/composition.test.ts` (new `describe` block; reuses the file's existing `beforeEach`-configured `portal`, `db`, `userId`, `accessToken`, `fakeScs`, `scsManifest`):
```ts
describe("GET /routes", () => {
  test("an unauthenticated request returns 401", async () => {
    const response = await fetch(`${portal.url}routes`);
    expect(response.status).toBe(401);
  });

  test("an authenticated request returns the full table, unfiltered by the caller's roles", async () => {
    // this user holds no roles at all, yet still sees /orders and its requiredRoles
    const response = await fetch(`${portal.url}routes`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { routes: { path: string; scsName: string; requiredRoles: string[] }[] };
    expect(body.routes).toEqual([{ path: "/orders", scsName: "orders", requiredRoles: ["orders:admin"] }]);
  });

  test("includes the component name when the manifest declares one", async () => {
    scsManifest = {
      name: "orders",
      routes: [{ path: "/orders", requiredRoles: ["orders:admin"], component: "OrdersView" }] as any,
      nav: [],
    };
    await new Promise((resolve) => setTimeout(resolve, 40));

    const response = await fetch(`${portal.url}routes`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json()) as { routes: { component?: string }[] };
    expect(body.routes[0].component).toBe("OrdersView");
  });

  test("includes contextOwners for a manifest declaring publishesContext", async () => {
    scsManifest = {
      name: "orders",
      routes: [{ path: "/orders", requiredRoles: ["orders:admin"] }],
      nav: [],
      publishesContext: ["orderStatus"],
    } as any;
    await new Promise((resolve) => setTimeout(resolve, 40));

    const response = await fetch(`${portal.url}routes`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json()) as { contextOwners: Record<string, string> };
    expect(body.contextOwners).toEqual({ orderStatus: "orders" });
  });
});
```
Also update this file's `scsManifest` type declaration (near the top) from:
```ts
let scsManifest: { name: string; routes: { path: string; requiredRoles: string[] }[]; nav: [] };
```
to:
```ts
let scsManifest: {
  name: string;
  routes: { path: string; requiredRoles: string[]; component?: string }[];
  nav: [];
  publishesContext?: string[];
};
```

- [ ] **Step 11: Run to verify it fails, then passes**

Run: `bun test __tests__/server/composition.test.ts`
Expected: FAIL first (no `/routes` handler), then PASS after Step 9's server changes (already made above — re-run to confirm).

- [ ] **Step 12: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 13: Commit**

```bash
git add src/rights/route-access.ts src/shell/route-table.ts src/server.ts __tests__/rights/route-access.test.ts __tests__/shell/route-table.test.ts __tests__/server/composition.test.ts
git commit -m "feat: add GET /routes (unfiltered route table + shared-context owners)"
```

---

### Task 7: Server — bundle proxy endpoint

**Files:**
- Modify: `src/server.ts`
- Test: extend `__tests__/server/composition.test.ts`

**Interfaces:**
- Consumes: `manifestRegistry.getManifests()` (existing).
- Produces: `GET /_scs/:scsName/bundle.js` — 401 unauthenticated, 404 unknown `scsName` or no `bundle` declared, 502 unreachable/redirecting SCS, else 200 with the SCS's bundle bytes and its own `Content-Type` (fallback `text/javascript; charset=utf-8`).

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/server/composition.test.ts` (new `describe` block; this file's fake SCS already serves `/.portal/manifest` — extend its handler to also serve a bundle file, and set `scsManifest.bundle` in the relevant tests):
```ts
describe("GET /_scs/:scsName/bundle.js", () => {
  test("an unauthenticated request returns 401", async () => {
    const response = await fetch(`${portal.url}_scs/orders/bundle.js`);
    expect(response.status).toBe(401);
  });

  test("a request for an unknown scsName returns 404", async () => {
    const response = await fetch(`${portal.url}_scs/unknown-scs/bundle.js`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(404);
  });

  test("a request for an SCS with no declared bundle returns 404", async () => {
    // default scsManifest (set in beforeEach) has no bundle field
    const response = await fetch(`${portal.url}_scs/orders/bundle.js`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(404);
  });

  test("proxies the SCS's bundle bytes and content-type when declared, with no role check", async () => {
    scsManifest = { name: "orders", bundle: "/.portal/bundle.js", routes: [], nav: [] } as any;
    await new Promise((resolve) => setTimeout(resolve, 40));
    // userId/accessToken (from beforeEach) hold no roles at all — bundle fetch must still succeed
    const response = await fetch(`${portal.url}_scs/orders/bundle.js`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(await response.text()).toBe("export const OrdersView = () => null;");
  });

  test("an unreachable SCS returns a clean 502", async () => {
    scsManifest = { name: "orders", bundle: "/.portal/bundle.js", routes: [], nav: [] } as any;
    await new Promise((resolve) => setTimeout(resolve, 40));
    fakeScs.stop(true);
    const response = await fetch(`${portal.url}_scs/orders/bundle.js`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(502);
  });
});
```
Extend this file's fake SCS `fetch` handler to add a bundle route (alongside the existing `/.portal/manifest` and `/orders` branches):
```ts
      if (url.pathname === "/.portal/bundle.js") {
        return new Response("export const OrdersView = () => null;", {
          status: 200,
          headers: { "Content-Type": "text/javascript; charset=utf-8" },
        });
      }
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test __tests__/server/composition.test.ts`
Expected: FAIL — no `/_scs/*` handler yet.

- [ ] **Step 3: Implement**

In `src/server.ts`, add the bundle proxy handler right after the `GET /routes` block from Task 6:
```ts
      const bundleMatch = url.pathname.match(/^\/_scs\/([^/]+)\/bundle\.js$/);
      if (bundleMatch && req.method === "GET") {
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        if (!userId) return json({ error: "unauthorized" }, 401);
        const requestedScsName = bundleMatch[1];
        // Resolved by the manifest's self-declared name, same trust posture
        // already accepted elsewhere in this codebase for that field (see
        // specification.md's role-namespace-filtering open question) — first
        // match wins, bounded by the existing operator-trusted, static
        // base-URL list.
        const scsEntry = (manifestRegistry?.getManifests() ?? []).find(
          (entry) => entry.manifest?.name === requestedScsName && entry.manifest.bundle
        );
        if (!scsEntry || !scsEntry.manifest?.bundle) return json({ error: "not found" }, 404);
        try {
          const bundleResponse = await fetch(`${scsEntry.baseUrl}${scsEntry.manifest.bundle}`, {
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
          });
          if (bundleResponse.status >= 300 && bundleResponse.status < 400) {
            console.error(`bundle fetch for ${requestedScsName} returned an unexpected redirect`);
            return json({ error: "scs fetch failed" }, 502);
          }
          if (!bundleResponse.ok) {
            console.error(`bundle fetch for ${requestedScsName} failed with status ${bundleResponse.status}`);
            return json({ error: "scs fetch failed" }, 502);
          }
          const body = await bundleResponse.arrayBuffer();
          return new Response(body, {
            status: 200,
            headers: {
              "Content-Type": bundleResponse.headers.get("Content-Type") ?? "text/javascript; charset=utf-8",
            },
          });
        } catch (err) {
          console.error("bundle fetch failed", err);
          return json({ error: "scs fetch failed" }, 502);
        }
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test __tests__/server/composition.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts __tests__/server/composition.test.ts
git commit -m "feat: add GET /_scs/:scsName/bundle.js (auth-required, not role-gated)"
```

---

### Task 8: Server — shell HTML + page/data content negotiation

**⚠ This task changes the meaning of a bare `GET` to an SCS-enforceable path.** Before this task, an unauthenticated `GET /orders` returned 401 and an unknown path returned 404. After this task, those same bare requests (no `X-Portal-Data: 1` header) return 200 with the shell's HTML instead — the 401/403/404 behavior still exists, but only for requests carrying that header. This is a deliberate, spec'd change (see `specification.md`'s Request flow section) — go through `__tests__/server/composition.test.ts` and add the header to every existing test that expects the old data-fetch behavior; do not weaken any of those tests' assertions, only add the header to their `fetch()` calls so they keep testing what they were testing before.

**Files:**
- Create: `src/shell/bootstrap-html.ts`, `__tests__/shell/bootstrap-html.test.ts`
- Modify: `src/server.ts`, `__tests__/server/composition.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `renderShellHtml(): string` (static, no per-request data). Server behavior: any `GET` without `X-Portal-Data: 1`, not matching an earlier fixed route, returns 200 + shell HTML, for any path, any auth state.

- [ ] **Step 1: Write the failing `renderShellHtml` tests**

Create `__tests__/shell/bootstrap-html.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { renderShellHtml } from "../../src/shell/bootstrap-html";

describe("renderShellHtml", () => {
  test("includes an import map resolving react, react-dom/client, and @portal/runtime", () => {
    const html = renderShellHtml();
    expect(html).toContain('type="importmap"');
    expect(html).toContain('"react": "/_shell/react.js"');
    expect(html).toContain('"react-dom/client": "/_shell/react-dom.js"');
    expect(html).toContain('"@portal/runtime": "/_shell/runtime.js"');
  });

  test("includes a root mount element and the shell's own module script", () => {
    const html = renderShellHtml();
    expect(html).toContain('id="portal-root"');
    expect(html).toContain('<script type="module" src="/_shell/shell.js">');
  });

  test("is a complete, well-formed HTML document", () => {
    const html = renderShellHtml();
    expect(html.trim().toLowerCase().startsWith("<!doctype html>")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test __tests__/shell/bootstrap-html.test.ts`
Expected: FAIL — `src/shell/bootstrap-html.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/shell/bootstrap-html.ts`:
```ts
// Static bootstrap page: no per-request data. The four /_shell/* URLs below
// don't exist as real endpoints until a later task adds them (see this
// plan's Task 9) — this file only needs to produce correct, stable HTML
// structure; it doesn't need those endpoints to work yet.
export function renderShellHtml(): string {
  const importMap = {
    imports: {
      react: "/_shell/react.js",
      "react-dom/client": "/_shell/react-dom.js",
      "@portal/runtime": "/_shell/runtime.js",
    },
  };
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Portal</title>
<script type="importmap">${JSON.stringify(importMap)}</script>
</head>
<body>
<div id="portal-root"></div>
<script type="module" src="/_shell/shell.js"></script>
</body>
</html>`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test __tests__/shell/bootstrap-html.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the content-negotiation split into the server**

In `src/server.ts`, add to the imports:
```ts
import { renderShellHtml } from "./shell/bootstrap-html";
```
Change the tail of the `fetch` handler from:
```ts
      if (manifestRegistry && req.method === "GET") {
        // ...existing composition logic, unchanged...
      }

      return json({ error: "not found" }, 404);
```
to:
```ts
      // Page navigation: any GET without the shell's data-marker header, that
      // didn't match one of Portal's own fixed routes above, always gets the
      // shell bootstrap HTML — any path, any auth state. See specification.md's
      // Request flow section for why this replaced the old "401 before the
      // route index is even consulted" behavior for page loads specifically.
      if (req.method === "GET" && req.headers.get("X-Portal-Data") !== "1") {
        return new Response(renderShellHtml(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (manifestRegistry && req.method === "GET") {
        // ...existing composition logic, unchanged...
      }

      return json({ error: "not found" }, 404);
```
(Leave the composition logic inside the second `if` block completely untouched — only the new block above it and the removal of nothing else.)

- [ ] **Step 6: Update every existing data-fetch test in `composition.test.ts` to carry the marker header**

Every test in the `describe("route composition", ...)` block that calls `fetch(`${portal.url}orders...`, ...)` (directly, not through `/routes` or `/_scs/*`, which are unaffected — those are Portal's own fixed routes, matched before this new branch) needs `"X-Portal-Data": "1"` added to its request headers. Concretely, for each of: "an unauthenticated request to an enforceable route returns 401", "an authenticated request without the required role returns a generic 403", "an authenticated request with the required role fetches and forwards the SCS fragment", "roles from unrelated SCSs are not forwarded in the internal token", "a path no manifest declares returns 404", "a trailing slash on the request path is normalized before matching", "a query string doesn't affect route matching but is forwarded to the SCS", "a public route (empty requiredRoles) is accessible to any authenticated user", "the cached route index reflects a manifest change after the registry refreshes", "an unreachable SCS fragment endpoint returns a clean 502", "the SCS fragment fetch does not follow redirects and returns a 502 instead" — add `"X-Portal-Data": "1"` into that test's `headers` object (creating a `headers` object if the test's current `fetch()` call has none, as in the unauthenticated-401 and not-found tests). The two tests that don't need this ("pre-existing Portal routes still work when a registry is configured", which hits `/health` and `/me`; "a non-GET request to an enforceable path falls through to 404", which is a `POST`) are unaffected — leave them exactly as they are.

- [ ] **Step 7: Write the failing page-navigation tests**

Add to `__tests__/server/composition.test.ts`, a new `describe` block:
```ts
describe("page navigation (no X-Portal-Data header)", () => {
  test("an unauthenticated GET to an enforceable path returns the shell HTML, not 401", async () => {
    const response = await fetch(`${portal.url}orders`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(await response.text()).toContain('id="portal-root"');
  });

  test("an authenticated GET to an enforceable path also returns the shell HTML", async () => {
    const response = await fetch(`${portal.url}orders`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="portal-root"');
  });

  test("a totally unknown path also returns the shell HTML (SPA fallback)", async () => {
    const response = await fetch(`${portal.url}this-path-has-no-route`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="portal-root"');
  });

  test("root path returns the shell HTML", async () => {
    const response = await fetch(portal.url.toString());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="portal-root"');
  });
});
```

- [ ] **Step 8: Run to verify all of Task 8's changes are correct**

Run: `bun test __tests__/server/composition.test.ts`
Expected: PASS — both the updated data-fetch tests (now carrying the header) and the new page-navigation tests.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean. Double-check the total pass count only dropped/changed where this task's diff explains it — no unrelated regressions in `__tests__/server/nav.test.ts`, `admin.test.ts`, `admin-bootstrap.test.ts`, `auth-flow.test.ts`, `health.test.ts`, `secrets.test.ts` (all of which hit only Portal's own fixed routes, and should be completely unaffected by this task).

- [ ] **Step 10: Commit**

```bash
git add src/shell/bootstrap-html.ts src/server.ts __tests__/shell/bootstrap-html.test.ts __tests__/server/composition.test.ts
git commit -m "feat: serve shell HTML for page navigation, gate the composition proxy on X-Portal-Data"
```

---

### Task 9: Client shell app + bundling + `/_shell/*` asset serving

**Files:**
- Create: `src/frontend/shell-entry.tsx`, `src/frontend/shell-boot.tsx`, `src/shell/vendor/react-entry.ts`, `src/shell/vendor/react-dom-entry.ts`, `src/shell/bundle.ts`
- Test: `__tests__/frontend/shell-entry.test.tsx`, `__tests__/shell/bundle.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `resolveRoute`/`RouteTableEntry` (Task 5), `@portal/runtime`'s `portalFetch`/`PortalRuntimeProvider`/`useCurrentPath` (Task 4), `renderShellHtml` (Task 8, unmodified by this task).
- Produces: `getShellAssets(): Promise<{ reactJs: string; reactDomJs: string; runtimeJs: string; shellJs: string }>` (lazily built, cached); a mounted `App` component in `shell-entry.tsx`, exported with an injectable `loadComponent` for testing; `GET /_shell/{react,react-dom,runtime,shell}.js` on the server.

- [ ] **Step 1: Write the vendor entry points**

Create `src/shell/vendor/react-entry.ts`:
```ts
export * from "react";
export { default } from "react";
```
Create `src/shell/vendor/react-dom-entry.ts`:
```ts
export * from "react-dom/client";
```

- [ ] **Step 2: Write the failing `getShellAssets` tests**

Create `__tests__/shell/bundle.test.ts`:
```ts
import { describe, test, expect } from "bun:test";
import { getShellAssets } from "../../src/shell/bundle";

describe("getShellAssets", () => {
  test("builds all four assets as non-empty JS text", async () => {
    const assets = await getShellAssets();
    expect(assets.reactJs.length).toBeGreaterThan(0);
    expect(assets.reactDomJs.length).toBeGreaterThan(0);
    expect(assets.runtimeJs.length).toBeGreaterThan(0);
    expect(assets.shellJs.length).toBeGreaterThan(0);
  });

  test("the react-dom bundle imports react as an external, not a bundled copy", async () => {
    const assets = await getShellAssets();
    expect(assets.reactDomJs).toMatch(/from\s*["']react["']/);
  });

  test("the runtime and shell bundles import react as an external", async () => {
    const assets = await getShellAssets();
    expect(assets.runtimeJs).toMatch(/from\s*["']react["']/);
    expect(assets.shellJs).toMatch(/from\s*["']react["']/);
  });

  test("the shell bundle imports @portal/runtime as an external, not inlined", async () => {
    const assets = await getShellAssets();
    expect(assets.shellJs).toMatch(/from\s*["']@portal\/runtime["']/);
  });

  test("repeated calls return the same cached build (do not rebuild every time)", async () => {
    const first = await getShellAssets();
    const second = await getShellAssets();
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test __tests__/shell/bundle.test.ts`
Expected: FAIL — `src/shell/bundle.ts` and `src/frontend/shell-entry.tsx` don't exist yet.

- [ ] **Step 4: Write the shell app**

Create `src/frontend/shell-entry.tsx`:
```tsx
import { createRoot } from "react-dom/client";
import { Component, useEffect, useState, type ReactNode } from "react";
import { PortalRuntimeProvider, portalFetch, useCurrentPath } from "@portal/runtime";
import { resolveRoute, type RouteTableEntry } from "./router";

export type ComponentLoader = (bundleUrl: string) => Promise<Record<string, unknown>>;

const defaultLoader: ComponentLoader = (bundleUrl) => import(/* @vite-ignore */ bundleUrl);

type Me = { id: string; roles: string[] } | null;
type RoutesResponse = { routes: RouteTableEntry[]; contextOwners: Record<string, string> };
type Status = "loading" | "login" | "forbidden" | "not_found" | "ready";

class MountErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) return <div>This view failed to load.</div>;
    return this.props.children;
  }
}

export function App({ loadComponent = defaultLoader }: { loadComponent?: ComponentLoader }) {
  const path = useCurrentPath();
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [routesData, setRoutesData] = useState<RoutesResponse | null>(null);
  const [mounted, setMounted] = useState<{ Component: React.ComponentType; scsName: string } | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  // Boot once: identity + the full route table.
  useEffect(() => {
    (async () => {
      const meResponse = await portalFetch("/me");
      if (meResponse.status === 401) {
        setMe(null);
        setStatus("login");
        return;
      }
      const meJson = (await meResponse.json()) as NonNullable<Me>;
      setMe(meJson);
      const routesResponse = await portalFetch("/routes");
      setRoutesData((await routesResponse.json()) as RoutesResponse);
    })();
  }, []);

  // Resolve + mount whenever the path (via usePortalNavigate/popstate) or the
  // loaded route table changes.
  useEffect(() => {
    if (me === undefined || me === null || !routesData) return;
    let cancelled = false;
    (async () => {
      const resolution = resolveRoute(routesData.routes, path, me.roles);
      if (resolution.status === "not_found" || resolution.status === "no_component") {
        if (!cancelled) {
          setStatus("not_found");
          setMounted(null);
        }
        return;
      }
      if (resolution.status === "forbidden") {
        if (!cancelled) {
          setStatus("forbidden");
          setMounted(null);
        }
        return;
      }
      const module = await loadComponent(`/_scs/${resolution.entry.scsName}/bundle.js`);
      const ResolvedComponent = module[resolution.entry.component!] as React.ComponentType | undefined;
      if (cancelled) return;
      if (!ResolvedComponent) {
        setStatus("not_found");
        setMounted(null);
        return;
      }
      setMounted({ Component: ResolvedComponent, scsName: resolution.entry.scsName });
      setStatus("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [me, routesData, path, loadComponent]);

  if (status === "loading") return <div>Loading…</div>;
  if (status === "login") return <div>Please log in.</div>;
  if (status === "forbidden") return <div>You don't have access to this page.</div>;
  if (status === "not_found") return <div>Not found.</div>;

  const { Component: Mounted, scsName } = mounted!;
  return (
    <MountErrorBoundary>
      <PortalRuntimeProvider scsName={scsName} contextOwners={routesData!.contextOwners}>
        <Mounted />
      </PortalRuntimeProvider>
    </MountErrorBoundary>
  );
}

```
This file has no auto-mount side effect — it only exports `App`, so a test file can import it directly and control mounting itself (see Step 7).

Create `src/frontend/shell-boot.tsx` (the real bundle entrypoint — see Step 9's `getShellAssets` wiring — kept separate from `shell-entry.tsx` specifically so importing `App` in a test never triggers a real `createRoot`/DOM-mount side effect; `.tsx` because it uses JSX to render `<App />`):
```tsx
import { createRoot } from "react-dom/client";
import { App } from "./shell-entry";

const container = document.getElementById("portal-root");
if (container) createRoot(container).render(<App />);
```

- [ ] **Step 5: Implement `getShellAssets`**

Create `src/shell/bundle.ts`:
```ts
export type ShellAssets = {
  reactJs: string;
  reactDomJs: string;
  runtimeJs: string;
  shellJs: string;
};

let cached: Promise<ShellAssets> | null = null;

async function buildOne(entrypoint: string, external: string[] = []): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    format: "esm",
    target: "browser",
    external,
  });
  if (!result.success) {
    throw new Error(`bundle build failed for ${entrypoint}: ${result.logs.map((l) => l.message).join("; ")}`);
  }
  return await result.outputs[0].text();
}

// Lazy + memoized: createServer() stays synchronous (every existing test
// depends on that), so bundling happens on first request to any /_shell/*
// asset, not at server construction time. All builds share one cache across
// every createServer() instance in a process, since the bundled output only
// depends on this repo's own source files, never on server instance config.
export function getShellAssets(): Promise<ShellAssets> {
  if (!cached) {
    cached = (async () => {
      const [reactJs, reactDomJs, runtimeJs, shellJs] = await Promise.all([
        buildOne(new URL("./vendor/react-entry.ts", import.meta.url).pathname),
        buildOne(new URL("./vendor/react-dom-entry.ts", import.meta.url).pathname, ["react"]),
        buildOne(new URL("../runtime/index.ts", import.meta.url).pathname, ["react"]),
        buildOne(new URL("../frontend/shell-boot.tsx", import.meta.url).pathname, [
          "react",
          "react-dom/client",
          "@portal/runtime",
        ]),
      ]);
      return { reactJs, reactDomJs, runtimeJs, shellJs };
    })();
  }
  return cached;
}
```

- [ ] **Step 6: Run to verify `getShellAssets` passes**

Run: `bun test __tests__/shell/bundle.test.ts`
Expected: PASS. If `Bun.build` fails on the `@portal/runtime` external (Bun's bundler may need the exact specifier string to match, not the tsconfig-aliased path), check the actual error output — `external` must list the literal string as it appears in `shell-entry.tsx`'s `import` statements (`"@portal/runtime"`), which it already does above.

- [ ] **Step 7: Write the failing `shell-entry` App tests (DOM needed, injected loader — no real network/import-map resolution)**

Create `__tests__/frontend/shell-entry.test.tsx`:
```tsx
import { describe, test, expect, mock } from "bun:test";
import { withDom } from "../helpers/dom";

withDom();

function mockFetchSequence(responses: { path: string; status: number; body: unknown }[]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (input: any) => {
    const url = new URL(String(input), "http://localhost");
    const match = responses.find((r) => url.pathname === r.path);
    if (!match) return new Response("not mocked", { status: 500 });
    return new Response(JSON.stringify(match.body), { status: match.status });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe("shell App", () => {
  test("shows a login prompt when /me is 401", async () => {
    const restore = mockFetchSequence([{ path: "/me", status: 401, body: { error: "unauthorized" } }]);
    try {
      const { createRoot } = await import("react-dom/client");
      const { act } = await import("react-dom/test-utils");
      const { App } = await import("../../src/frontend/shell-entry");

      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {}); // flush the boot effect's microtasks

      expect(container.textContent).toContain("Please log in");
    } finally {
      restore();
    }
  });

  test("shows a forbidden state when the resolved route requires a role the user lacks", async () => {
    history.pushState(null, "", "/orders");
    const restore = mockFetchSequence([
      { path: "/me", status: 200, body: { id: "u1", roles: [] } },
      {
        path: "/routes",
        status: 200,
        body: {
          routes: [{ path: "/orders", scsName: "orders", requiredRoles: ["orders:viewer"], component: "OrdersView" }],
          contextOwners: {},
        },
      },
    ]);
    try {
      const { createRoot } = await import("react-dom/client");
      const { act } = await import("react-dom/test-utils");
      const { App } = await import("../../src/frontend/shell-entry");

      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {});
      await act(async () => {});

      expect(container.textContent).toContain("don't have access");
    } finally {
      restore();
    }
  });

  test("mounts the resolved component via the injected loader, wrapped in PortalRuntimeProvider", async () => {
    history.pushState(null, "", "/orders");
    const restore = mockFetchSequence([
      { path: "/me", status: 200, body: { id: "u1", roles: ["orders:viewer"] } },
      {
        path: "/routes",
        status: 200,
        body: {
          routes: [{ path: "/orders", scsName: "orders", requiredRoles: ["orders:viewer"], component: "OrdersView" }],
          contextOwners: { profile: "profile" },
        },
      },
    ]);
    try {
      const { createRoot } = await import("react-dom/client");
      const { act } = await import("react-dom/test-utils");
      const { App } = await import("../../src/frontend/shell-entry");
      const { usePublishedContext } = await import("../../src/runtime/context");

      function OrdersView() {
        const owners = usePublishedContext("__test_probe__"); // exercises the hook path, value irrelevant here
        void owners;
        return <div>orders view</div>;
      }
      const loadComponent = mock(async (_url: string) => ({ OrdersView }));

      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<App loadComponent={loadComponent} />);
      });
      await act(async () => {});
      await act(async () => {});

      expect(loadComponent).toHaveBeenCalledWith("/_scs/orders/bundle.js");
      expect(container.textContent).toContain("orders view");
    } finally {
      restore();
    }
  });

  test("shows a not-found state when the resolved module lacks the named export", async () => {
    history.pushState(null, "", "/orders");
    const restore = mockFetchSequence([
      { path: "/me", status: 200, body: { id: "u1", roles: ["orders:viewer"] } },
      {
        path: "/routes",
        status: 200,
        body: {
          routes: [{ path: "/orders", scsName: "orders", requiredRoles: ["orders:viewer"], component: "OrdersView" }],
          contextOwners: {},
        },
      },
    ]);
    try {
      const { createRoot } = await import("react-dom/client");
      const { act } = await import("react-dom/test-utils");
      const { App } = await import("../../src/frontend/shell-entry");

      const loadComponent = mock(async (_url: string) => ({})); // no OrdersView export

      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<App loadComponent={loadComponent} />);
      });
      await act(async () => {});
      await act(async () => {});

      expect(container.textContent).toContain("Not found");
    } finally {
      restore();
    }
  });
});
```

- [ ] **Step 8: Run to verify it fails, then implement/adjust until it passes**

Run: `bun test __tests__/frontend/shell-entry.test.tsx`
Expected: FAIL first (module doesn't compile/exist correctly), then PASS once Step 4's `shell-entry.tsx` is in place. Adjust the `App` component's effect-flushing (`await act(async () => {})` calls in the test, or the component's own async structure) as needed to make state transitions observable — the test's assertions are the source of truth for "does this actually work," not the sample implementation above.

- [ ] **Step 9: Wire `/_shell/*` asset serving into the server**

In `src/server.ts`, add to the imports:
```ts
import { getShellAssets } from "./shell/bundle";
```
Add the asset-serving handler **before** Task 8's content-negotiation branch (grouped with the other fixed routes, e.g. right after the bundle-proxy block from Task 7):
```ts
      const shellAssetMatch = url.pathname.match(/^\/_shell\/(react|react-dom|runtime|shell)\.js$/);
      if (shellAssetMatch && req.method === "GET") {
        const assets = await getShellAssets();
        const byName: Record<string, string> = {
          react: assets.reactJs,
          "react-dom": assets.reactDomJs,
          runtime: assets.runtimeJs,
          shell: assets.shellJs,
        };
        return new Response(byName[shellAssetMatch[1]], {
          status: 200,
          headers: { "Content-Type": "text/javascript; charset=utf-8" },
        });
      }
```

- [ ] **Step 10: Write the failing `/_shell/*` server tests**

Add to `__tests__/server/composition.test.ts` (this file's `portal` is created without a `manifestRegistry` in some other suites — use the existing `beforeEach`-provided `portal`, which does have one; these routes don't depend on `manifestRegistry` being present, but this file's setup already includes one, which is fine):
```ts
describe("GET /_shell/*", () => {
  test("serves each asset unauthenticated, with a JS content-type", async () => {
    for (const name of ["react", "react-dom", "runtime", "shell"]) {
      const response = await fetch(`${portal.url}_shell/${name}.js`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
      const body = await response.text();
      expect(body.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 11: Run to verify it passes**

Run: `bun test __tests__/server/composition.test.ts`
Expected: PASS. This test invokes real `Bun.build()` (via `getShellAssets`, shared/cached from Task 9's other tests if they already ran in this process) — it may take a few seconds the first time; that's expected, not a bug.

- [ ] **Step 12: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 13: Manual verification (not automated — record the outcome in this task's completion note)**

`bun:test` + happy-dom cannot exercise real browser import-map resolution or real cross-network dynamic `import()` — that combination isn't something happy-dom implements. Before marking this task done, manually verify the real end-to-end path once: run `bun run dev`, open the dev server's URL in an actual browser, confirm the page loads (network tab shows `/_shell/react.js`, `/_shell/react-dom.js`, `/_shell/runtime.js`, `/_shell/shell.js`, `/me`, `/routes` all fetched successfully), and confirms the login-prompt state renders (no `manifestRegistry` is configured without `PORTAL_SCS_URLS`, so "not found"/"login" states are the only reachable ones without a real SCS — that's expected and sufficient to confirm the shell itself boots correctly in a real browser).

- [ ] **Step 14: Commit**

```bash
git add src/frontend/shell-entry.tsx src/frontend/shell-boot.tsx src/shell/vendor src/shell/bundle.ts src/server.ts __tests__/frontend/shell-entry.test.tsx __tests__/shell/bundle.test.ts __tests__/server/composition.test.ts
git commit -m "feat: add the client shell app, Bun.build-based bundling, and /_shell/* asset serving"
```

---

### Task 10: End-to-end server-side integration test

**Files:**
- Test: new `describe` block in `__tests__/server/composition.test.ts` (or a new file `__tests__/server/shell-e2e.test.ts` if the implementer judges `composition.test.ts` has grown too large — implementer's call, not a placeholder: if split, follow that file's exact existing `beforeEach`/fake-SCS setup pattern).

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: no new production code — this task is pure verification that the full manifest → route table → context owners → bundle proxy pipeline agrees end-to-end for one SCS declaring every new field at once.

- [ ] **Step 1: Write the failing end-to-end test**

Add a new `describe` block (in `__tests__/server/composition.test.ts`, reusing its `fakeScs`/`portal`/`db` setup, or in a new file following the same pattern — see Files above):
```ts
describe("end-to-end: a manifest declaring bundle, component, and context fields", () => {
  test("GET /routes, GET /_scs/:scsName/bundle.js, and context ownership all agree with one manifest", async () => {
    scsManifest = {
      name: "orders",
      bundle: "/.portal/bundle.js",
      routes: [
        { path: "/orders", requiredRoles: ["orders:admin"], component: "OrdersView" },
        { path: "/orders/summary", requiredRoles: ["orders:admin"] },
      ],
      nav: [{ label: "Orders", path: "/orders", requiredRoles: ["orders:admin"] }],
      publishesContext: ["orderStatus"],
      consumesContext: ["profile"],
    } as any;
    await new Promise((resolve) => setTimeout(resolve, 40));

    // /routes reflects both the mounted-page route and the data-only route,
    // plus the context ownership this manifest declared.
    const routesResponse = await fetch(`${portal.url}routes`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const routesBody = (await routesResponse.json()) as {
      routes: { path: string; scsName: string; requiredRoles: string[]; component?: string }[];
      contextOwners: Record<string, string>;
    };
    expect(routesBody.routes).toEqual(
      expect.arrayContaining([
        { path: "/orders", scsName: "orders", requiredRoles: ["orders:admin"], component: "OrdersView" },
        { path: "/orders/summary", scsName: "orders", requiredRoles: ["orders:admin"] },
      ])
    );
    expect(routesBody.contextOwners).toEqual({ orderStatus: "orders" });

    // The bundle Portal proxies is exactly what the SCS itself serves.
    const bundleResponse = await fetch(`${portal.url}_scs/orders/bundle.js`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(bundleResponse.status).toBe(200);
    expect(await bundleResponse.text()).toBe("export const OrdersView = () => null;");

    // The data-only route still enforces roles exactly like before this plan.
    const dataResponse = await fetch(`${portal.url}orders/summary`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });
    // this test's default accessToken/userId (from beforeEach) hold no roles
    expect(dataResponse.status).toBe(403);
  });

  test("a manifest self-declaring name \"portal\" cannot claim portal-owned context keys via publishesContext collision with a real Portal concept", async () => {
    // Sanity check that context ownership is validated the same way regardless
    // of what an SCS calls itself — no special-casing needed since ownership
    // is keyed on the declared key string, not on any reserved-name check.
    scsManifest = {
      name: "orders",
      routes: [],
      nav: [],
      publishesContext: ["profile"],
    } as any;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const response = await fetch(`${portal.url}routes`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = (await response.json()) as { contextOwners: Record<string, string> };
    expect(body.contextOwners).toEqual({ profile: "orders" });
  });
});
```

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `bun test __tests__/server/composition.test.ts` (or the new file's path)
Expected: FAIL only if any earlier task's wiring has a gap this test exposes — if so, fix the *earlier* task's code (this task adds no new production code of its own), then re-run until PASS.

- [ ] **Step 3: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add __tests__/server/composition.test.ts
git commit -m "test: add end-to-end coverage of manifest bundle/component/context fields"
```

---

## Note for the final whole-branch review

Two things worth this plan flagging explicitly, since they won't be visible from any single task's diff:

1. **Task 8 is a deliberate breaking change** to page-load semantics (401-before-route-index no longer applies to page loads, only to `X-Portal-Data`-marked requests) — confirm the final reviewer treats this as intentional (it's spec'd), not a regression to flag.
2. **Real end-to-end browser verification (import maps, cross-network dynamic `import()`) is out of automated-test scope** for this plan (Task 9, Step 13) — `bun:test` + happy-dom cannot exercise it. The final reviewer should not expect an automated test proving a real browser correctly resolves the import map; that gap is deliberate and documented, not an oversight.
