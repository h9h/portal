import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer } from "../../src/server";
import { createDatabase } from "../../src/db";
import { createManifestRegistry } from "../../src/scs/manifest-registry";
import { signAccessToken } from "../../src/auth/tokens";
import { verifyInternalToken } from "../../src/auth/internal-tokens";
import { assignRole } from "../../src/rights/roles";
import { findOrCreateUser } from "../../src/auth/users";

const ACCESS_SECRET = "access-secret";
const INTERNAL_SECRET = "internal-secret";

let fakeScs: ReturnType<typeof Bun.serve>;
let scsManifest: { name: string; routes: { path: string; requiredRoles: string[] }[]; nav: [] };
let receivedAuthHeader: string | null;
let receivedSearch: string = "";
let registry: Awaited<ReturnType<typeof createManifestRegistry>>;
let portal: ReturnType<typeof createServer>;
let db: ReturnType<typeof createDatabase>;
let userId: string;
let accessToken: string;

beforeEach(async () => {
  scsManifest = {
    name: "orders",
    routes: [{ path: "/orders", requiredRoles: ["orders:admin"] }],
    nav: [],
  };
  receivedAuthHeader = null;

  fakeScs = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.portal/manifest") {
        return new Response(JSON.stringify(scsManifest), { status: 200 });
      }
      if (url.pathname === "/orders") {
        receivedAuthHeader = req.headers.get("Authorization");
        receivedSearch = url.search;
        return new Response("orders fragment", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response("not found", { status: 404 });
    },
  });

  registry = await createManifestRegistry([fakeScs.url.toString().replace(/\/$/, "")], { refreshIntervalMs: 20 });

  db = createDatabase(":memory:");
  const user = findOrCreateUser(db, "github", { providerUserId: "1", email: null, displayName: null });
  userId = user.id;
  accessToken = signAccessToken(userId, ACCESS_SECRET);

  portal = createServer({
    port: 0,
    db,
    accessTokenSecret: ACCESS_SECRET,
    stateSecret: "state-secret",
    internalTokenSecret: INTERNAL_SECRET,
    manifestRegistry: registry,
  });
});

afterEach(() => {
  portal.stop();
  registry.stop();
  fakeScs.stop();
});

describe("route composition", () => {
  test("an unauthenticated request to an enforceable route returns 401", async () => {
    const response = await fetch(`${portal.url}orders`);
    expect(response.status).toBe(401);
  });

  test("an authenticated request without the required role returns a generic 403", async () => {
    const response = await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; requiredRoles?: unknown };
    expect(body.error).toBeTruthy();
    expect(body.requiredRoles).toBeUndefined();
  });

  test("an authenticated request with the required role fetches and forwards the SCS fragment", async () => {
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(await response.text()).toBe("orders fragment");

    expect(receivedAuthHeader).toMatch(/^Bearer /);
    const internalToken = receivedAuthHeader!.slice("Bearer ".length);
    const payload = verifyInternalToken(internalToken, INTERNAL_SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(userId);
    expect(payload!.roles).toEqual(["orders:admin"]);
  });

  test("roles from unrelated SCSs are not forwarded in the internal token", async () => {
    assignRole(db, userId, "orders:admin");
    assignRole(db, userId, "billing:admin");

    await fetch(`${portal.url}orders`, { headers: { Authorization: `Bearer ${accessToken}` } });

    const internalToken = receivedAuthHeader!.slice("Bearer ".length);
    const payload = verifyInternalToken(internalToken, INTERNAL_SECRET);
    expect(payload!.roles).toEqual(["orders:admin"]);
  });

  test("a path no manifest declares returns 404", async () => {
    const response = await fetch(`${portal.url}unknown`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(404);
  });

  test("a trailing slash on the request path is normalized before matching", async () => {
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}orders/`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
  });

  test("a query string doesn't affect route matching but is forwarded to the SCS", async () => {
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}orders?page=2`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    expect(receivedSearch).toBe("?page=2");
  });

  test("a public route (empty requiredRoles) is accessible to any authenticated user", async () => {
    scsManifest = { name: "orders", routes: [{ path: "/orders", requiredRoles: [] }], nav: [] };
    await new Promise((resolve) => setTimeout(resolve, 40));

    const response = await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
  });

  test("the cached route index reflects a manifest change after the registry refreshes", async () => {
    assignRole(db, userId, "orders:admin");
    const before = await fetch(`${portal.url}orders`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(before.status).toBe(200);

    scsManifest = { name: "orders", routes: [{ path: "/orders", requiredRoles: ["orders:superadmin"] }], nav: [] };
    await new Promise((resolve) => setTimeout(resolve, 40));

    const after = await fetch(`${portal.url}orders`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(after.status).toBe(403);
  });
});
