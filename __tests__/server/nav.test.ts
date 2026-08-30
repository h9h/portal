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
  test("an unauthenticated request returns 401", async () => {
    const response = await fetch(`${portal.url}nav`);
    expect(response.status).toBe(401);
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
