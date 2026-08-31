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
      routes: [{ path: "/orders", requiredRoles: ["orders:viewer"], methods: ["GET"] }],
      nav: [{ label: "Orders", path: "/orders", requiredRoles: ["orders:viewer"] }],
      publishesContext: [],
      consumesContext: [],
    });
  });

  test("allows empty routes and nav arrays", () => {
    const manifest = parseManifest({ name: "orders", routes: [], nav: [] });
    expect(manifest).toEqual({ name: "orders", routes: [], nav: [], publishesContext: [], consumesContext: [] });
  });

  test("ignores unknown top-level fields", () => {
    const manifest = parseManifest({ name: "orders", routes: [], nav: [], extra: "ignored" });
    expect(manifest).toEqual({ name: "orders", routes: [], nav: [], publishesContext: [], consumesContext: [] });
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

describe("bundle field", () => {
  test("accepts a manifest with a bundle path", () => {
    const manifest = parseManifest({ name: "orders", bundle: "/.portal/bundle.js", routes: [], nav: [] });
    expect(manifest?.bundle).toBe("/.portal/bundle.js");
  });

  test("omits bundle when absent", () => {
    const manifest = parseManifest({ name: "orders", routes: [], nav: [] });
    expect(manifest?.bundle).toBeUndefined();
  });

  test("rejects a non-string bundle", () => {
    expect(parseManifest({ name: "orders", bundle: 42, routes: [], nav: [] })).toBeNull();
  });

  test("rejects an empty-string bundle", () => {
    expect(parseManifest({ name: "orders", bundle: "", routes: [], nav: [] })).toBeNull();
  });
});

describe("route component field", () => {
  test("accepts a route with a component name", () => {
    const manifest = parseManifest({
      name: "orders",
      routes: [{ path: "/orders", requiredRoles: [], component: "OrdersView" }],
      nav: [],
    });
    expect(manifest?.routes[0]).toEqual({ path: "/orders", requiredRoles: [], methods: ["GET"], component: "OrdersView" });
  });

  test("omits component when absent (data-only route)", () => {
    const manifest = parseManifest({
      name: "orders",
      routes: [{ path: "/orders/summary", requiredRoles: [] }],
      nav: [],
    });
    expect(manifest?.routes[0]).toEqual({ path: "/orders/summary", requiredRoles: [], methods: ["GET"] });
    expect(manifest?.routes[0].component).toBeUndefined();
  });

  test("rejects a non-string component", () => {
    expect(
      parseManifest({ name: "orders", routes: [{ path: "/orders", requiredRoles: [], component: 42 }], nav: [] })
    ).toBeNull();
  });
});

describe("methods field", () => {
  test('defaults to ["GET"] when absent', () => {
    const manifest = parseManifest({ name: "orders", routes: [{ path: "/orders", requiredRoles: [] }], nav: [] });
    expect(manifest?.routes[0].methods).toEqual(["GET"]);
  });

  test("accepts an explicit methods list", () => {
    const manifest = parseManifest({
      name: "orders",
      routes: [{ path: "/orders/create", requiredRoles: ["orders:editor"], methods: ["POST"] }],
      nav: [],
    });
    expect(manifest?.routes[0].methods).toEqual(["POST"]);
  });

  test("accepts a route declaring both GET and POST", () => {
    const manifest = parseManifest({
      name: "orders",
      routes: [{ path: "/orders", requiredRoles: [], methods: ["GET", "POST"], component: "OrdersView" }],
      nav: [],
    });
    expect(manifest?.routes[0].methods).toEqual(["GET", "POST"]);
  });

  test("rejects a non-string-array methods field", () => {
    expect(
      parseManifest({ name: "orders", routes: [{ path: "/orders", requiredRoles: [], methods: "GET" }], nav: [] })
    ).toBeNull();
  });

  test("rejects an empty methods array", () => {
    expect(
      parseManifest({ name: "orders", routes: [{ path: "/orders", requiredRoles: [], methods: [] }], nav: [] })
    ).toBeNull();
  });

  test("rejects a method outside GET/POST", () => {
    expect(
      parseManifest({
        name: "orders",
        routes: [{ path: "/orders", requiredRoles: [], methods: ["DELETE"] }],
        nav: [],
      })
    ).toBeNull();
  });

  test("rejects a component on a route that doesn't declare GET", () => {
    expect(
      parseManifest({
        name: "orders",
        routes: [{ path: "/orders", requiredRoles: [], methods: ["POST"], component: "OrdersView" }],
        nav: [],
      })
    ).toBeNull();
  });

  test("accepts a POST-only route without a component (pure mutation endpoint)", () => {
    const manifest = parseManifest({
      name: "orders",
      routes: [{ path: "/orders/create", requiredRoles: ["orders:editor"], methods: ["POST"] }],
      nav: [],
    });
    expect(manifest?.routes[0]).toEqual({
      path: "/orders/create",
      requiredRoles: ["orders:editor"],
      methods: ["POST"],
    });
  });
});

describe("publishesContext / consumesContext fields", () => {
  test("accepts declared publish and consume keys", () => {
    const manifest = parseManifest({
      name: "profile",
      routes: [],
      nav: [],
      publishesContext: ["profile"],
      consumesContext: ["contactData"],
    });
    expect(manifest?.publishesContext).toEqual(["profile"]);
    expect(manifest?.consumesContext).toEqual(["contactData"]);
  });

  test("defaults both to an empty array when absent", () => {
    const manifest = parseManifest({ name: "orders", routes: [], nav: [] });
    expect(manifest?.publishesContext).toEqual([]);
    expect(manifest?.consumesContext).toEqual([]);
  });

  test("rejects a non-string-array publishesContext", () => {
    expect(parseManifest({ name: "orders", routes: [], nav: [], publishesContext: [1, 2] })).toBeNull();
  });

  test("rejects a non-string-array consumesContext", () => {
    expect(parseManifest({ name: "orders", routes: [], nav: [], consumesContext: "not-an-array" })).toBeNull();
  });
});
