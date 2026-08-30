import { describe, test, expect } from "bun:test";
import { resolveRoute, type RouteTableEntry } from "../../src/frontend/router";

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

  test("path matching is exact — a trailing slash does not match", () => {
    expect(resolveRoute(table, "/orders/", ["orders:viewer"])).toEqual({ status: "not_found" });
  });
});
