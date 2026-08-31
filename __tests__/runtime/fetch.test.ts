import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test";
import { portalFetch } from "../../src/runtime/fetch";
import { withDom } from "../helpers/dom";

withDom();

// happy-dom defaults to "about:blank" (origin "null"), against which
// portalFetch's same-origin check for Authorization (see the cross-origin
// fix in src/runtime/fetch.ts) can't resolve even a relative path. Give
// every test in this file a fixed same-origin baseline, matching the
// `window.happyDOM.setURL` precedent already established in
// __tests__/frontend/shell-entry.test.tsx and __tests__/runtime/navigate.test.tsx.
beforeEach(() => {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://portal.example/");
});

afterEach(() => {
  sessionStorage.clear();
});

describe("portalFetch", () => {
  test("attaches the X-Portal-Data marker header", async () => {
    const originalFetch = globalThis.fetch;
    const calls: [string, RequestInit | undefined][] = [];
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
      calls.push([String(input), init]);
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch;

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
    }) as unknown as typeof fetch;

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

describe("portalFetch — Authorization + refresh", () => {
  test("attaches Authorization when a token is stored", async () => {
    const { storeTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "access-1", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    globalThis.fetch = mock((_input: any, init?: RequestInit) => {
      calls.push(init!);
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      await portalFetch("/orders");
      const headers = new Headers(calls[0].headers);
      expect(headers.get("Authorization")).toBe("Bearer access-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("attaches no Authorization header when no token is stored", async () => {
    const originalFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    globalThis.fetch = mock((_input: any, init?: RequestInit) => {
      calls.push(init!);
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      await portalFetch("/orders");
      const headers = new Headers(calls[0].headers);
      expect(headers.has("Authorization")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("on a 401, refreshes once and retries the original request with the new token", async () => {
    const { storeTokens, getStoredTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "expired", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    const requests: { url: string; auth: string | null }[] = [];
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, auth: headers.get("Authorization") });
      if (url === "/auth/refresh") {
        return Promise.resolve(
          new Response(JSON.stringify({ accessToken: "fresh", refreshToken: "refresh-2" }), { status: 200 })
        );
      }
      if (headers.get("Authorization") === "Bearer expired") {
        return Promise.resolve(new Response("unauthorized", { status: 401 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      const response = await portalFetch("/orders");
      expect(response.status).toBe(200);
      expect(getStoredTokens()).toEqual({ accessToken: "fresh", refreshToken: "refresh-2" });
      // exactly 3 calls: the failing /orders attempt, the refresh, the retry
      expect(requests).toHaveLength(3);
      expect(requests[2].auth).toBe("Bearer fresh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not retry a non-GET request on 401, even with a valid refresh token stored", async () => {
    const { storeTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "expired", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = mock((input: any) => {
      calls.push(String(input));
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      const response = await portalFetch("/orders/create", { method: "POST", body: JSON.stringify({}) });
      expect(response.status).toBe(401);
      expect(calls).toEqual(["/orders/create"]); // no /auth/refresh call, no retry
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("if refresh itself fails, the original 401 is returned and stored tokens are cleared", async () => {
    const { storeTokens, getStoredTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "expired", refreshToken: "revoked" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((input: any) => {
      if (String(input) === "/auth/refresh") return Promise.resolve(new Response("unauthorized", { status: 401 }));
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      const response = await portalFetch("/orders");
      expect(response.status).toBe(401);
      expect(getStoredTokens()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a 401 with no stored token at all does not attempt a refresh", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = mock((input: any) => {
      calls.push(String(input));
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      const response = await portalFetch("/routes");
      expect(response.status).toBe(401);
      expect(calls).toEqual(["/routes"]); // no /auth/refresh call
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not attach Authorization when the target URL is cross-origin, even with a token stored", async () => {
    const { storeTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "access-1", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    globalThis.fetch = mock((_input: any, init?: RequestInit) => {
      calls.push(init!);
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      // window.location is https://portal.example/ (see beforeEach above);
      // this target is a different origin entirely.
      await portalFetch("https://third-party.example/api/data");
      const headers = new Headers(calls[0].headers);
      expect(headers.has("Authorization")).toBe(false);
      // The marker header is unrelated to the auth leak and still applies.
      expect(headers.get("X-Portal-Data")).toBe("1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("still attaches Authorization for a same-origin absolute URL", async () => {
    const { storeTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "access-1", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    globalThis.fetch = mock((_input: any, init?: RequestInit) => {
      calls.push(init!);
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      await portalFetch("https://portal.example/orders");
      const headers = new Headers(calls[0].headers);
      expect(headers.get("Authorization")).toBe("Bearer access-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("two concurrent 401s share one in-flight refresh instead of each calling /auth/refresh", async () => {
    const { storeTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "expired", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    let refreshCallCount = 0;
    let resolveRefresh: (() => void) | null = null;
    const refreshGate = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url === "/auth/refresh") {
        refreshCallCount += 1;
        await refreshGate; // hold every refresh call open until the test releases it
        return new Response(JSON.stringify({ accessToken: "fresh", refreshToken: "refresh-2" }), { status: 200 });
      }
      const headers = new Headers(init?.headers);
      if (headers.get("Authorization") === "Bearer expired") return new Response("unauthorized", { status: 401 });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      const first = portalFetch("/orders");
      const second = portalFetch("/billing");
      // give both calls a chance to hit their initial 401 and start refreshing
      await new Promise((resolve) => setTimeout(resolve, 0));
      resolveRefresh!();
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(refreshCallCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a refresh whose write lands normally (no logout mid-flight) still stores the new tokens", async () => {
    const { storeTokens, getStoredTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "expired", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    let resolveRefresh: (() => void) | null = null;
    const refreshGate = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url === "/auth/refresh") {
        await refreshGate; // hold the refresh open so the test controls exactly when it resolves
        return new Response(JSON.stringify({ accessToken: "fresh", refreshToken: "refresh-2" }), { status: 200 });
      }
      const headers = new Headers(init?.headers);
      if (headers.get("Authorization") === "Bearer expired") return new Response("unauthorized", { status: 401 });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      const pending = portalFetch("/orders");
      // give the call a chance to hit its initial 401 and start refreshing
      await new Promise((resolve) => setTimeout(resolve, 0));
      resolveRefresh!(); // no logout happened while this was in flight
      const response = await pending;
      expect(response.status).toBe(200);
      expect(getStoredTokens()).toEqual({ accessToken: "fresh", refreshToken: "refresh-2" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a refresh that resolves AFTER clearTokens() ran mid-flight (a logout) does not resurrect the session", async () => {
    const { storeTokens, getStoredTokens, clearTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "expired", refreshToken: "refresh-1" });

    const originalFetch = globalThis.fetch;
    let resolveRefresh: (() => void) | null = null;
    const refreshGate = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url === "/auth/refresh") {
        await refreshGate; // hold the refresh open so the test controls exactly when it resolves
        return new Response(JSON.stringify({ accessToken: "fresh", refreshToken: "refresh-2" }), { status: 200 });
      }
      const headers = new Headers(init?.headers);
      if (headers.get("Authorization") === "Bearer expired") return new Response("unauthorized", { status: 401 });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const { portalFetch } = await import("../../src/runtime/fetch");
      const pending = portalFetch("/orders");
      // give the call a chance to hit its initial 401 and start refreshing
      await new Promise((resolve) => setTimeout(resolve, 0));
      clearTokens(); // simulates usePortalLogout() running while the refresh is in flight
      resolveRefresh!();
      const response = await pending;
      // the caller just sees the original 401 — the right outcome for a user who just logged out
      expect(response.status).toBe(401);
      expect(getStoredTokens()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
