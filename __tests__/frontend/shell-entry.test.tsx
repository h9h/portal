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
  test("shows a login prompt when /me is 401", async () => {
    const restore = mockFetchSequence([{ path: "/me", status: 401, body: { error: "unauthorized" } }]);
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

      expect(container.textContent).toContain("Please log in");
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
});
