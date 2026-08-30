import { describe, test, expect } from "bun:test";
import { resolveRoute, normalizePath, type RouteTableEntry } from "../../src/frontend/router";

const table: RouteTableEntry[] = [
  { path: "/orders", scsName: "orders", requiredRoles: ["orders:viewer"], component: "OrdersView" },
  { path: "/orders/summary", scsName: "orders", requiredRoles: ["orders:viewer"] }, // data-only, no component
  { path: "/public", scsName: "misc", requiredRoles: [], component: "PublicView" },
];

describe("resolveRoute", () => {
  test("returns not_found for a path with no matching entry", () => {
    expect(resolveRoute(table, "/unknown", [])).toEqual({ status: "not_found" });
  });

  test("returns forbidden when the user lacks every required role", () => {
    expect(resolveRoute(table, "/orders", [])).toEqual({ status: "forbidden", requiredRoles: ["orders:viewer"] });
  });

  test("returns matched when the user holds a required role", () => {
    expect(resolveRoute(table, "/orders", ["orders:viewer"])).toEqual({
      status: "matched",
      entry: table[0],
    });
  });

  test("returns matched for a public route (empty requiredRoles) regardless of roles", () => {
    expect(resolveRoute(table, "/public", [])).toEqual({ status: "matched", entry: table[2] });
  });

  test("returns no_component for a matched data-only route", () => {
    expect(resolveRoute(table, "/orders/summary", ["orders:viewer"])).toEqual({ status: "no_component" });
  });

  // Fix-round regression test (whole-branch review): src/server.ts's
  // composition catch-all normalizes the request path (stripping trailing
  // slashes) before consulting the route index, so `.../orders/` is served
  // the same as `.../orders`. resolveRoute previously had no matching
  // normalization, so a trailing-slash navigation would get the shell HTML
  // from the server and then a client-side "Not found" for a path the
  // server would happily serve.
  test("a trailing slash is normalized before matching, resolving the same entry", () => {
    expect(resolveRoute(table, "/orders/", ["orders:viewer"])).toEqual({
      status: "matched",
      entry: table[0],
    });
  });

  // The root path "/" has no table entry in this fixture, so this only
  // confirms normalizePath itself leaves a bare "/" untouched (never
  // stripped down to an empty string) rather than exercising resolveRoute's
  // lookup against a "/" entry.
  test("normalizePath leaves a bare root path untouched", () => {
    expect(normalizePath("/")).toBe("/");
  });
});
