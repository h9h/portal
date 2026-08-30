import { describe, test, expect } from "bun:test";
import { buildRouteIndex } from "../../src/rights/route-access";
import type { ManifestEntry } from "../../src/scs/manifest-registry";

function entry(name: string, routes: { path: string; requiredRoles: string[] }[], stale = false): ManifestEntry {
  return {
    baseUrl: `http://${name}.local`,
    manifest: { name, routes, nav: [] },
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
    expect(index.routes.get("/orders")).toEqual({ scsName: "orders", requiredRoles: ["orders:viewer"] });
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
    expect(index.routes.get("/orders")).toEqual({ scsName: "orders", requiredRoles: ["orders:viewer"] });
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
    expect(index.routes.get("/orders")).toEqual({ scsName: "orders", requiredRoles: ["orders:viewer"] });
  });
});
