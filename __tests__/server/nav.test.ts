import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer } from "../../src/server";
import { createDatabase } from "../../src/db";
import { createManifestRegistry } from "../../src/scs/manifest-registry";
import { signAccessToken } from "../../src/auth/tokens";
import { assignRole } from "../../src/rights/roles";
import { findOrCreateUser } from "../../src/auth/users";

const ACCESS_SECRET = "access-secret";

let fakeScs: ReturnType<typeof Bun.serve>;
let registry: Awaited<ReturnType<typeof createManifestRegistry>>;
let portal: ReturnType<typeof createServer>;
let db: ReturnType<typeof createDatabase>;
let userId: string;
let accessToken: string;

beforeEach(async () => {
  fakeScs = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.portal/manifest") {
        return new Response(
          JSON.stringify({
            name: "orders",
            routes: [],
            nav: [
              { label: "Orders Home", path: "/orders", requiredRoles: [] },
              { label: "Orders Admin", path: "/orders/admin", requiredRoles: ["orders:admin"] },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  registry = await createManifestRegistry([fakeScs.url.toString().replace(/\/$/, "")]);

  db = createDatabase(":memory:");
  const user = findOrCreateUser(db, "github", { providerUserId: "1", email: null, displayName: null });
  userId = user.id;
  accessToken = signAccessToken(userId, ACCESS_SECRET);

  portal = createServer({
    port: 0,
    db,
    accessTokenSecret: ACCESS_SECRET,
    stateSecret: "state-secret",
    internalTokenSecret: "internal-secret",
    manifestRegistry: registry,
  });
});

afterEach(() => {
  portal.stop();
  registry.stop();
  fakeScs.stop();
});

describe("GET /nav", () => {
  test("an unauthenticated request returns only public nav entries instead of 401", async () => {
    const response = await fetch(`${portal.url}nav`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { nav: { label: string; path: string; domain: string }[] };
    expect(body.nav).toEqual([{ label: "Orders Home", path: "/orders", domain: "orders" }]);
  });

  test("returns only the nav entries the user's roles satisfy", async () => {
    const response = await fetch(`${portal.url}nav`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { nav: { label: string; path: string; domain: string }[] };
    expect(body.nav).toEqual([{ label: "Orders Home", path: "/orders", domain: "orders" }]);
  });

  test("includes a role-gated entry once the user holds the required role", async () => {
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}nav`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json()) as { nav: { label: string; path: string; domain: string }[] };
    expect(body.nav).toEqual([
      { label: "Orders Home", path: "/orders", domain: "orders" },
      { label: "Orders Admin", path: "/orders/admin", domain: "orders" },
    ]);
  });
});

describe("nav and route enforcement agree", () => {
  test("a role-gated path is hidden from nav and 403s, a public path is shown and 200s, for the same manifest", async () => {
    const ordersFakeScs = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/.portal/manifest") {
          return new Response(
            JSON.stringify({
              name: "orders",
              routes: [
                { path: "/orders/admin", requiredRoles: ["orders:admin"] },
                { path: "/orders/public", requiredRoles: [] },
              ],
              nav: [
                { label: "Orders Admin", path: "/orders/admin", requiredRoles: ["orders:admin"] },
                { label: "Orders Public", path: "/orders/public", requiredRoles: [] },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.pathname === "/orders/public") {
          return new Response("public fragment", { status: 200 });
        }
        if (url.pathname === "/orders/admin") {
          return new Response("admin fragment", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const ordersRegistry = await createManifestRegistry([ordersFakeScs.url.toString().replace(/\/$/, "")]);
    const ordersDb = createDatabase(":memory:");
    const ordersUser = findOrCreateUser(ordersDb, "github", { providerUserId: "2", email: null, displayName: null });
    const ordersAccessToken = signAccessToken(ordersUser.id, ACCESS_SECRET);

    const ordersPortal = createServer({
      port: 0,
      db: ordersDb,
      accessTokenSecret: ACCESS_SECRET,
      stateSecret: "state-secret",
      internalTokenSecret: "internal-secret",
      manifestRegistry: ordersRegistry,
    });

    try {
      const authHeaders = { headers: { Authorization: `Bearer ${ordersAccessToken}` } };
      // These composed routes (/orders/public, /orders/admin) are enforced via
      // Portal's data-fetch flow, which requires the marker header — see
      // Task 8's content-negotiation split in src/server.ts.
      const dataHeaders = { headers: { Authorization: `Bearer ${ordersAccessToken}`, "X-Portal-Data": "1" } };

      const navBefore = await fetch(`${ordersPortal.url}nav`, authHeaders);
      const navBeforeBody = (await navBefore.json()) as { nav: { label: string; path: string; domain: string }[] };
      expect(navBeforeBody.nav).toEqual([{ label: "Orders Public", path: "/orders/public", domain: "orders" }]);

      const publicBefore = await fetch(`${ordersPortal.url}orders/public`, dataHeaders);
      expect(publicBefore.status).toBe(200);

      const adminBefore = await fetch(`${ordersPortal.url}orders/admin`, dataHeaders);
      expect(adminBefore.status).toBe(403);

      assignRole(ordersDb, ordersUser.id, "orders:admin");

      const navAfter = await fetch(`${ordersPortal.url}nav`, authHeaders);
      const navAfterBody = (await navAfter.json()) as { nav: { label: string; path: string; domain: string }[] };
      expect(navAfterBody.nav).toEqual([
        { label: "Orders Admin", path: "/orders/admin", domain: "orders" },
        { label: "Orders Public", path: "/orders/public", domain: "orders" },
      ]);

      const adminAfter = await fetch(`${ordersPortal.url}orders/admin`, dataHeaders);
      expect(adminAfter.status).toBe(200);
    } finally {
      ordersPortal.stop();
      ordersRegistry.stop();
      ordersFakeScs.stop();
    }
  });
});

describe("GET /nav with no manifestRegistry configured", () => {
  test("returns an empty nav array rather than an error", async () => {
    const noRegistryPortal = createServer({
      port: 0,
      db: createDatabase(":memory:"),
      accessTokenSecret: ACCESS_SECRET,
      stateSecret: "state-secret",
    });
    try {
      const response = await fetch(`${noRegistryPortal.url}nav`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { nav: unknown[] };
      expect(body.nav).toEqual([]);
    } finally {
      noRegistryPortal.stop();
    }
  });
});

describe("GET /me", () => {
  test("returns the user's real roles instead of a hardcoded empty array", async () => {
    assignRole(db, userId, "orders:admin");
    assignRole(db, userId, "billing:viewer");

    const response = await fetch(`${portal.url}me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { roles: string[] };
    expect(body.roles.sort()).toEqual(["billing:viewer", "orders:admin"]);
  });
});
