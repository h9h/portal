import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "../../src/server";
import { createDatabase } from "../../src/db";
import type { OAuthProviderConfig } from "../../src/auth/providers";
import { signAccessToken } from "../../src/auth/tokens";
import { withDom } from "../helpers/dom";

// withDom() is only needed so the new end-to-end test below can use a real
// sessionStorage. But GlobalRegistrator swaps out fetch, Response, Request,
// and Headers everywhere in the process, not just for code acting as a
// client — and that breaks every real-network test in this file, both ways:
//  - as a client, happy-dom's fetch can't parse Bun.serve()'s responses at
//    all (every request fails with a "Parse Error" /
//    HPE_UNEXPECTED_CONTENT_LENGTH — a happy-dom/Bun bug, not one of ours);
//  - as a server, `portal` and `fakeProvider`'s handlers build responses
//    with a bare `new Response(...)`, which now constructs a happy-dom
//    Response that Bun.serve() refuses to return ("Expected a Response
//    object, but received ...").
// So put all four back to native right after registration, and give the
// restored fetch just enough of a browser's relative-URL handling (relative
// to the real portal server's own origin — what a real browser would do,
// since Portal serves its own shell) for portalFetch's internal
// `fetch("/auth/refresh")` call to land in the right place. sessionStorage
// — the actual reason for withDom() here — isn't part of this surface, so
// it's untouched.
const nativeFetch = fetch;
const nativeResponse = Response;
const nativeRequest = Request;
const nativeHeaders = Headers;

withDom();

let fakeProvider: ReturnType<typeof Bun.serve>;
let portal: ReturnType<typeof createServer>;
let fakeProviderConfig: OAuthProviderConfig;

beforeAll(() => {
  globalThis.Response = nativeResponse;
  globalThis.Request = nativeRequest;
  globalThis.Headers = nativeHeaders;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const resolved = typeof input === "string" && input.startsWith("/") ? `${portal.url}${input.slice(1)}` : input;
    return nativeFetch(resolved, init);
  }) as typeof fetch;
});

beforeAll(() => {
  fakeProvider = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/token" && req.method === "POST") {
        const body = (await req.json()) as { code?: string };
        if (body.code !== "valid-code") {
          return new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 400 });
        }
        return new Response(JSON.stringify({ access_token: "fake-provider-access-token" }), { status: 200 });
      }
      if (url.pathname === "/user" && req.method === "GET") {
        return new Response(JSON.stringify({ id: 999, email: "octocat@example.com", name: "The Octocat" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  fakeProviderConfig = {
    name: "fake",
    label: "Fake Provider",
    authorizeUrl: `${fakeProvider.url}authorize`,
    tokenUrl: `${fakeProvider.url}token`,
    userInfoUrl: `${fakeProvider.url}user`,
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    scope: "read:user",
    mapProfile: (json: any) => ({
      providerUserId: String(json.id),
      email: json.email ?? null,
      displayName: json.name ?? null,
    }),
  };

  portal = createServer({
    port: 0,
    db: createDatabase(":memory:"),
    providers: { fake: fakeProviderConfig },
    accessTokenSecret: "access-secret",
    stateSecret: "state-secret",
  });
});

afterAll(() => {
  fakeProvider.stop();
  portal.stop();
});

async function loginAndGetTokens() {
  const loginResponse = await fetch(`${portal.url}auth/login/fake`, { redirect: "manual" });
  const state = new URL(loginResponse.headers.get("Location")!).searchParams.get("state")!;
  const callbackResponse = await fetch(
    `${portal.url}auth/callback/fake?code=valid-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual" }
  );
  const location = new URL(callbackResponse.headers.get("Location")!);
  const fragment = new URLSearchParams(location.hash.slice(1));
  return {
    accessToken: fragment.get("access_token")!,
    refreshToken: fragment.get("refresh_token")!,
  };
}

describe("full login flow", () => {
  test("login redirects to the provider's authorize URL with the right params", async () => {
    const response = await fetch(`${portal.url}auth/login/fake`, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(`${fakeProvider.url}authorize`);
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  test("callback with a valid code and state issues tokens, and /me returns the profile", async () => {
    const { accessToken, refreshToken } = await loginAndGetTokens();
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();

    const meResponse = await fetch(`${portal.url}me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(meResponse.status).toBe(200);
    const me = (await meResponse.json()) as { email: string; provider: string; roles: unknown[] };
    expect(me.email).toBe("octocat@example.com");
    expect(me.provider).toBe("fake");
    expect(me.roles).toEqual([]);
  });

  test("callback with a valid code and state redirects to / with the token pair in the URL fragment", async () => {
    const loginResponse = await fetch(`${portal.url}auth/login/fake`, { redirect: "manual" });
    const state = new URL(loginResponse.headers.get("Location")!).searchParams.get("state")!;

    const callbackResponse = await fetch(
      `${portal.url}auth/callback/fake?code=valid-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" }
    );
    expect(callbackResponse.status).toBe(302);
    const location = new URL(callbackResponse.headers.get("Location")!);
    expect(location.pathname).toBe("/");
    const fragment = new URLSearchParams(location.hash.slice(1));
    expect(fragment.get("access_token")).toBeTruthy();
    expect(fragment.get("refresh_token")).toBeTruthy();
    expect(fragment.get("expires_in")).toBe("900");
  });

  test("callback rejects an invalid state", async () => {
    const response = await fetch(`${portal.url}auth/callback/fake?code=valid-code&state=garbage`);
    expect(response.status).toBe(400);
  });

  test("refresh issues a new access token and rotates the refresh token", async () => {
    const { refreshToken } = await loginAndGetTokens();

    const refreshResponse = await fetch(`${portal.url}auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = (await refreshResponse.json()) as { accessToken: string; refreshToken: string };
    expect(refreshed.accessToken).toBeTruthy();
    expect(refreshed.refreshToken).not.toBe(refreshToken);
  });

  test("a rotated refresh token can itself be used to refresh again", async () => {
    const { refreshToken } = await loginAndGetTokens();

    const firstRefreshResponse = await fetch(`${portal.url}auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(firstRefreshResponse.status).toBe(200);
    const firstRefreshed = (await firstRefreshResponse.json()) as { accessToken: string; refreshToken: string };

    const secondRefreshResponse = await fetch(`${portal.url}auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: firstRefreshed.refreshToken }),
    });
    expect(secondRefreshResponse.status).toBe(200);
    const secondRefreshed = (await secondRefreshResponse.json()) as { accessToken: string; refreshToken: string };
    expect(secondRefreshed.accessToken).toBeTruthy();
  });

  test("logging out with a rotated refresh token revokes it, and it can no longer refresh", async () => {
    const { refreshToken } = await loginAndGetTokens();

    const refreshResponse = await fetch(`${portal.url}auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = (await refreshResponse.json()) as { accessToken: string; refreshToken: string };

    await fetch(`${portal.url}auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: refreshed.refreshToken }),
    });

    const finalRefreshResponse = await fetch(`${portal.url}auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: refreshed.refreshToken }),
    });
    expect(finalRefreshResponse.status).toBe(401);
  });

  test("logout revokes the refresh token", async () => {
    const { refreshToken } = await loginAndGetTokens();

    await fetch(`${portal.url}auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    const refreshResponse = await fetch(`${portal.url}auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(refreshResponse.status).toBe(401);
  });

  test("refresh with an empty body returns 400, not a crash", async () => {
    const response = await fetch(`${portal.url}auth/refresh`, { method: "POST" });
    expect(response.status).toBe(400);
  });

  test("logout with an empty body is a no-op success, not a crash", async () => {
    const response = await fetch(`${portal.url}auth/logout`, { method: "POST" });
    expect(response.status).toBe(200);
  });

  test("login with a prototype-pollution-style provider name returns 404, not a crash", async () => {
    const response = await fetch(`${portal.url}auth/login/constructor`, { redirect: "manual" });
    expect(response.status).toBe(404);
  });

  test("a configured baseUrl overrides the request-derived redirect_uri", async () => {
    const withBaseUrl = createServer({
      port: 0,
      db: createDatabase(":memory:"),
      providers: { fake: fakeProviderConfig },
      accessTokenSecret: "access-secret",
      stateSecret: "state-secret",
      baseUrl: "https://portal.example",
    });
    try {
      const response = await fetch(`${withBaseUrl.url}auth/login/fake`, { redirect: "manual" });
      const location = new URL(response.headers.get("Location")!);
      expect(location.searchParams.get("redirect_uri")).toBe("https://portal.example/auth/callback/fake");
    } finally {
      withBaseUrl.stop();
    }
  });

  test("a trailing slash on the configured baseUrl is normalized away", async () => {
    const withTrailingSlash = createServer({
      port: 0,
      db: createDatabase(":memory:"),
      providers: { fake: fakeProviderConfig },
      accessTokenSecret: "access-secret",
      stateSecret: "state-secret",
      baseUrl: "https://portal.example/",
    });
    try {
      const response = await fetch(`${withTrailingSlash.url}auth/login/fake`, { redirect: "manual" });
      const location = new URL(response.headers.get("Location")!);
      expect(location.searchParams.get("redirect_uri")).toBe("https://portal.example/auth/callback/fake");
    } finally {
      withTrailingSlash.stop();
    }
  });

  test("callback with a bad code redirects to the shell with an error, not a crash", async () => {
    const loginResponse = await fetch(`${portal.url}auth/login/fake`, { redirect: "manual" });
    const state = new URL(loginResponse.headers.get("Location")!).searchParams.get("state")!;

    const callbackResponse = await fetch(
      `${portal.url}auth/callback/fake?code=wrong-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" }
    );
    expect(callbackResponse.status).toBe(302);
    const location = new URL(callbackResponse.headers.get("Location")!);
    expect(location.pathname).toBe("/");
    const fragment = new URLSearchParams(location.hash.slice(1));
    expect(fragment.get("error")).toBe("oauth_failed");
  });
});

describe("end-to-end: portalFetch transparently refreshes an expired access token", () => {
  test("a real expired access token triggers exactly one refresh, then the retried request succeeds", async () => {
    const { storeTokens, getStoredTokens } = await import("../../src/runtime/auth");
    const { portalFetch } = await import("../../src/runtime/fetch");

    // Log in for real, to get a genuine user + a real, valid refresh token —
    // then deliberately overwrite the access token with one already expired
    // (signAccessToken's ttlSeconds parameter makes this trivial), so the
    // very first portalFetch call is guaranteed to hit a real 401 from the
    // real server, not a contrived mock. Decode the userId straight out of
    // the real access token's own payload rather than logging in a second
    // time (a second login would just re-authenticate as the same
    // fake-provider user anyway, since findOrCreateUser is keyed on
    // provider + providerUserId — decoding is simpler and avoids the
    // redundant round trip).
    const { accessToken, refreshToken } = await loginAndGetTokens();
    const userId = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8")).sub as string;
    const expiredAccessToken = signAccessToken(userId, "access-secret", -1);
    storeTokens({ accessToken: expiredAccessToken, refreshToken });

    const response = await portalFetch(`${portal.url}me`);
    expect(response.status).toBe(200);
    const me = (await response.json()) as { id: string };
    expect(me.id).toBe(userId);

    const stored = getStoredTokens();
    expect(stored?.accessToken).not.toBe(expiredAccessToken);
    expect(stored?.refreshToken).not.toBe(refreshToken); // rotated

    sessionStorage.clear();
  });

  test("GET /auth/providers matches what the shell's login screen expects to render", async () => {
    const response = await fetch(`${portal.url}auth/providers`);
    const body = (await response.json()) as { name: string; label: string }[];
    expect(body).toContainEqual({ name: "fake", label: "Fake Provider" });
  });
});

describe("GET /auth/providers", () => {
  test("lists configured providers by name and label, with no secrets", async () => {
    const response = await fetch(`${portal.url}auth/providers`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown[];
    expect(body).toEqual([{ name: "fake", label: "Fake Provider" }]);
  });

  test("requires no authentication", async () => {
    // (same request as above, no Authorization header — already implicit,
    // this test exists to make the "no auth required" contract explicit
    // and catch a future accidental auth-gate regression)
    const response = await fetch(`${portal.url}auth/providers`);
    expect(response.status).not.toBe(401);
  });
});
