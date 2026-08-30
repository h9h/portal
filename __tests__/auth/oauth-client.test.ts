import { describe, test, expect } from "bun:test";
import { buildAuthorizeUrl, exchangeCodeForToken, fetchUserProfile } from "../../src/auth/oauth-client";
import type { OAuthProviderConfig } from "../../src/auth/providers";

const provider: OAuthProviderConfig = {
  name: "test-provider",
  authorizeUrl: "https://provider.example/authorize",
  tokenUrl: "https://provider.example/token",
  userInfoUrl: "https://provider.example/user",
  clientId: "client-123",
  clientSecret: "secret-456",
  scope: "read:user",
  mapProfile: (json: any) => ({
    providerUserId: String(json.id),
    email: json.email ?? null,
    displayName: json.name ?? null,
  }),
};

describe("buildAuthorizeUrl", () => {
  test("includes client id, redirect uri, scope, and state", () => {
    const url = new URL(buildAuthorizeUrl(provider, "the-state", "https://portal.example/auth/callback/test-provider"));
    expect(url.origin + url.pathname).toBe("https://provider.example/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://portal.example/auth/callback/test-provider");
    expect(url.searchParams.get("scope")).toBe("read:user");
    expect(url.searchParams.get("state")).toBe("the-state");
  });
});

describe("exchangeCodeForToken", () => {
  test("posts the code and returns the access token", async () => {
    let capturedBody: any = null;
    const fakeFetch = (async (_input: any, init?: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ access_token: "fake-access-token" }), { status: 200 });
    }) as typeof fetch;

    const token = await exchangeCodeForToken(provider, "the-code", "https://portal.example/auth/callback/test-provider", fakeFetch);

    expect(token).toBe("fake-access-token");
    expect(capturedBody.code).toBe("the-code");
    expect(capturedBody.client_id).toBe("client-123");
  });

  test("throws when the response has no access_token", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 400 })) as typeof fetch;
    await expect(exchangeCodeForToken(provider, "bad-code", "https://portal.example/cb", fakeFetch)).rejects.toThrow();
  });
});

describe("fetchUserProfile", () => {
  test("fetches and maps the provider's user profile", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ id: 42, email: "a@example.com", name: "A" }), { status: 200 })) as typeof fetch;
    const profile = await fetchUserProfile(provider, "fake-access-token", fakeFetch);
    expect(profile).toEqual({ providerUserId: "42", email: "a@example.com", displayName: "A" });
  });
});
