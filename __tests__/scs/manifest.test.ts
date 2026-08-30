import { describe, test, expect } from "bun:test";
import { parseManifest } from "../../src/scs/manifest";

describe("parseManifest", () => {
  test("parses a valid manifest", () => {
    const manifest = parseManifest({
      name: "orders",
      routes: [{ path: "/orders", requiredRoles: ["orders:viewer"] }],
      nav: [{ label: "Orders", path: "/orders", requiredRoles: ["orders:viewer"] }],
    });
    expect(manifest).toEqual({
      name: "orders",
      routes: [{ path: "/orders", requiredRoles: ["orders:viewer"] }],
      nav: [{ label: "Orders", path: "/orders", requiredRoles: ["orders:viewer"] }],
    });
  });

  test("allows empty routes and nav arrays", () => {
    const manifest = parseManifest({ name: "orders", routes: [], nav: [] });
    expect(manifest).toEqual({ name: "orders", routes: [], nav: [] });
  });

  test("ignores unknown top-level fields", () => {
    const manifest = parseManifest({ name: "orders", routes: [], nav: [], extra: "ignored" });
    expect(manifest).toEqual({ name: "orders", routes: [], nav: [] });
  });

  test("rejects a missing name", () => {
    expect(parseManifest({ routes: [], nav: [] })).toBeNull();
  });

  test("rejects an empty name", () => {
    expect(parseManifest({ name: "", routes: [], nav: [] })).toBeNull();
  });

  test("rejects a non-array routes field", () => {
    expect(parseManifest({ name: "orders", routes: "not-an-array", nav: [] })).toBeNull();
  });

  test("rejects a non-array nav field", () => {
    expect(parseManifest({ name: "orders", routes: [], nav: "not-an-array" })).toBeNull();
  });

  test("rejects a route entry missing requiredRoles", () => {
    expect(parseManifest({ name: "orders", routes: [{ path: "/orders" }], nav: [] })).toBeNull();
  });

  test("rejects a route entry with a non-string-array requiredRoles", () => {
    expect(
      parseManifest({ name: "orders", routes: [{ path: "/orders", requiredRoles: [1, 2] }], nav: [] })
    ).toBeNull();
  });

  test("rejects a nav entry missing label", () => {
    expect(
      parseManifest({ name: "orders", routes: [], nav: [{ path: "/orders", requiredRoles: [] }] })
    ).toBeNull();
  });

  test("rejects a completely malformed payload", () => {
    expect(parseManifest("not-an-object")).toBeNull();
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest(undefined)).toBeNull();
    expect(parseManifest(42)).toBeNull();
  });
});
