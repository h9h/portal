import { describe, test, expect } from "bun:test";
import { buildRouteTable, buildContextOwners } from "../../src/shell/route-table";
import { buildRouteIndex } from "../../src/rights/route-access";
import { buildContextIndex } from "../../src/rights/context-index";
import type { ManifestEntry } from "../../src/scs/manifest-registry";

function entry(name: string, opts: { routes?: any[]; publishesContext?: string[] } = {}): ManifestEntry {
  return {
    baseUrl: `http://${name}.local`,
    manifest: {
      name,
      routes: opts.routes ?? [],
      nav: [],
      publishesContext: opts.publishesContext ?? [],
      consumesContext: [],
    },
    stale: false,
    lastFetchedAt: Date.now(),
  };
}

describe("buildRouteTable", () => {
  test("flattens the route index into a table, carrying component through", () => {
    const index = buildRouteIndex([
      entry("orders", { routes: [{ path: "/orders", requiredRoles: ["orders:viewer"], component: "OrdersView" }] }),
    ]);
    expect(buildRouteTable(index)).toEqual([
      { path: "/orders", scsName: "orders", requiredRoles: ["orders:viewer"], component: "OrdersView" },
    ]);
  });

  test("a data-only route (no component) has no component key in the table entry", () => {
    const index = buildRouteIndex([entry("orders", { routes: [{ path: "/orders/summary", requiredRoles: [] }] })]);
    const table = buildRouteTable(index);
    expect(table[0]).toEqual({ path: "/orders/summary", scsName: "orders", requiredRoles: [] });
    expect(table[0].component).toBeUndefined();
  });

  test("returns an empty table for an empty index", () => {
    expect(buildRouteTable(buildRouteIndex([]))).toEqual([]);
  });
});

describe("buildContextOwners", () => {
  test("returns a plain object mapping key to owning scsName", () => {
    const index = buildContextIndex([entry("profile", { publishesContext: ["profile"] })]);
    expect(buildContextOwners(index)).toEqual({ profile: "profile" });
  });

  test("returns an empty object when nothing is published", () => {
    expect(buildContextOwners(buildContextIndex([]))).toEqual({});
  });

  test("a collision-voided key is absent", () => {
    const index = buildContextIndex([
      { ...entry("a", { publishesContext: ["shared"] }), baseUrl: "http://a.local" },
      { ...entry("b", { publishesContext: ["shared"] }), baseUrl: "http://b.local" },
    ]);
    expect(buildContextOwners(index)).toEqual({});
  });
});
