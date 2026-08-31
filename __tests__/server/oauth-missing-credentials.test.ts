import { describe, test, expect, spyOn } from "bun:test";
import { createServer } from "../../src/server";
import { createDatabase } from "../../src/db";
import type { OAuthProviderConfig } from "../../src/auth/providers";

function providerWithoutCredentials(overrides: Partial<OAuthProviderConfig> = {}): OAuthProviderConfig {
  return {
    name: "fake",
    label: "Fake Provider",
    authorizeUrl: "https://fake-provider.example/authorize",
    tokenUrl: "https://fake-provider.example/token",
    userInfoUrl: "https://fake-provider.example/user",
    clientId: "",
    clientSecret: "",
    scope: "read:user",
    mapProfile: (json: any) => ({ providerUserId: String(json.id), email: null, displayName: null }),
    ...overrides,
  };
}

describe("OAuth provider missing credentials", () => {
  test("warns at boot when a provider has no client credentials", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const server = createServer({
      port: 0,
      db: createDatabase(":memory:"),
      providers: { fake: providerWithoutCredentials() },
      accessTokenSecret: "access-secret",
      stateSecret: "state-secret",
    });

    try {
      const calls = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(calls.some((message) => message.includes('"fake"') && message.includes("FAKE_CLIENT_ID"))).toBe(true);
    } finally {
      server.stop();
      warnSpy.mockRestore();
    }
  });

  test("does not warn when a provider has both credentials set", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const server = createServer({
      port: 0,
      db: createDatabase(":memory:"),
      providers: { fake: providerWithoutCredentials({ clientId: "id", clientSecret: "secret" }) },
      accessTokenSecret: "access-secret",
      stateSecret: "state-secret",
    });

    try {
      const calls = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(calls.some((message) => message.includes("client credentials"))).toBe(false);
    } finally {
      server.stop();
      warnSpy.mockRestore();
    }
  });

  test("GET /auth/login/:provider redirects to the shell error screen instead of the provider", async () => {
    const server = createServer({
      port: 0,
      db: createDatabase(":memory:"),
      providers: { fake: providerWithoutCredentials() },
      accessTokenSecret: "access-secret",
      stateSecret: "state-secret",
    });

    try {
      const response = await fetch(`${server.url}auth/login/fake`, { redirect: "manual" });
      expect(response.status).toBe(302);
      const location = response.headers.get("Location")!;
      expect(location).toBe(`${server.url}#error=oauth_failed`);
      expect(location).not.toContain("fake-provider.example");
    } finally {
      server.stop();
    }
  });
});
