import { describe, test, expect } from "bun:test";
import { buildNav } from "../../src/rights/nav";
import type { ManifestEntry } from "../../src/scs/manifest-registry";

function entry(
  name: string,
  nav: { label: string; path: string; requiredRoles: string[] }[],
  stale = false
): ManifestEntry {
  return {
    baseUrl: `http://${name}.local`,
    manifest: { name, routes: [], nav, publishesContext: [], consumesContext: [] },
    stale,
    lastFetchedAt: stale ? null : Date.now(),
  };
}

function unreachableEntry(baseUrl: string): ManifestEntry {
  return { baseUrl, manifest: null, stale: true, lastFetchedAt: null };
}

describe("buildNav", () => {
  test("includes nav entries from multiple SCSs, tagged with their domain", () => {
    const nav = buildNav(
      [
        entry("orders", [{ label: "Orders", path: "/orders", requiredRoles: [] }]),
        entry("billing", [{ label: "Billing", path: "/billing", requiredRoles: [] }]),
      ],
      []
    );
    expect(nav).toEqual([
      { label: "Orders", path: "/orders", domain: "orders" },
      { label: "Billing", path: "/billing", domain: "billing" },
    ]);
  });

  test("includes an entry with empty requiredRoles regardless of the user's roles", () => {
    const nav = buildNav([entry("orders", [{ label: "Orders", path: "/orders", requiredRoles: [] }])], []);
    expect(nav).toEqual([{ label: "Orders", path: "/orders", domain: "orders" }]);
  });

  test("excludes an entry when the user holds none of its required roles", () => {
    const nav = buildNav(
      [entry("orders", [{ label: "Orders", path: "/orders", requiredRoles: ["orders:admin"] }])],
      ["billing:viewer"]
    );
    expect(nav).toEqual([]);
  });

  test("includes an entry when the user holds the required role", () => {
    const nav = buildNav(
      [entry("orders", [{ label: "Orders", path: "/orders", requiredRoles: ["orders:admin"] }])],
      ["orders:admin"]
    );
    expect(nav).toEqual([{ label: "Orders", path: "/orders", domain: "orders" }]);
  });

  test("includes an entry when the user holds at least one of several required roles", () => {
    const nav = buildNav(
      [
        entry("orders", [
          { label: "Orders", path: "/orders", requiredRoles: ["orders:viewer", "orders:admin"] },
        ]),
      ],
      ["orders:admin"]
    );
    expect(nav).toEqual([{ label: "Orders", path: "/orders", domain: "orders" }]);
  });

  test("skips an SCS with no manifest (never successfully fetched)", () => {
    const nav = buildNav([unreachableEntry("http://broken.local")], []);
    expect(nav).toEqual([]);
  });

  test("includes a stale SCS's last-known-good nav entries", () => {
    const nav = buildNav([entry("orders", [{ label: "Orders", path: "/orders", requiredRoles: [] }], true)], []);
    expect(nav).toEqual([{ label: "Orders", path: "/orders", domain: "orders" }]);
  });

  test("handles an SCS with an empty nav array", () => {
    const nav = buildNav([entry("orders", [])], []);
    expect(nav).toEqual([]);
  });

  test("returns an empty array for no entries", () => {
    expect(buildNav([], [])).toEqual([]);
  });

  test("does not exclude nav entries that share a path across different SCSs (no collision check, unlike routes)", () => {
    const nav = buildNav(
      [
        entry("orders", [{ label: "Orders Home", path: "/shared", requiredRoles: [] }]),
        entry("billing", [{ label: "Billing Home", path: "/shared", requiredRoles: [] }]),
      ],
      []
    );
    expect(nav).toEqual([
      { label: "Orders Home", path: "/shared", domain: "orders" },
      { label: "Billing Home", path: "/shared", domain: "billing" },
    ]);
  });
});
