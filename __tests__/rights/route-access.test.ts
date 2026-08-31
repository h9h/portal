import { describe, test, expect } from "bun:test";
import { buildRouteIndex, checkAccess } from "../../src/rights/route-access";
import type { ManifestEntry } from "../../src/scs/manifest-registry";
import { createDatabase } from "../../src/db";
import { assignRole, getUserRoles } from "../../src/rights/roles";

function entry(
  name: string,
  routes: { path: string; requiredRoles: string[]; methods?: string[] }[],
  stale = false
): ManifestEntry {
  return {
    baseUrl: `http://${name}.local`,
    manifest: {
      name,
      routes: routes.map((route) => ({ ...route, methods: route.methods ?? ["GET"] })),
      nav: [],
      publishesContext: [],
      consumesContext: [],
    },
    stale,
    lastFetchedAt: stale ? null : Date.now(),
  };
}

function unreachableEntry(baseUrl: string): ManifestEntry {
  return { baseUrl, manifest: null, stale: true, lastFetchedAt: null };
}

describe("buildRouteIndex", () => {
  test("indexes routes from a single SCS", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: ["orders:viewer"] }]),
    ]);
    expect(index.routes.get("/orders")).toEqual({
      scsName: "orders",
      baseUrl: "http://orders.local",
      requiredRoles: ["orders:viewer"],
      methods: ["GET"],
    });
    expect(index.collisions).toEqual([]);
  });

  test("indexes routes from multiple SCSs with distinct paths", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: [] }]),
      entry("billing", [{ path: "/billing", requiredRoles: [] }]),
    ]);
    expect(index.routes.get("/orders")?.scsName).toBe("orders");
    expect(index.routes.get("/billing")?.scsName).toBe("billing");
    expect(index.collisions).toEqual([]);
  });

  test("excludes a colliding path from the index and reports the collision", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/shared", requiredRoles: [] }]),
      entry("billing", [{ path: "/shared", requiredRoles: [] }]),
    ]);
    expect(index.routes.has("/shared")).toBe(false);
    expect(index.collisions).toEqual([{ path: "/shared", scsNames: ["billing", "orders"] }]);
  });

  test("skips an SCS with no manifest (never successfully fetched)", () => {
    const index = buildRouteIndex([unreachableEntry("http://broken.local")]);
    expect(index.routes.size).toBe(0);
    expect(index.collisions).toEqual([]);
  });

  test("includes a stale SCS's last-known-good routes", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: ["orders:viewer"] }], true),
    ]);
    expect(index.routes.get("/orders")).toEqual({
      scsName: "orders",
      baseUrl: "http://orders.local",
      requiredRoles: ["orders:viewer"],
      methods: ["GET"],
    });
  });

  test("handles an SCS with an empty routes array", () => {
    const index = buildRouteIndex([entry("orders", [])]);
    expect(index.routes.size).toBe(0);
    expect(index.collisions).toEqual([]);
  });

  test("returns an empty index for no entries", () => {
    const index = buildRouteIndex([]);
    expect(index.routes.size).toBe(0);
    expect(index.collisions).toEqual([]);
  });

  test("does not treat one SCS declaring the same path twice as a collision", () => {
    const index = buildRouteIndex([
      entry("orders", [
        { path: "/orders", requiredRoles: ["orders:viewer"] },
        { path: "/orders", requiredRoles: ["orders:admin"] },
      ]),
    ]);
    expect(index.collisions).toEqual([]);
    expect(index.routes.get("/orders")).toEqual({
      scsName: "orders",
      baseUrl: "http://orders.local",
      requiredRoles: ["orders:viewer"],
      methods: ["GET"],
    });
  });

  test("propagates a route's component name into the index", () => {
    const index = buildRouteIndex([
      {
        baseUrl: "http://orders.local",
        manifest: {
          name: "orders",
          routes: [{ path: "/orders", requiredRoles: [], methods: ["GET"], component: "OrdersView" }],
          nav: [],
          publishesContext: [],
          consumesContext: [],
        },
        stale: false,
        lastFetchedAt: Date.now(),
      },
    ]);
    expect(index.routes.get("/orders")?.component).toBe("OrdersView");
  });

  test("omits component from the index for a data-only route", () => {
    const index = buildRouteIndex([
      {
        baseUrl: "http://orders.local",
        manifest: {
          name: "orders",
          routes: [{ path: "/orders/summary", requiredRoles: [], methods: ["GET"] }],
          nav: [],
          publishesContext: [],
          consumesContext: [],
        },
        stale: false,
        lastFetchedAt: Date.now(),
      },
    ]);
    expect(index.routes.get("/orders/summary")?.component).toBeUndefined();
  });

  test("propagates a route's declared methods into the index", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders/create", requiredRoles: ["orders:editor"], methods: ["POST"] }]),
    ]);
    expect(index.routes.get("/orders/create")?.methods).toEqual(["POST"]);
  });

  test("defaults a route's methods to [\"GET\"] in the index when the manifest omitted it", () => {
    const index = buildRouteIndex([entry("orders", [{ path: "/orders", requiredRoles: [] }])]);
    expect(index.routes.get("/orders")?.methods).toEqual(["GET"]);
  });
});

describe("checkAccess", () => {
  test("allows a request to a public route (empty requiredRoles) regardless of user roles", () => {
    const index = buildRouteIndex([entry("orders", [{ path: "/orders", requiredRoles: [] }])]);
    expect(checkAccess(index, "/orders", [])).toEqual({ status: "allowed" });
  });

  test("allows a request when the user holds the required role", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: ["orders:viewer"] }]),
    ]);
    expect(checkAccess(index, "/orders", ["orders:viewer"])).toEqual({ status: "allowed" });
  });

  test("allows a request when the user holds at least one of several required roles", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: ["orders:viewer", "orders:admin"] }]),
    ]);
    expect(checkAccess(index, "/orders", ["orders:admin"])).toEqual({ status: "allowed" });
  });

  test("forbids a request when the user holds none of the required roles", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: ["orders:admin"] }]),
    ]);
    expect(checkAccess(index, "/orders", ["billing:viewer"])).toEqual({
      status: "forbidden",
      requiredRoles: ["orders:admin"],
    });
  });

  test("forbids a request when the user has no roles at all", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: ["orders:admin"] }]),
    ]);
    expect(checkAccess(index, "/orders", [])).toEqual({
      status: "forbidden",
      requiredRoles: ["orders:admin"],
    });
  });

  test("reports not_found for a path no manifest declares", () => {
    const index = buildRouteIndex([entry("orders", [{ path: "/orders", requiredRoles: [] }])]);
    expect(checkAccess(index, "/unknown", ["orders:admin"])).toEqual({ status: "not_found" });
  });

  test("reports not_found for a path excluded due to a cross-SCS collision", () => {
    const index = buildRouteIndex([
      entry("orders", [{ path: "/shared", requiredRoles: [] }]),
      entry("billing", [{ path: "/shared", requiredRoles: [] }]),
    ]);
    expect(checkAccess(index, "/shared", ["orders:admin", "billing:admin"])).toEqual({ status: "not_found" });
  });
});

describe("integration: role storage + route enforcement", () => {
  test("roles assigned and read back via sqlite storage satisfy the route's requiredRoles check", () => {
    const db = createDatabase(":memory:");
    const index = buildRouteIndex([
      entry("orders", [{ path: "/orders", requiredRoles: ["orders:admin"] }]),
    ]);

    expect(checkAccess(index, "/orders", getUserRoles(db, "user-1"))).toEqual({
      status: "forbidden",
      requiredRoles: ["orders:admin"],
    });

    assignRole(db, "user-1", "orders:admin");

    expect(checkAccess(index, "/orders", getUserRoles(db, "user-1"))).toEqual({ status: "allowed" });
  });
});
