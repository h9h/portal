import { describe, test, expect } from "bun:test";
import { detectNameCollisions } from "../../src/rights/name-index";
import type { ManifestEntry } from "../../src/scs/manifest-registry";

function entry(name: string, baseUrl?: string): ManifestEntry {
  return {
    baseUrl: baseUrl ?? `http://${name}.local`,
    manifest: { name, routes: [], nav: [], publishesContext: [], consumesContext: [] },
    stale: false,
    lastFetchedAt: Date.now(),
  };
}

function unreachableEntry(baseUrl: string): ManifestEntry {
  return { baseUrl, manifest: null, stale: true, lastFetchedAt: null };
}

describe("detectNameCollisions", () => {
  test("reports no collisions for distinct names", () => {
    expect(detectNameCollisions([entry("orders"), entry("billing")])).toEqual([]);
  });

  test("reports a collision when two distinct base URLs declare the same name", () => {
    const collisions = detectNameCollisions([
      entry("profile", "http://a.local"),
      entry("profile", "http://b.local"),
    ]);
    expect(collisions).toEqual([{ name: "profile", baseUrls: ["http://a.local", "http://b.local"] }]);
  });

  test("does not treat the same base URL appearing twice as a collision", () => {
    const collisions = detectNameCollisions([entry("profile", "http://a.local"), entry("profile", "http://a.local")]);
    expect(collisions).toEqual([]);
  });

  test("skips an SCS with no manifest (never successfully fetched)", () => {
    expect(detectNameCollisions([unreachableEntry("http://broken.local")])).toEqual([]);
  });

  test("returns an empty array for no entries", () => {
    expect(detectNameCollisions([])).toEqual([]);
  });
});
