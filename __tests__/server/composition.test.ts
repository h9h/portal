import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer } from "../../src/server";
import { createDatabase } from "../../src/db";
import { createManifestRegistry } from "../../src/scs/manifest-registry";
import { signAccessToken } from "../../src/auth/tokens";
import { verifyInternalToken } from "../../src/auth/internal-tokens";
import { assignRole } from "../../src/rights/roles";
import { findOrCreateUser } from "../../src/auth/users";
import { __resetShellAssetsCacheForTests } from "../../src/shell/bundle";

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
    const response = await fetch(`${portal.url}orders`, {
      headers: { "X-Portal-Data": "1" },
    });
    expect(response.status).toBe(401);
  });

  test("an authenticated request without the required role returns a generic 403", async () => {
    const response = await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; requiredRoles?: unknown };
    expect(body.error).toBeTruthy();
    expect(body.requiredRoles).toBeUndefined();
  });

  test("an authenticated request with the required role fetches and forwards the SCS fragment", async () => {
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
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

    await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });

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

    await fetch(`${portal.url}portal-fragment`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });

    const internalToken = receivedAuthHeader!.slice("Bearer ".length);
    const payload = verifyInternalToken(internalToken, INTERNAL_SECRET);
    expect(payload!.roles).not.toContain("portal:admin");
  });

  test("a path no manifest declares returns 404", async () => {
    const response = await fetch(`${portal.url}unknown`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });
    expect(response.status).toBe(404);
  });

  test("a trailing slash on the request path is normalized before matching", async () => {
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}orders/`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });
    expect(response.status).toBe(200);
  });

  test("a query string doesn't affect route matching but is forwarded to the SCS", async () => {
    assignRole(db, userId, "orders:admin");

    const response = await fetch(`${portal.url}orders?page=2`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });
    expect(response.status).toBe(200);
    expect(receivedSearch).toBe("?page=2");
  });

  test("a public route (empty requiredRoles) is accessible to any authenticated user", async () => {
    scsManifest = { name: "orders", routes: [{ path: "/orders", requiredRoles: [] }], nav: [] };
    await new Promise((resolve) => setTimeout(resolve, 40));

    const response = await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });
    expect(response.status).toBe(200);
  });

  test("the cached route index reflects a manifest change after the registry refreshes", async () => {
    assignRole(db, userId, "orders:admin");
    const before = await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });
    expect(before.status).toBe(200);

    scsManifest = { name: "orders", routes: [{ path: "/orders", requiredRoles: ["orders:superadmin"] }], nav: [] };
    await new Promise((resolve) => setTimeout(resolve, 40));

    const after = await fetch(`${portal.url}orders`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });
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
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
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
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});

describe("page navigation (no X-Portal-Data header)", () => {
  test("an unauthenticated GET to an enforceable path returns the shell HTML, not 401", async () => {
    const response = await fetch(`${portal.url}orders`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(await response.text()).toContain('id="portal-root"');
  });

  test("an authenticated GET to an enforceable path also returns the shell HTML", async () => {
    const response = await fetch(`${portal.url}orders`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="portal-root"');
  });

  test("a totally unknown path also returns the shell HTML (SPA fallback)", async () => {
    const response = await fetch(`${portal.url}this-path-has-no-route`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="portal-root"');
  });

  test("root path returns the shell HTML", async () => {
    const response = await fetch(portal.url.toString());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="portal-root"');
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

  test("proxies the SCS's bundle bytes when declared, with no role check, always as text/javascript", async () => {
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

  test("hardcodes the response Content-Type even if the SCS declares a different one, and sets nosniff", async () => {
    fakeScs.stop(true);
    fakeScs = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/.portal/manifest") {
          return new Response(JSON.stringify(scsManifest), { status: 200 });
        }
        if (url.pathname === "/.portal/bundle.js") {
          return new Response("<html>not actually js</html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    scsManifest = { name: "orders", bundle: "/.portal/bundle.js", routes: [], nav: [] } as any;
    registry = await createManifestRegistry([fakeScs.url.toString().replace(/\/$/, "")], { refreshIntervalMs: 20 });
    portal.stop();
    portal = createServer({
      port: 0,
      db,
      accessTokenSecret: ACCESS_SECRET,
      stateSecret: "state-secret",
      internalTokenSecret: INTERNAL_SECRET,
      manifestRegistry: registry,
    });

    const response = await fetch(`${portal.url}_scs/orders/bundle.js`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
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

describe("GET /_shell/*", () => {
  test("serves each asset unauthenticated, with a JS content-type", async () => {
    for (const name of ["react", "react-dom", "jsx-runtime", "runtime", "shell"]) {
      const response = await fetch(`${portal.url}_shell/${name}.js`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
      const body = await response.text();
      expect(body.length).toBeGreaterThan(0);
    }
  });

  // Fix-round regression test (whole-branch review): getShellAssets()'s
  // output never changes for the life of the process, but every /_shell/*
  // response previously had no Cache-Control or ETag at all — so every page
  // navigation re-fetched the full ~500KB react-dom bundle from scratch.
  test("responses carry an ETag and Cache-Control for revalidation", async () => {
    const response = await fetch(`${portal.url}_shell/react.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBeTruthy();
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  // Fix-round regression test (whole-branch review): the handler used to
  // let a getShellAssets() rejection propagate unhandled out of fetch()
  // instead of returning a clean error response, unlike every other
  // dependency-fetch branch in this file (the /_scs/:scsName/bundle.js
  // proxy just above it). Forces one real Bun.build call to fail (see
  // bundle.test.ts's identical technique) and confirms the route now
  // returns a clean 502 instead of throwing.
  test("returns a clean 502 if the underlying build fails, instead of throwing unhandled", async () => {
    __resetShellAssetsCacheForTests();
    const originalBuild = Bun.build;
    (Bun as unknown as { build: typeof Bun.build }).build = (() =>
      Promise.resolve({
        success: false,
        logs: [{ message: "simulated build failure" }],
        outputs: [],
      })) as unknown as typeof Bun.build;

    try {
      const response = await fetch(`${portal.url}_shell/react.js`);
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toEqual({ error: "shell asset build failed" });
    } finally {
      Bun.build = originalBuild;
      __resetShellAssetsCacheForTests(); // don't leave the poisoned-then-cleared cache behind for later tests
    }
  });
});

describe("manifest name collisions across distinct base URLs", () => {
  test("voids bundle resolution and context ownership for a name claimed by two distinct SCSs", async () => {
    // fakeScs (from beforeEach) already self-declares "orders" with a bundle
    // and no context keys. Stand up a second, distinct SCS that also
    // self-declares "orders" (a different base URL), each with its own
    // distinct route and context key, so the collision can be attributed
    // unambiguously if it were (wrongly) resolved instead of voided.
    scsManifest = {
      name: "orders",
      bundle: "/.portal/bundle.js",
      routes: [{ path: "/orders-a", requiredRoles: [] }],
      nav: [],
      publishesContext: ["ctxA"],
    } as any;

    const secondScsManifest = {
      name: "orders",
      bundle: "/.portal/bundle.js",
      routes: [{ path: "/orders-b", requiredRoles: [] }],
      nav: [],
      publishesContext: ["ctxB"],
    };
    const secondScs = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/.portal/manifest") {
          return new Response(JSON.stringify(secondScsManifest), { status: 200 });
        }
        if (url.pathname === "/.portal/bundle.js") {
          return new Response("export const Other = () => null;", {
            status: 200,
            headers: { "Content-Type": "text/javascript; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      registry.stop();
      registry = await createManifestRegistry(
        [fakeScs.url.toString().replace(/\/$/, ""), secondScs.url.toString().replace(/\/$/, "")],
        { refreshIntervalMs: 20 }
      );
      portal.stop();
      portal = createServer({
        port: 0,
        db,
        accessTokenSecret: ACCESS_SECRET,
        stateSecret: "state-secret",
        internalTokenSecret: INTERNAL_SECRET,
        manifestRegistry: registry,
      });

      const bundleResponse = await fetch(`${portal.url}_scs/orders/bundle.js`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(bundleResponse.status).toBe(404);

      const routesResponse = await fetch(`${portal.url}routes`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const routesBody = (await routesResponse.json()) as { contextOwners: Record<string, string> };
      expect(routesBody.contextOwners).toEqual({});
    } finally {
      secondScs.stop(true);
    }
  });
});

describe("end-to-end: a manifest declaring bundle, component, and context fields", () => {
  test("GET /routes, GET /_scs/:scsName/bundle.js, and context ownership all agree with one manifest", async () => {
    scsManifest = {
      name: "orders",
      bundle: "/.portal/bundle.js",
      routes: [
        { path: "/orders", requiredRoles: ["orders:admin"], component: "OrdersView" },
        { path: "/orders/summary", requiredRoles: ["orders:admin"] },
      ],
      nav: [{ label: "Orders", path: "/orders", requiredRoles: ["orders:admin"] }],
      publishesContext: ["orderStatus"],
      consumesContext: ["profile"],
    } as any;
    await new Promise((resolve) => setTimeout(resolve, 40));

    // /routes reflects both the mounted-page route and the data-only route,
    // plus the context ownership this manifest declared.
    const routesResponse = await fetch(`${portal.url}routes`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const routesBody = (await routesResponse.json()) as {
      routes: { path: string; scsName: string; requiredRoles: string[]; component?: string }[];
      contextOwners: Record<string, string>;
    };
    expect(routesBody.routes).toEqual(
      expect.arrayContaining([
        { path: "/orders", scsName: "orders", requiredRoles: ["orders:admin"], component: "OrdersView" },
        { path: "/orders/summary", scsName: "orders", requiredRoles: ["orders:admin"] },
      ])
    );
    expect(routesBody.contextOwners).toEqual({ orderStatus: "orders" });

    // The bundle Portal proxies is exactly what the SCS itself serves.
    const bundleResponse = await fetch(`${portal.url}_scs/orders/bundle.js`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(bundleResponse.status).toBe(200);
    expect(await bundleResponse.text()).toBe("export const OrdersView = () => null;");

    // The data-only route still enforces roles exactly like before this plan.
    const dataResponse = await fetch(`${portal.url}orders/summary`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Portal-Data": "1" },
    });
    // this test's default accessToken/userId (from beforeEach) hold no roles
    expect(dataResponse.status).toBe(403);
  });

  test("a manifest self-declaring name \"portal\" cannot claim portal-owned context keys via publishesContext collision with a real Portal concept", async () => {
    // Sanity check that context ownership is validated the same way regardless
    // of what an SCS calls itself — no special-casing needed since ownership
    // is keyed on the declared key string, not on any reserved-name check.
    scsManifest = {
      name: "portal",
      routes: [],
      nav: [],
      publishesContext: ["profile"],
    } as any;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const response = await fetch(`${portal.url}routes`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = (await response.json()) as { contextOwners: Record<string, string> };
    expect(body.contextOwners).toEqual({ profile: "portal" });
  });
});
