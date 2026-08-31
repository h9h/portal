# Portal Frame Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the shell a persistent header/main/footer frame — logo, nav space fed by SCS manifests, and state-dependent login/profile/logout controls — that stays mounted across every shell status instead of the shell replacing the whole page per status.

**Architecture:** A new presentational component, `PortalFrame` (`src/frontend/portal-frame.tsx`), owns the frame's layout and its three header slots (logo, nav, auth controls) plus a static footer. `App` (`src/frontend/shell-entry.tsx`) keeps its existing boot/status state machine completely unchanged — it just fetches `/nav` once at boot (a new, independent, non-fatal effect) and wraps its existing status-based content in `<PortalFrame>`. `GET /nav` (`src/server.ts`) is relaxed to allow anonymous callers, treating a missing/invalid access token as zero roles rather than 401ing, so the frame can show public nav entries before login — `buildNav` already handles empty-role filtering correctly, so this is a small, targeted change.

**Tech Stack:** Bun + `bun:test`, TypeScript, existing `react`/`react-dom`/`@happy-dom/global-registrator`, existing `@portal/runtime` hooks (`usePortalNavigate`, `usePortalLogout`, `portalFetch`). No new dependencies, no CSS framework — plain inline React style objects, consistent with the shell having no CSS at all yet. The logo is a placeholder inline SVG (no new asset-serving route).

**Spec:** `specification.md` (Architecture → Client shell: **Portal frame (persistent chrome)**; Architecture → Context model: **This stage's nav model**)

## Global Constraints

- `GET /nav` no longer requires authentication: an unauthenticated caller is treated as holding no roles (`buildNav(manifests, [])`), so only entries with empty `requiredRoles` are visible. `/me` and `/routes` are unaffected — they still 401 unauthenticated. (`specification.md`)
- The frame wraps every shell status (`loading`, `login`, `forbidden`, `not_found`, `error`, `ready`) — only the existing `<main>` content swaps; header and footer never disappear. (`specification.md`)
- Nav items are fetched once at boot, independent of `/me`'s outcome. A failed, rejected, or unmocked `/nav` fetch is **non-fatal**: caught locally, nav renders empty, and this must never flip the shell's `status` to `"error"`. (`specification.md`)
- Nav links are keyed by `domain` + `path` together, never `path` alone (duplicate paths across SCSs are legal in nav). (`specification.md`)
- Internal links (logo, nav items, profile) use `usePortalNavigate()` from a real `<a href>`'s own click handler — preserving normal `<a>` semantics (modifier-key clicks, opening in a new tab) by only intercepting a plain left-click. This is the pattern `specification.md`'s Client shell section already establishes for components that want client-side navigation from a real link.
- `/profile` is not a route any SCS has registered yet — visiting it via the header's profile link is expected to show the shell's existing "Not found." state. This plan does not add a `/profile` route or SCS.
- The footer is static placeholder content with no data source — hardcoded JSX, not fetched or configured.
- No CSS framework or build-step change. No new dependencies. (`CLAUDE.md`)
- Every feature needs a set of test cases, run via `bun:test`, files under `./__tests__`. (`CLAUDE.md`)

## File Structure

- `src/server.ts` — **modify**: `GET /nav` handler no longer 401s when unauthenticated; treats a missing/invalid token as zero roles.
- `src/frontend/portal-frame.tsx` — **new**: exports `PortalFrame`, and its prop types `Me`, `Provider`, `NavItem` (the shell's own state is typed against these).
- `src/frontend/shell-entry.tsx` — **modify**: imports `Me`/`Provider`/`NavItem`/`PortalFrame` from `./portal-frame` instead of declaring local `Me`/`Provider` types; adds a `navItems` state fetched via a new, independent, non-fatal boot effect; wraps its existing status-based render output in `<PortalFrame>`.
- Test files: modify `__tests__/server/nav.test.ts`; new `__tests__/frontend/portal-frame.test.tsx`; extend `__tests__/frontend/shell-entry.test.tsx` with two new integration tests.

---

### Task 1: Relax `GET /nav` for anonymous callers

**Files:**
- Modify: `src/server.ts`
- Test: modify `__tests__/server/nav.test.ts`

**Interfaces:**
- Consumes: nothing new — reuses the existing `getAuthenticatedUserId`, `getUserRoles`, `buildNav`.
- Produces: `GET /nav` now returns `200 { nav: [...] }` for an unauthenticated caller (role-filtered as if `roles: []`) instead of `401`. Authenticated behavior is unchanged.

- [ ] **Step 1: Update the failing test**

In `__tests__/server/nav.test.ts`, replace the existing test (inside `describe("GET /nav")`):

```ts
  test("an unauthenticated request returns 401", async () => {
    const response = await fetch(`${portal.url}nav`);
    expect(response.status).toBe(401);
  });
```

with:

```ts
  test("an unauthenticated request returns only public nav entries instead of 401", async () => {
    const response = await fetch(`${portal.url}nav`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { nav: { label: string; path: string; domain: string }[] };
    expect(body.nav).toEqual([{ label: "Orders Home", path: "/orders", domain: "orders" }]);
  });
```

This reuses the `beforeEach`-registered manifest, which already declares one public nav entry (`Orders Home`, no `requiredRoles`) and one role-gated entry (`Orders Admin`, needs `orders:admin`) — so this one test verifies both that anonymous callers get a `200` and that role-gated entries stay hidden from them.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test __tests__/server/nav.test.ts`
Expected: FAIL — the renamed test still gets a `401`, not `200`.

- [ ] **Step 3: Relax the `/nav` handler**

In `src/server.ts`, find the `GET /nav` handler:

```ts
      if (url.pathname === "/nav" && req.method === "GET") {
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        if (!userId) return json({ error: "unauthorized" }, 401);
        const userRoles = getUserRoles(db, userId);
```

Replace those three lines with:

```ts
      if (url.pathname === "/nav" && req.method === "GET") {
        // Unlike /me and /routes, an unauthenticated caller is treated as
        // holding no roles rather than rejected — the persistent portal
        // frame needs to show public nav entries before login (see
        // specification.md, Context model: This stage's nav model).
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        const userRoles = userId ? getUserRoles(db, userId) : [];
```

The rest of the handler (the `buildNav`/`return json({ nav })` lines right after) is unchanged.

- [ ] **Step 4: Run the full test file to verify it passes**

Run: `bun test __tests__/server/nav.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts __tests__/server/nav.test.ts
git commit -m "feat: allow anonymous callers on GET /nav for the persistent portal frame"
```

---

### Task 2: `PortalFrame` component

**Files:**
- Create: `src/frontend/portal-frame.tsx`
- Test: `__tests__/frontend/portal-frame.test.tsx`

**Interfaces:**
- Consumes: `usePortalNavigate`, `usePortalLogout` from `@portal/runtime` (already exist).
- Produces:
  ```ts
  export type Me = {
    id: string;
    roles: string[];
    displayName: string | null;
    email: string | null;
  } | null;

  export type Provider = { name: string; label: string };

  export type NavItem = { label: string; path: string; domain: string };

  export type PortalFrameProps = {
    me: Me | undefined; // undefined = identity still resolving
    providers: Provider[];
    navItems: NavItem[];
    children: ReactNode;
  };

  export function PortalFrame(props: PortalFrameProps): JSX.Element;
  ```
  Task 3 imports `Me`, `Provider`, `NavItem`, `PortalFrame` from this file.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/frontend/portal-frame.test.tsx`:

```tsx
import { describe, test, expect } from "bun:test";
import { withDom } from "../helpers/dom";

withDom();

function setInitialPath(path: string): void {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://localhost:3000/");
  history.pushState(null, "", path);
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

describe("PortalFrame", () => {
  test("renders a placeholder logo linking to /, and clicking it navigates there client-side", async () => {
    setInitialPath("/somewhere");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { PortalFrame } = await import("../../src/frontend/portal-frame");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <PortalFrame me={undefined} providers={[]} navItems={[]}>
            <div>content</div>
          </PortalFrame>
        );
      });

      const logoLink = container.querySelector('a[href="/"]') as HTMLAnchorElement | null;
      expect(logoLink).not.toBeNull();
      expect(logoLink!.querySelector("svg")).not.toBeNull();

      await act(async () => {
        click(logoLink!);
      });
      expect(window.location.pathname).toBe("/");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  test("renders one nav link per item keyed by domain+path, and clicking one navigates client-side", async () => {
    setInitialPath("/");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { PortalFrame } = await import("../../src/frontend/portal-frame");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <PortalFrame
            me={undefined}
            providers={[]}
            navItems={[
              { label: "Orders", path: "/orders", domain: "orders" },
              { label: "Billing", path: "/billing", domain: "billing" },
            ]}
          >
            <div>content</div>
          </PortalFrame>
        );
      });

      expect(container.textContent).toContain("Orders");
      expect(container.textContent).toContain("Billing");

      const ordersLink = container.querySelector('a[href="/orders"]') as HTMLAnchorElement | null;
      expect(ordersLink).not.toBeNull();

      await act(async () => {
        click(ordersLink!);
      });
      expect(window.location.pathname).toBe("/orders");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  test("me: undefined (identity still resolving) shows no auth controls", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { PortalFrame } = await import("../../src/frontend/portal-frame");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <PortalFrame me={undefined} providers={[{ name: "github", label: "GitHub" }]} navItems={[]}>
            <div>content</div>
          </PortalFrame>
        );
      });

      expect(container.textContent).not.toContain("Sign in");
      expect(container.textContent).not.toContain("Logout");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  test("me: null (anonymous) shows one sign-in link per provider", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { PortalFrame } = await import("../../src/frontend/portal-frame");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <PortalFrame
            me={null}
            providers={[
              { name: "github", label: "GitHub" },
              { name: "gitlab", label: "GitLab" },
            ]}
            navItems={[]}
          >
            <div>content</div>
          </PortalFrame>
        );
      });

      const githubLink = container.querySelector('a[href="/auth/login/github"]');
      const gitlabLink = container.querySelector('a[href="/auth/login/gitlab"]');
      expect(githubLink).not.toBeNull();
      expect(gitlabLink).not.toBeNull();
      expect(container.textContent).toContain("GitHub");
      expect(container.textContent).toContain("GitLab");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  test("an authenticated user sees their displayName as a /profile link, and a Logout button", async () => {
    setInitialPath("/");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { PortalFrame } = await import("../../src/frontend/portal-frame");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <PortalFrame
            me={{ id: "u1", roles: [], displayName: "Ada Lovelace", email: "ada@example.com" }}
            providers={[]}
            navItems={[]}
          >
            <div>content</div>
          </PortalFrame>
        );
      });

      expect(container.textContent).toContain("Ada Lovelace");
      const profileLink = container.querySelector('a[href="/profile"]') as HTMLAnchorElement | null;
      expect(profileLink).not.toBeNull();
      const logoutButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Logout");
      expect(logoutButton).toBeDefined();

      await act(async () => {
        click(profileLink!);
      });
      expect(window.location.pathname).toBe("/profile");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  test("falls back to email, then id, when displayName is missing", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { PortalFrame } = await import("../../src/frontend/portal-frame");

    async function renderWith(me: { id: string; roles: string[]; displayName: string | null; email: string | null }) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <PortalFrame me={me} providers={[]} navItems={[]}>
            <div>content</div>
          </PortalFrame>
        );
      });
      return { container, root };
    }

    const { container: c1, root: r1 } = await renderWith({
      id: "u1",
      roles: [],
      displayName: null,
      email: "ada@example.com",
    });
    expect(c1.textContent).toContain("ada@example.com");
    await act(async () => {
      r1.unmount();
    });

    const { container: c2, root: r2 } = await renderWith({ id: "u2", roles: [], displayName: null, email: null });
    expect(c2.textContent).toContain("u2");
    await act(async () => {
      r2.unmount();
    });
  });

  test("clicking Logout clears the session and navigates to /", async () => {
    const { storeTokens, getStoredTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "a.b.c", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    const originalAssign = window.location.assign;
    let assignedTo = "";
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch;
    (window.location as unknown as { assign: (url: string) => void }).assign = (url: string) => {
      assignedTo = url;
    };

    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { PortalFrame } = await import("../../src/frontend/portal-frame");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <PortalFrame me={{ id: "u1", roles: [], displayName: "Ada Lovelace", email: null }} providers={[]} navItems={[]}>
            <div>content</div>
          </PortalFrame>
        );
      });

      const logoutButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Logout")!;
      await act(async () => {
        logoutButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });

      expect(getStoredTokens()).toBeNull();
      expect(assignedTo).toBe("/");
    } finally {
      await act(async () => {
        root.unmount();
      });
      globalThis.fetch = originalFetch;
      window.location.assign = originalAssign;
      sessionStorage.clear();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test __tests__/frontend/portal-frame.test.tsx`
Expected: FAIL with "Cannot find module '../../src/frontend/portal-frame'" (the file doesn't exist yet).

- [ ] **Step 3: Implement `PortalFrame`**

Create `src/frontend/portal-frame.tsx`:

```tsx
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { usePortalNavigate, usePortalLogout } from "@portal/runtime";

export type Me = {
  id: string;
  roles: string[];
  displayName: string | null;
  email: string | null;
} | null;

export type Provider = { name: string; label: string };

export type NavItem = { label: string; path: string; domain: string };

export type PortalFrameProps = {
  me: Me | undefined;
  providers: Provider[];
  navItems: NavItem[];
  children: ReactNode;
};

const styles: Record<string, CSSProperties> = {
  page: { display: "flex", flexDirection: "column", minHeight: "100vh" },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    padding: "0.75rem 1.5rem",
    borderBottom: "1px solid #ddd",
  },
  logo: { display: "flex", alignItems: "center", gap: "0.5rem", textDecoration: "none", color: "inherit" },
  nav: { display: "flex", gap: "1rem", flexWrap: "wrap" },
  authControls: { display: "flex", alignItems: "center", gap: "0.75rem" },
  main: { flex: 1, padding: "1.5rem" },
  footer: { padding: "1rem 1.5rem", borderTop: "1px solid #ddd", fontSize: "0.85rem", color: "#666" },
};

// Preserves normal <a> semantics (open in new tab, copy link, modifier-key
// clicks) for anything but a plain left-click — the pattern specification.md's
// Client shell section already calls for: "a component that wants a real <a>
// to navigate client-side calls usePortalNavigate() from its own click
// handler."
function InternalLink({
  path,
  navigate,
  style,
  children,
}: {
  path: string;
  navigate: (path: string) => void;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <a
      href={path}
      style={style}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(path);
      }}
    >
      {children}
    </a>
  );
}

function PortalLogoPlaceholder() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" role="img" aria-label="Portal logo placeholder">
      <rect width="28" height="28" rx="6" fill="#4338ca" />
      <text x="14" y="19" textAnchor="middle" fontSize="14" fontFamily="sans-serif" fill="#fff">
        P
      </text>
    </svg>
  );
}

function AuthControls({
  me,
  providers,
  navigate,
}: {
  me: Me | undefined;
  providers: Provider[];
  navigate: (path: string) => void;
}) {
  const logout = usePortalLogout();

  if (me === undefined) return null;

  if (me === null) {
    return (
      <div style={styles.authControls}>
        {providers.map((provider) => (
          <a key={provider.name} href={`/auth/login/${provider.name}`}>
            Sign in with {provider.label}
          </a>
        ))}
      </div>
    );
  }

  const label = me.displayName ?? me.email ?? me.id;
  return (
    <div style={styles.authControls}>
      <InternalLink path="/profile" navigate={navigate}>
        {label}
      </InternalLink>
      <button
        type="button"
        onClick={() => {
          void logout();
        }}
      >
        Logout
      </button>
    </div>
  );
}

export function PortalFrame({ me, providers, navItems, children }: PortalFrameProps) {
  const navigate = usePortalNavigate();

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <InternalLink path="/" navigate={navigate} style={styles.logo}>
          <PortalLogoPlaceholder />
          <span>Portal</span>
        </InternalLink>
        <nav style={styles.nav}>
          {navItems.map((item) => (
            <InternalLink key={`${item.domain}:${item.path}`} path={item.path} navigate={navigate}>
              {item.label}
            </InternalLink>
          ))}
        </nav>
        <AuthControls me={me} providers={providers} navigate={navigate} />
      </header>
      <main style={styles.main}>{children}</main>
      <footer style={styles.footer}>Contact: hello@example.com</footer>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test __tests__/frontend/portal-frame.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/portal-frame.tsx __tests__/frontend/portal-frame.test.tsx
git commit -m "feat: add PortalFrame — persistent header/nav/auth/footer chrome"
```

---

### Task 3: Wire `PortalFrame` into the shell

**Files:**
- Modify: `src/frontend/shell-entry.tsx`
- Test: extend `__tests__/frontend/shell-entry.test.tsx`

**Interfaces:**
- Consumes: `Me`, `Provider`, `NavItem`, `PortalFrame` from `./portal-frame` (Task 2).
- Produces: `App`'s rendered output is now always wrapped in `<PortalFrame>`; no change to `App`'s exported signature or its `Status`/boot/resolve-and-mount logic.

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/frontend/shell-entry.test.tsx`, inside `describe("shell App", ...)` (anywhere after the existing tests, before the closing `});` at the end of that block):

```tsx
  test("the persistent frame shows nav items and profile/logout controls once authenticated, even on a not-found route", async () => {
    setInitialPath("/");
    const restore = mockFetchSequence([
      { path: "/me", status: 200, body: { id: "u1", roles: [], displayName: "Ada Lovelace", email: "ada@example.com" } },
      { path: "/routes", status: 200, body: { routes: [], contextOwners: {} } },
      { path: "/nav", status: 200, body: { nav: [{ label: "Orders", path: "/orders", domain: "orders" }] } },
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

      expect(container.querySelector("header")).not.toBeNull();
      expect(container.querySelector("footer")).not.toBeNull();
      expect(container.textContent).toContain("Orders");
      expect(container.textContent).toContain("Ada Lovelace");
      expect(container.textContent).toContain("Logout");
      expect(container.textContent).toContain("Not found"); // main content is still the existing not-found state
    } finally {
      await act(async () => {
        root.unmount();
      });
      restore();
    }
  });

  test("the persistent frame's own sign-in links render alongside the login screen's, when anonymous", async () => {
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

      expect(container.querySelector("header")).not.toBeNull();
      expect(container.querySelector("footer")).not.toBeNull();
      // One link from the frame's persistent header, one from the login
      // screen's own content — both render "Sign in with GitHub" for an
      // anonymous session (see Task 3 of the portal-frame plan).
      expect(container.querySelectorAll('a[href="/auth/login/github"]').length).toBe(2);
    } finally {
      await act(async () => {
        root.unmount();
      });
      restore();
    }
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `bun test __tests__/frontend/shell-entry.test.tsx`
Expected: FAIL — `App` doesn't render a `<header>`/`<footer>` yet, and doesn't fetch `/nav`.

- [ ] **Step 3: Wire `PortalFrame` into `App`**

In `src/frontend/shell-entry.tsx`:

1. Replace the import block at the top:

```tsx
import { Component, useEffect, useState, type ReactNode } from "react";
import { PortalRuntimeProvider, portalFetch, useCurrentPath } from "@portal/runtime";
import { storeTokens } from "../runtime/auth";
import { resolveRoute, type RouteTableEntry } from "./router";
```

with:

```tsx
import { Component, useEffect, useState, type ReactNode } from "react";
import { PortalRuntimeProvider, portalFetch, useCurrentPath } from "@portal/runtime";
import { storeTokens } from "../runtime/auth";
import { resolveRoute, type RouteTableEntry } from "./router";
import { PortalFrame, type Me, type Provider, type NavItem } from "./portal-frame";
```

2. Remove the now-redundant local type declarations (`PortalFrame`'s file is now the source of truth for these):

```tsx
type Me = { id: string; roles: string[] } | null;
type RoutesResponse = { routes: RouteTableEntry[]; contextOwners: Record<string, string> };
type Provider = { name: string; label: string };
type Status = "loading" | "login" | "forbidden" | "not_found" | "error" | "ready";
```

becomes:

```tsx
type RoutesResponse = { routes: RouteTableEntry[]; contextOwners: Record<string, string> };
type Status = "loading" | "login" | "forbidden" | "not_found" | "error" | "ready";
```

(`Me` and `Provider` are now imported from `./portal-frame` instead of declared locally.)

3. Add a `navItems` state declaration. Replace:

```tsx
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [routesData, setRoutesData] = useState<RoutesResponse | null>(null);
  const [mounted, setMounted] = useState<{ Component: React.ComponentType; scsName: string } | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loginError, setLoginError] = useState<string | null>(null);
```

with:

```tsx
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [routesData, setRoutesData] = useState<RoutesResponse | null>(null);
  const [mounted, setMounted] = useState<{ Component: React.ComponentType; scsName: string } | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [navItems, setNavItems] = useState<NavItem[]>([]);
```

4. Add a new, independent, non-fatal effect that fetches `/nav`. Replace:

```tsx
      } catch (err) {
        console.error("shell boot failed", err);
        setStatus("error");
      }
    })();
  }, []);

  // Resolve + mount whenever the path (via usePortalNavigate/popstate) or the
  // loaded route table changes.
  useEffect(() => {
```

with:

```tsx
      } catch (err) {
        console.error("shell boot failed", err);
        setStatus("error");
      }
    })();
  }, []);

  // Independent of the /me boot sequence above and never fatal: /nav is
  // display-only (see specification.md, Context model), and now allows
  // anonymous callers, so this can run regardless of auth state. A failure
  // here must never affect `status` — it just leaves the nav space empty.
  useEffect(() => {
    (async () => {
      try {
        const navResponse = await portalFetch("/nav");
        if (!navResponse.ok) return;
        const navJson = (await navResponse.json()) as { nav: NavItem[] };
        setNavItems(navJson.nav);
      } catch (err) {
        console.error("nav fetch failed", err);
      }
    })();
  }, []);

  // Resolve + mount whenever the path (via usePortalNavigate/popstate) or the
  // loaded route table changes.
  useEffect(() => {
```

This keeps the pre-existing "Resolve + mount" effect's own content completely untouched — only its immediately preceding code changes.

5. Replace the final render block:

```tsx
  if (status === "loading") return <div>Loading…</div>;
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
  if (status === "forbidden") return <div>You don't have access to this page.</div>;
  if (status === "not_found") return <div>Not found.</div>;
  if (status === "error") return <div>Something went wrong loading this page.</div>;

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

with:

```tsx
  function renderContent(): ReactNode {
    if (status === "loading") return <div>Loading…</div>;
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
    if (status === "forbidden") return <div>You don't have access to this page.</div>;
    if (status === "not_found") return <div>Not found.</div>;
    if (status === "error") return <div>Something went wrong loading this page.</div>;

    const { Component: Mounted, scsName } = mounted!;
    return (
      <MountErrorBoundary>
        <PortalRuntimeProvider scsName={scsName} contextOwners={routesData!.contextOwners}>
          <Mounted />
        </PortalRuntimeProvider>
      </MountErrorBoundary>
    );
  }

  return (
    <PortalFrame me={me} providers={providers} navItems={navItems}>
      {renderContent()}
    </PortalFrame>
  );
}
```

- [ ] **Step 4: Run the full frontend test suite to verify everything passes**

Run: `bun test __tests__/frontend/`
Expected: PASS — all pre-existing tests in `shell-entry.test.tsx` (unaffected, since the frame is purely additive and `/nav` failures are non-fatal) plus the two new ones from Step 1.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/shell-entry.tsx __tests__/frontend/shell-entry.test.tsx
git commit -m "feat: wrap the shell in the persistent PortalFrame"
```
