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

  test("the header's border and padding reference the shared theme's tokens, each with the same literal fallback it had before", async () => {
    // Not a DOM-rendering test — see the note above Step 1 in this task's
    // brief for why: happy-dom's CSSStyleDeclaration silently drops any
    // style value containing var(...), so this checks the component's own
    // source text instead.
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../../src/frontend/portal-frame.tsx", import.meta.url), "utf8");
    expect(source).toContain("var(--portal-color-border, #ddd)");
    expect(source).toContain("var(--portal-space-3, 0.75rem)");
    expect(source).toContain("var(--portal-space-6, 1.5rem)");
    expect(source).toContain("var(--portal-color-primary, #4338ca)");
  });

  test("all theme tokens referenced in portal-frame.tsx are declared in theme.css", async () => {
    const fs = await import("node:fs/promises");
    const frameSource = await fs.readFile(new URL("../../src/frontend/portal-frame.tsx", import.meta.url), "utf8");
    const themeSource = await fs.readFile(new URL("../../src/shell/theme.css", import.meta.url), "utf8");

    // Extract all distinct --portal-* token names from var(...) calls.
    const tokenMatches = frameSource.match(/var\(--portal-[a-z0-9-]+/g) || [];
    const tokenNames = [...new Set(tokenMatches.map((match) => match.replace("var(", "")))];

    // Assert each token is declared in theme.css.
    for (const token of tokenNames) {
      expect(themeSource).toContain(`${token}:`);
    }
  });

  test("a modifier-key click on an internal link does not trigger client-side navigation", async () => {
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

      const logoLink = container.querySelector('a[href="/"]') as HTMLAnchorElement;
      // Note: happy-dom, unlike a real browser, *does* perform the anchor's
      // own default navigation on an unprevented click regardless of
      // modifier keys — so window.location.pathname changing on its own
      // isn't proof of anything here (it would change either way: via our
      // click handler's own history.pushState if the guard were broken, or
      // via happy-dom's default navigation if the guard correctly bails
      // out). What actually distinguishes the two is whether the handler
      // called preventDefault(): it does so only on the branch that calls
      // navigate() — a modifier-key click must take the early-return branch
      // and leave the event unprevented, letting normal <a> semantics run.
      let event!: MouseEvent;
      await act(async () => {
        event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
        logoLink.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
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
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as unknown as typeof fetch;
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
