import { describe, test, expect, mock } from "bun:test";
import { portalFetch } from "../../src/runtime/fetch";

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
