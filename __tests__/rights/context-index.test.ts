import { describe, test, expect } from "bun:test";
import { buildContextIndex } from "../../src/rights/context-index";
import type { ManifestEntry } from "../../src/scs/manifest-registry";

function entry(name: string, publishesContext: string[], baseUrl?: string): ManifestEntry {
  return {
    baseUrl: baseUrl ?? `http://${name}.local`,
    manifest: { name, routes: [], nav: [], publishesContext, consumesContext: [] },
    stale: false,
    lastFetchedAt: Date.now(),
  };
}

function unreachableEntry(baseUrl: string): ManifestEntry {
  return { baseUrl, manifest: null, stale: true, lastFetchedAt: null };
}

describe("buildContextIndex", () => {
  test("indexes a single SCS's declared keys", () => {
    const index = buildContextIndex([entry("profile", ["profile"])]);
    expect(index.owners.get("profile")).toBe("profile");
    expect(index.collisions).toEqual([]);
  });

  test("indexes keys from multiple SCSs with no overlap", () => {
    const index = buildContextIndex([entry("profile", ["profile"]), entry("contactData", ["contactData"])]);
    expect(index.owners.get("profile")).toBe("profile");
    expect(index.owners.get("contactData")).toBe("contactData");
    expect(index.collisions).toEqual([]);
  });

  test("excludes a colliding key from owners and reports the collision", () => {
    const index = buildContextIndex([
      entry("profile", ["shared"], "http://a.local"),
      entry("otherProfile", ["shared"], "http://b.local"),
    ]);
    expect(index.owners.has("shared")).toBe(false);
    expect(index.collisions).toEqual([{ key: "shared", scsNames: ["otherProfile", "profile"] }]);
  });

  test("does not treat duplicate keys within a single SCS's publishesContext as a collision", () => {
    const index = buildContextIndex([entry("profile", ["shared", "shared"])]);
    expect(index.owners.get("shared")).toBe("profile");
    expect(index.collisions).toEqual([]);
  });

  test("skips an SCS with no manifest (never successfully fetched)", () => {
    const index = buildContextIndex([unreachableEntry("http://broken.local")]);
    expect(index.owners.size).toBe(0);
    expect(index.collisions).toEqual([]);
  });

  test("includes a stale SCS's last-known-good context keys", () => {
    const staleWithManifest: ManifestEntry = {
      baseUrl: "http://profile.local",
      manifest: { name: "profile", routes: [], nav: [], publishesContext: ["profile"], consumesContext: [] },
      stale: true,
      lastFetchedAt: Date.now() - 3600000,
    };
    const index = buildContextIndex([staleWithManifest]);
    expect(index.owners.get("profile")).toBe("profile");
    expect(index.collisions).toEqual([]);
  });

  test("handles an SCS that publishes nothing", () => {
    const index = buildContextIndex([entry("orders", [])]);
    expect(index.owners.size).toBe(0);
    expect(index.collisions).toEqual([]);
  });

  test("returns an empty index for no entries", () => {
    const index = buildContextIndex([]);
    expect(index.owners.size).toBe(0);
    expect(index.collisions).toEqual([]);
  });

  test("two different base URLs colliding on a key even if they declare the same manifest name", () => {
    const index = buildContextIndex([
      entry("profile", ["shared"], "http://a.local"),
      entry("profile", ["shared"], "http://b.local"),
    ]);
    expect(index.owners.has("shared")).toBe(false);
    expect(index.collisions).toEqual([{ key: "shared", scsNames: ["profile"] }]);
  });
});
