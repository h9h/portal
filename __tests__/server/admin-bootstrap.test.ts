import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer, parseAdminEmails } from "../../src/server";
import { createDatabase } from "../../src/db";
import type { OAuthProviderConfig } from "../../src/auth/providers";

let fakeProvider: ReturnType<typeof Bun.serve>;
let fakeProviderConfig: OAuthProviderConfig;

beforeAll(() => {
  fakeProvider = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/token" && req.method === "POST") {
        return new Response(JSON.stringify({ access_token: "fake-provider-access-token" }), { status: 200 });
      }
      if (url.pathname === "/user" && req.method === "GET") {
        return new Response(JSON.stringify({ id: 1, email: "admin@example.com", name: "Admin" }), { status: 200 });
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
});

afterAll(() => {
  fakeProvider.stop();
});

async function login(portal: ReturnType<typeof createServer>) {
  const loginResponse = await fetch(`${portal.url}auth/login/fake`, { redirect: "manual" });
  const state = new URL(loginResponse.headers.get("Location")!).searchParams.get("state")!;
  const callbackResponse = await fetch(`${portal.url}auth/callback/fake?code=valid-code&state=${encodeURIComponent(state)}`);
  return callbackResponse.json() as Promise<{ accessToken: string }>;
}

describe("admin bootstrap on login", () => {
  test("a user whose email matches PORTAL_ADMIN_EMAILS is granted portal:admin on login", async () => {
    const portal = createServer({
      port: 0,
      db: createDatabase(":memory:"),
      providers: { fake: fakeProviderConfig },
      accessTokenSecret: "access-secret",
      stateSecret: "state-secret",
      adminEmails: ["admin@example.com"],
    });
    try {
      const { accessToken } = await login(portal);
      const meResponse = await fetch(`${portal.url}me`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const me = (await meResponse.json()) as { roles: string[] };
      expect(me.roles).toContain("portal:admin");
    } finally {
      portal.stop();
    }
  });

  test("a user whose email does not match PORTAL_ADMIN_EMAILS is not granted portal:admin", async () => {
    const portal = createServer({
      port: 0,
      db: createDatabase(":memory:"),
      providers: { fake: fakeProviderConfig },
      accessTokenSecret: "access-secret",
      stateSecret: "state-secret",
      adminEmails: ["someone-else@example.com"],
    });
    try {
      const { accessToken } = await login(portal);
      const meResponse = await fetch(`${portal.url}me`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const me = (await meResponse.json()) as { roles: string[] };
      expect(me.roles).not.toContain("portal:admin");
    } finally {
      portal.stop();
    }
  });

  test("logging in twice with a matching email stays idempotent (no error, role still present)", async () => {
    const portal = createServer({
      port: 0,
      db: createDatabase(":memory:"),
      providers: { fake: fakeProviderConfig },
      accessTokenSecret: "access-secret",
      stateSecret: "state-secret",
      adminEmails: ["admin@example.com"],
    });
    try {
      await login(portal);
      const { accessToken } = await login(portal);
      const meResponse = await fetch(`${portal.url}me`, { headers: { Authorization: `Bearer ${accessToken}` } });
      expect(meResponse.status).toBe(200);
      const me = (await meResponse.json()) as { roles: string[] };
      expect(me.roles).toEqual(["portal:admin"]);
    } finally {
      portal.stop();
    }
  });

  test("falls through to PORTAL_ADMIN_EMAILS when adminEmails is not passed", async () => {
    const previous = process.env.PORTAL_ADMIN_EMAILS;
    process.env.PORTAL_ADMIN_EMAILS = "admin@example.com";
    let portal: ReturnType<typeof createServer> | undefined;
    try {
      portal = createServer({
        port: 0,
        db: createDatabase(":memory:"),
        providers: { fake: fakeProviderConfig },
        accessTokenSecret: "access-secret",
        stateSecret: "state-secret",
      });
      const { accessToken } = await login(portal);
      const meResponse = await fetch(`${portal.url}me`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const me = (await meResponse.json()) as { roles: string[] };
      expect(me.roles).toContain("portal:admin");
    } finally {
      portal?.stop();
      if (previous === undefined) delete process.env.PORTAL_ADMIN_EMAILS;
      else process.env.PORTAL_ADMIN_EMAILS = previous;
    }
  });
});

describe("parseAdminEmails", () => {
  test("undefined returns an empty array", () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
  });

  test("an empty string returns an empty array", () => {
    expect(parseAdminEmails("")).toEqual([]);
  });

  test("a single email with no commas returns a one-element array", () => {
    expect(parseAdminEmails("a@example.com")).toEqual(["a@example.com"]);
  });

  test("comma-separated emails are all returned", () => {
    expect(parseAdminEmails("a@example.com,b@example.com,c@example.com")).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
  });

  test("entries with surrounding whitespace are trimmed", () => {
    expect(parseAdminEmails(" a@example.com , b@example.com ")).toEqual(["a@example.com", "b@example.com"]);
  });

  test("empty entries from consecutive/trailing commas are filtered out", () => {
    expect(parseAdminEmails("a@example.com,,b@example.com,")).toEqual(["a@example.com", "b@example.com"]);
  });
});
