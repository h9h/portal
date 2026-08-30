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
let scsManifest: {
  name: string;
  routes: { path: string; requiredRoles: string[]; component?: string }[];
  nav: [];
  publishesContext?: string[];
};
let receivedAuthHeader: string | null;
let receivedSearch: string = "";
let ordersRedirectTo: string | null = null;
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
  ordersRedirectTo = null;

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
        if (ordersRedirectTo) {
          return new Response(null, { status: 302, headers: { Location: ordersRedirectTo } });
        }
        return new Response("orders fragment", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      if (url.pathname === "/.portal/bundle.js") {
        return new Response("export const OrdersView = () => null;", {
          status: 200,
          headers: { "Content-Type": "text/javascript; charset=utf-8" },
        });
      }
      if (url.pathname === "/portal-fragment") {
        receivedAuthHeader = req.headers.get("Authorization");
        receivedSearch = url.search;
        return new Response("portal fragment", { status: 200, headers: { "Content-Type": "text/plain" } });
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
    expect(payload!.aud).toBe(fakeScs.url.toString().replace(/\/$/, ""));
  });

  test("roles from unrelated SCSs are not forwarded in the internal token", async () => {
    assignRole(db, userId, "orders:admin");
    assignRole(db, userId, "billing:admin");
    assignRole(db, userId, "orders-legacy:admin");

    await fetch(`${portal.url}orders`, { headers: { Authorization: `Bearer ${accessToken}` } });

    const internalToken = receivedAuthHeader!.slice("Bearer ".length);
    const payload = verifyInternalToken(internalToken, INTERNAL_SECRET);
    expect(payload!.roles).toEqual(["orders:admin"]);
    expect(payload!.roles).not.toContain("billing:admin");
    expect(payload!.roles).not.toContain("orders-legacy:admin");
  });

  test("a portal:-prefixed role is never forwarded, even if an SCS self-declares as portal", async () => {
    scsManifest = { name: "portal", routes: [{ path: "/portal-fragment", requiredRoles: [] }], nav: [] };
    await new Promise((resolve) => setTimeout(resolve, 40));
    assignRole(db, userId, "portal:admin");

    await fetch(`${portal.url}portal-fragment`, { headers: { Authorization: `Bearer ${accessToken}` } });

    const internalToken = receivedAuthHeader!.slice("Bearer ".length);
    const payload = verifyInternalToken(internalToken, INTERNAL_SECRET);
    expect(payload!.roles).not.toContain("portal:admin");
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

  test("pre-existing Portal routes still work when a registry is configured", async () => {
    const health = await fetch(`${portal.url}health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const me = await fetch(`${portal.url}me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { id: string };
    expect(meBody.id).toBe(userId);
  });

  test("an unreachable SCS fragment endpoint returns a clean 502", async () => {
    assignRole(db, userId, "orders:admin");
    fakeScs.stop(true);

    const response = await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  test("a non-GET request to an enforceable path falls through to 404", async () => {
    const response = await fetch(`${portal.url}orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(404);
  });

  test("the SCS fragment fetch does not follow redirects and returns a 502 instead", async () => {
    assignRole(db, userId, "orders:admin");
    ordersRedirectTo = "https://example.com/attacker-controlled";

    const response = await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});

describe("GET /routes", () => {
  test("an unauthenticated request returns 401", async () => {
    const response = await fetch(`${portal.url}routes`);
    expect(response.status).toBe(401);
  });

  test("an authenticated request returns the full table, unfiltered by the caller's roles", async () => {
    // this user holds no roles at all, yet still sees /orders and its requiredRoles
    const response = await fetch(`${portal.url}routes`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { routes: { path: string; scsName: string; requiredRoles: string[] }[] };
    expect(body.routes).toEqual([{ path: "/orders", scsName: "orders", requiredRoles: ["orders:admin"] }]);
  });

  test("includes the component name when the manifest declares one", async () => {
    scsManifest = {
      name: "orders",
      routes: [{ path: "/orders", requiredRoles: ["orders:admin"], component: "OrdersView" }] as any,
      nav: [],
    };
    await new Promise((resolve) => setTimeout(resolve, 40));

    const response = await fetch(`${portal.url}routes`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json()) as { routes: { component?: string }[] };
    expect(body.routes[0].component).toBe("OrdersView");
  });

  test("includes contextOwners for a manifest declaring publishesContext", async () => {
    scsManifest = {
      name: "orders",
      routes: [{ path: "/orders", requiredRoles: ["orders:admin"] }],
      nav: [],
      publishesContext: ["orderStatus"],
    } as any;
    await new Promise((resolve) => setTimeout(resolve, 40));

    const response = await fetch(`${portal.url}routes`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json()) as { contextOwners: Record<string, string> };
    expect(body.contextOwners).toEqual({ orderStatus: "orders" });
  });
});

describe("GET /_scs/:scsName/bundle.js", () => {
  test("an unauthenticated request returns 401", async () => {
    const response = await fetch(`${portal.url}_scs/orders/bundle.js`);
    expect(response.status).toBe(401);
  });

  test("a request for an unknown scsName returns 404", async () => {
    const response = await fetch(`${portal.url}_scs/unknown-scs/bundle.js`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(404);
  });

  test("a request for an SCS with no declared bundle returns 404", async () => {
    // default scsManifest (set in beforeEach) has no bundle field
    const response = await fetch(`${portal.url}_scs/orders/bundle.js`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(404);
  });

  test("proxies the SCS's bundle bytes and content-type when declared, with no role check", async () => {
    scsManifest = { name: "orders", bundle: "/.portal/bundle.js", routes: [], nav: [] } as any;
    await new Promise((resolve) => setTimeout(resolve, 40));
    // userId/accessToken (from beforeEach) hold no roles at all — bundle fetch must still succeed
    const response = await fetch(`${portal.url}_scs/orders/bundle.js`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(await response.text()).toBe("export const OrdersView = () => null;");
  });

  test("an unreachable SCS returns a clean 502", async () => {
    scsManifest = { name: "orders", bundle: "/.portal/bundle.js", routes: [], nav: [] } as any;
    await new Promise((resolve) => setTimeout(resolve, 40));
    fakeScs.stop(true);
    const response = await fetch(`${portal.url}_scs/orders/bundle.js`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(502);
  });
});
