import { describe, test, expect, mock, afterEach } from "bun:test";
import React from "react";
import { withDom } from "../helpers/dom";

withDom();

afterEach(() => {
  sessionStorage.clear();
});

describe("usePortalLogout", () => {
  test("clears stored tokens, calls POST /auth/logout with the refresh token, and navigates to /", async () => {
    const { storeTokens, getStoredTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "a.b.c", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    const originalAssign = window.location.assign;
    const calls: { url: string; body: unknown }[] = [];
    let assignedTo = "";
    globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(init.body as string) : null });
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;
    (window.location as unknown as { assign: (url: string) => void }).assign = (url: string) => {
      assignedTo = url;
    };

    try {
      const { createRoot } = await import("react-dom/client");
      const { act } = await import("react");
      const { usePortalLogout } = await import("../../src/runtime/logout");

      let logout: (() => Promise<void>) | null = null;
      function Probe() {
        logout = usePortalLogout();
        return null;
      }
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Probe />);
      });

      await act(async () => {
        await logout!();
      });

      expect(getStoredTokens()).toBeNull();
      expect(calls).toEqual([{ url: "/auth/logout", body: { refreshToken: "refresh-1" } }]);
      expect(assignedTo).toBe("/");
    } finally {
      globalThis.fetch = originalFetch;
      window.location.assign = originalAssign;
    }
  });

  test("clears local state and navigates even if the server call fails", async () => {
    const { storeTokens, getStoredTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "a.b.c", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    const originalAssign = window.location.assign;
    let assignedTo = "";
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    (window.location as unknown as { assign: (url: string) => void }).assign = (url: string) => {
      assignedTo = url;
    };

    try {
      const { createRoot } = await import("react-dom/client");
      const { act } = await import("react");
      const { usePortalLogout } = await import("../../src/runtime/logout");

      let logout: (() => Promise<void>) | null = null;
      function Probe() {
        logout = usePortalLogout();
        return null;
      }
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Probe />);
      });

      await act(async () => {
        await logout!();
      });

      expect(getStoredTokens()).toBeNull();
      expect(assignedTo).toBe("/");
    } finally {
      globalThis.fetch = originalFetch;
      window.location.assign = originalAssign;
    }
  });

  test("logging out with no stored session skips the server call but still navigates", async () => {
    const originalFetch = globalThis.fetch;
    const originalAssign = window.location.assign;
    const calls: string[] = [];
    let assignedTo = "";
    globalThis.fetch = mock(async (input: any) => {
      calls.push(String(input));
      return new Response("ok");
    }) as unknown as typeof fetch;
    (window.location as unknown as { assign: (url: string) => void }).assign = (url: string) => {
      assignedTo = url;
    };

    try {
      const { createRoot } = await import("react-dom/client");
      const { act } = await import("react");
      const { usePortalLogout } = await import("../../src/runtime/logout");

      let logout: (() => Promise<void>) | null = null;
      function Probe() {
        logout = usePortalLogout();
        return null;
      }
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Probe />);
      });

      await act(async () => {
        await logout!();
      });

      expect(calls).toEqual([]);
      expect(assignedTo).toBe("/");
    } finally {
      globalThis.fetch = originalFetch;
      window.location.assign = originalAssign;
    }
  });
});
