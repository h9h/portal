import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "../../src/server";
import { createDatabase } from "../../src/db";
import type { OAuthProviderConfig } from "../../src/auth/providers";

let fakeProvider: ReturnType<typeof Bun.serve>;
let portal: ReturnType<typeof createServer>;

beforeAll(() => {
  fakeProvider = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/token" && req.method === "POST") {
        const body = await req.json();
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

  const providerConfig: OAuthProviderConfig = {
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
    providers: { fake: providerConfig },
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
    const me = await meResponse.json();
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
    const refreshed = await refreshResponse.json();
    expect(refreshed.accessToken).toBeTruthy();
    expect(refreshed.refreshToken).not.toBe(refreshToken);
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
});
