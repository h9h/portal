import { describe, test, expect, mock } from "bun:test";
import { withDom } from "../helpers/dom";

withDom();

// happy-dom defaults to "about:blank"; pushState against it can't resolve a
// relative path (window.location.pathname comes back as "blank"). Set a real
// https: origin via happy-dom's own `window.happyDOM.setURL` first (as
// __tests__/runtime/navigate.test.tsx already does), then reach the path via
// a normal pushState.
function setInitialPath(path: string): void {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://localhost:3000/");
  history.pushState(null, "", path);
}

function mockFetchSequence(responses: { path: string; status: number; body: unknown }[]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (input: any) => {
    const url = new URL(String(input), "http://localhost");
    const match = responses.find((r) => url.pathname === r.path);
    if (!match) return new Response("not mocked", { status: 500 });
    return new Response(JSON.stringify(match.body), { status: match.status });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// The App component's boot effect chains several awaits (fetch /me -> read
// its JSON body -> fetch /routes -> read its JSON body), each a separate
// microtask hop. A bare `await act(async () => {})` only flushes whatever
// work is already scheduled by the time its own (empty) callback settles,
// which isn't reliably enough turns of the event loop to drain that whole
// chain — leaving a dangling state update that fires later, outside of any
// `act()`, and (worse) outside of this test file's own happy-dom instance
// once a later test file's DOM has replaced it. `setTimeout(resolve, 0)`
// forces a real macrotask boundary, giving every pending microtask a chance
// to run before `act` checks for scheduled work.
async function flush(act: (callback: () => Promise<void>) => Promise<void>, times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("shell App", () => {
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
      const link = container.querySelector('main a[href="/auth/login/github"]') as HTMLAnchorElement | null;
      expect(link?.getAttribute("href")).toBe("/auth/login/github");
    } finally {
      await act(async () => {
        root.unmount();
      });
      restore();
    }
  });

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
      expect(container.querySelector("main")?.textContent).toContain("GitHub");
      expect(window.location.hash).toBe("");
    } finally {
      await act(async () => {
        root.unmount();
      });
      restore();
    }
  });

  test("shows a forbidden state when the resolved route requires a role the user lacks", async () => {
    setInitialPath("/orders");
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

      expect(container.textContent).toContain("don't have access");
    } finally {
      await act(async () => {
        root.unmount();
      });
      restore();
    }
  });

  test("mounts the resolved component via the injected loader, wrapped in PortalRuntimeProvider", async () => {
    setInitialPath("/orders");
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
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
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
    try {
      await act(async () => {
        root.render(<App loadComponent={loadComponent} />);
      });
      await flush(act);

      expect(loadComponent).toHaveBeenCalledWith("/_scs/orders/bundle.js");
      expect(container.textContent).toContain("orders view");
    } finally {
      await act(async () => {
        root.unmount();
      });
      restore();
    }
  });

  // Fix-round regression test (whole-branch review): a rejected promise
  // inside a useEffect can't be caught by MountErrorBoundary (it only
  // catches render/lifecycle errors), so an unhandled rejection here used
  // to leave `status` stuck at "loading" forever.
  test("shows an error state when the boot fetch itself rejects (network failure)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
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

      expect(container.textContent).toContain("Something went wrong");
    } finally {
      await act(async () => {
        root.unmount();
      });
      globalThis.fetch = originalFetch;
    }
  });

  // Fix-round regression test (whole-branch review): same gap as above, but
  // in the resolve+mount effect — a malformed/404 SCS bundle rejecting
  // `loadComponent` used to leave `status` stuck at "loading" forever too.
  test("shows an error state when the injected loader rejects (malformed or missing SCS bundle)", async () => {
    setInitialPath("/orders");
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
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { App } = await import("../../src/frontend/shell-entry");

    const loadComponent = mock(async (_url: string) => {
      throw new Error("bundle fetch failed");
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<App loadComponent={loadComponent} />);
      });
      await flush(act);

      expect(container.textContent).toContain("Something went wrong");
    } finally {
      await act(async () => {
        root.unmount();
      });
      restore();
    }
  });

  // Fix-round regression test (whole-branch review): the resolve+mount
  // effect used to never reset `status`/`mounted` when `path` changed, so
  // React kept rendering the *previous* route's component (with the
  // previous scsName in PortalRuntimeProvider) while the new route's bundle
  // was still loading.
  test("navigating to a new route clears the previous view immediately instead of leaving a stale render", async () => {
    setInitialPath("/orders");
    const restore = mockFetchSequence([
      { path: "/me", status: 200, body: { id: "u1", roles: ["orders:viewer", "billing:viewer"] } },
      {
        path: "/routes",
        status: 200,
        body: {
          routes: [
            { path: "/orders", scsName: "orders", requiredRoles: ["orders:viewer"], component: "OrdersView" },
            { path: "/billing", scsName: "billing", requiredRoles: ["billing:viewer"], component: "BillingView" },
          ],
          contextOwners: {},
        },
      },
    ]);
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { App } = await import("../../src/frontend/shell-entry");

    function OrdersView() {
      return <div>orders view</div>;
    }
    function BillingView() {
      return <div>billing view</div>;
    }
    // Orders resolves immediately; billing stays pending until the test
    // resolves it explicitly, so the "still loading" moment is observable.
    let resolveBilling: (mod: Record<string, unknown>) => void = () => {};
    const loadComponent = mock(
      (url: string) =>
        url === "/_scs/orders/bundle.js"
          ? Promise.resolve({ OrdersView })
          : new Promise<Record<string, unknown>>((resolve) => {
              resolveBilling = resolve;
            })
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<App loadComponent={loadComponent} />);
      });
      await flush(act);
      expect(container.textContent).toContain("orders view");

      await act(async () => {
        history.pushState(null, "", "/billing");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      expect(container.textContent).not.toContain("orders view");
      expect(container.textContent).toContain("Loading");

      await act(async () => {
        resolveBilling({ BillingView });
      });
      await flush(act);

      expect(container.textContent).toContain("billing view");
    } finally {
      await act(async () => {
        root.unmount();
      });
      restore();
    }
  });

  test("shows a not-found state when the resolved module lacks the named export", async () => {
    setInitialPath("/orders");
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
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { App } = await import("../../src/frontend/shell-entry");

    const loadComponent = mock(async (_url: string) => ({})); // no OrdersView export

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<App loadComponent={loadComponent} />);
      });
      await flush(act);

      expect(container.textContent).toContain("Not found");
    } finally {
      await act(async () => {
        root.unmount();
      });
      restore();
    }
  });

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

  // Fix-round regression test (whole-branch review): the /nav effect used to
  // have a `[]` dependency array, firing in parallel with /me at boot instead
  // of after it — so a stale-but-present access token left navItems stuck
  // showing only public entries even once /me's own portalFetch had
  // transparently refreshed the token and resolved to an authenticated
  // session. Deliberately holds the /me fetch open to prove /nav is never
  // called while `me` is still undefined, then lets /me resolve and confirms
  // /nav is called only after.
  test("the /nav effect waits for identity to resolve before firing", async () => {
    setInitialPath("/");
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    let resolveMe: (() => void) | null = null;
    globalThis.fetch = mock(async (input: any) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(url.pathname);
      if (url.pathname === "/me") {
        await new Promise<void>((resolve) => {
          resolveMe = resolve;
        });
        return new Response(
          JSON.stringify({ id: "u1", roles: [], displayName: "Ada Lovelace", email: null }),
          { status: 200 }
        );
      }
      if (url.pathname === "/routes") {
        return new Response(JSON.stringify({ routes: [], contextOwners: {} }), { status: 200 });
      }
      if (url.pathname === "/nav") {
        return new Response(JSON.stringify({ nav: [] }), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

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

      // /me is deliberately still in-flight here (held open by resolveMe not
      // having been called yet) — /nav must not have been fetched yet.
      expect(calls).not.toContain("/nav");

      await act(async () => {
        resolveMe!();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await flush(act);

      expect(calls).toContain("/nav");
    } finally {
      await act(async () => {
        root.unmount();
      });
      globalThis.fetch = originalFetch;
    }
  });
});

describe("defaultLoader", () => {
  // Every test above injects its own `loadComponent` mock, so none of them
  // ever exercises the real default. This is the one code path in this file
  // with no coverage of its own — it needs a real fetch mock and a real
  // dynamic import() of a real blob: URL under happy-dom.
  test("fetches the bundle via portalFetch (carrying the X-Portal-Data marker header) and mounts it from a blob: URL, yielding a module with usable named exports", async () => {
    const originalFetch = globalThis.fetch;
    const calls: { url: string; headers: Headers }[] = [];
    globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("export const Probe = () => null;", {
        status: 200,
        headers: { "Content-Type": "application/javascript" },
      });
    }) as unknown as typeof fetch;

    try {
      const { defaultLoader } = await import("../../src/frontend/shell-entry");
      const module = await defaultLoader("/_scs/orders/bundle.js");

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("/_scs/orders/bundle.js");
      expect(calls[0].headers.get("X-Portal-Data")).toBe("1");

      expect(typeof module.Probe).toBe("function");
      expect((module.Probe as () => null)()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws a clear error (not a cryptic parse failure) when the underlying fetch is non-ok, and the App component's existing catch turns that into the error state", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    try {
      const { defaultLoader } = await import("../../src/frontend/shell-entry");
      await expect(defaultLoader("/_scs/orders/bundle.js")).rejects.toThrow(
        "failed to load SCS bundle /_scs/orders/bundle.js: 401"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("composes with App: a non-ok bundle fetch surfaces as the App component's error state", async () => {
    setInitialPath("/orders");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: any) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/me") return new Response(JSON.stringify({ id: "u1", roles: ["orders:viewer"] }), { status: 200 });
      if (url.pathname === "/routes") {
        return new Response(
          JSON.stringify({
            routes: [{ path: "/orders", scsName: "orders", requiredRoles: ["orders:viewer"], component: "OrdersView" }],
            contextOwners: {},
          }),
          { status: 200 }
        );
      }
      if (url.pathname === "/_scs/orders/bundle.js") return new Response("bad gateway", { status: 502 });
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { App, defaultLoader } = await import("../../src/frontend/shell-entry");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<App loadComponent={defaultLoader} />);
      });
      await flush(act);

      expect(container.textContent).toContain("Something went wrong");
    } finally {
      await act(async () => {
        root.unmount();
      });
      globalThis.fetch = originalFetch;
    }
  });
});
