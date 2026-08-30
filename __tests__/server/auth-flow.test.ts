import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "../../src/server";
import { createDatabase } from "../../src/db";
import type { OAuthProviderConfig } from "../../src/auth/providers";

let fakeProvider: ReturnType<typeof Bun.serve>;
let portal: ReturnType<typeof createServer>;
let fakeProviderConfig: OAuthProviderConfig;

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
  const callbackResponse = await fetch(`${portal.url}auth/callback/fake?code=valid-code&state=${encodeURIComponent(state)}`);
  return callbackResponse.json() as Promise<{ accessToken: string; refreshToken: string }>;
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

  test("callback with a bad code returns a clean error, not a crash", async () => {
    const loginResponse = await fetch(`${portal.url}auth/login/fake`, { redirect: "manual" });
    const state = new URL(loginResponse.headers.get("Location")!).searchParams.get("state")!;

    const callbackResponse = await fetch(
      `${portal.url}auth/callback/fake?code=wrong-code&state=${encodeURIComponent(state)}`
    );
    // 502: a clean JSON error reporting the upstream (provider) failure —
    // not Bun's HTML stack-trace crash page (which would be a 500 with
    // Content-Type text/html).
    expect(callbackResponse.status).toBe(502);
    expect(callbackResponse.headers.get("Content-Type")).toBe("application/json");
    const body = (await callbackResponse.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});
