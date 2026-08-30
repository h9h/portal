import { describe, test, expect, afterEach } from "bun:test";
import { createManifestRegistry, parseScsBaseUrls } from "../../src/scs/manifest-registry";

const validManifestJson = {
  name: "orders",
  routes: [{ path: "/orders", requiredRoles: ["orders:viewer"] }],
  nav: [{ label: "Orders", path: "/orders", requiredRoles: ["orders:viewer"] }],
};

let servers: ReturnType<typeof Bun.serve>[] = [];
let registries: Awaited<ReturnType<typeof createManifestRegistry>>[] = [];

afterEach(() => {
  for (const registry of registries) registry.stop();
  for (const server of servers) server.stop();
  registries = [];
  servers = [];
});

function startFakeScs(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return server;
}

function baseUrlOf(server: ReturnType<typeof Bun.serve>): string {
  return server.url.toString().replace(/\/$/, "");
}

describe("parseScsBaseUrls", () => {
  test("splits a comma-separated list and trims whitespace", () => {
    expect(parseScsBaseUrls("http://a.local, http://b.local ,http://c.local")).toEqual([
      "http://a.local",
      "http://b.local",
      "http://c.local",
    ]);
  });

  test("returns an empty array for undefined or empty input", () => {
    expect(parseScsBaseUrls(undefined)).toEqual([]);
    expect(parseScsBaseUrls("")).toEqual([]);
  });

  test("filters out empty entries from stray commas", () => {
    expect(parseScsBaseUrls("http://a.local,,http://b.local")).toEqual(["http://a.local", "http://b.local"]);
  });
});

describe("createManifestRegistry", () => {
  test("fetches a healthy SCS's manifest on startup", async () => {
    const scs = startFakeScs((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/.portal/manifest") {
        return new Response(JSON.stringify(validManifestJson), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const registry = await createManifestRegistry([baseUrlOf(scs)]);
    registries.push(registry);

    const [entry] = registry.getManifests();
    expect(entry.manifest).toEqual(validManifestJson);
    expect(entry.stale).toBe(false);
    expect(entry.lastFetchedAt).not.toBeNull();
  });

  test("marks an unreachable SCS as stale with no manifest", async () => {
    const registry = await createManifestRegistry(["http://localhost:1"], {
      fetchFn: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
    });
    registries.push(registry);

    const [entry] = registry.getManifests();
    expect(entry.manifest).toBeNull();
    expect(entry.stale).toBe(true);
  });

  test("marks an SCS returning a malformed manifest as stale with no manifest", async () => {
    const scs = startFakeScs(() => new Response(JSON.stringify({ not: "a manifest" }), { status: 200 }));

    const registry = await createManifestRegistry([baseUrlOf(scs)]);
    registries.push(registry);

    const [entry] = registry.getManifests();
    expect(entry.manifest).toBeNull();
    expect(entry.stale).toBe(true);
  });

  test("keeps the last-known-good manifest and marks it stale when a later refresh fails", async () => {
    let shouldFail = false;
    const scs = startFakeScs(() => {
      if (shouldFail) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(validManifestJson), { status: 200 });
    });

    const registry = await createManifestRegistry([baseUrlOf(scs)], { refreshIntervalMs: 20 });
    registries.push(registry);

    expect(registry.getManifests()[0].manifest).toEqual(validManifestJson);

    shouldFail = true;
    await new Promise((resolve) => setTimeout(resolve, 60));

    const entry = registry.getManifests()[0];
    expect(entry.manifest).toEqual(validManifestJson);
    expect(entry.stale).toBe(true);
  });

  test("recovers from stale once the SCS responds again", async () => {
    let shouldFail = true;
    const scs = startFakeScs(() => {
      if (shouldFail) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(validManifestJson), { status: 200 });
    });

    const registry = await createManifestRegistry([baseUrlOf(scs)], { refreshIntervalMs: 20 });
    registries.push(registry);

    expect(registry.getManifests()[0].stale).toBe(true);

    shouldFail = false;
    await new Promise((resolve) => setTimeout(resolve, 60));

    const entry = registry.getManifests()[0];
    expect(entry.manifest).toEqual(validManifestJson);
    expect(entry.stale).toBe(false);
  });

  test("tracks multiple SCSs independently", async () => {
    const healthy = startFakeScs(() => new Response(JSON.stringify(validManifestJson), { status: 200 }));
    const broken = startFakeScs(() => new Response("boom", { status: 500 }));

    const registry = await createManifestRegistry([baseUrlOf(healthy), baseUrlOf(broken)]);
    registries.push(registry);

    const [healthyEntry, brokenEntry] = registry.getManifests();
    expect(healthyEntry.manifest).toEqual(validManifestJson);
    expect(healthyEntry.stale).toBe(false);
    expect(brokenEntry.manifest).toBeNull();
    expect(brokenEntry.stale).toBe(true);
  });

  test("strips a trailing slash from a configured base URL before fetching", async () => {
    const scs = startFakeScs((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/.portal/manifest") {
        return new Response(JSON.stringify(validManifestJson), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const registry = await createManifestRegistry([`${baseUrlOf(scs)}/`]);
    registries.push(registry);

    const [entry] = registry.getManifests();
    expect(entry.manifest).toEqual(validManifestJson);
    expect(entry.stale).toBe(false);
  });

  test("deduplicates base URLs that differ only by a trailing slash", async () => {
    const scs = startFakeScs(() => new Response(JSON.stringify(validManifestJson), { status: 200 }));

    const registry = await createManifestRegistry([baseUrlOf(scs), `${baseUrlOf(scs)}/`]);
    registries.push(registry);

    expect(registry.getManifests()).toHaveLength(1);
  });

  test("aborts a hanging fetch after fetchTimeoutMs and marks the SCS stale", async () => {
    const scs = startFakeScs(async () => {
      await new Promise(() => {});
      return new Response("unreachable", { status: 200 });
    });

    const start = Date.now();
    const registry = await createManifestRegistry([baseUrlOf(scs)], { fetchTimeoutMs: 50 });
    registries.push(registry);
    const elapsed = Date.now() - start;

    const [entry] = registry.getManifests();
    expect(entry.manifest).toBeNull();
    expect(entry.stale).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(1000);
  });

  test("stop() prevents further scheduled refreshes", async () => {
    let fetchCount = 0;
    const scs = startFakeScs(() => {
      fetchCount++;
      return new Response(JSON.stringify(validManifestJson), { status: 200 });
    });

    const registry = await createManifestRegistry([baseUrlOf(scs)], { refreshIntervalMs: 20 });
    registries.push(registry);

    const countAfterStartup = fetchCount;
    registry.stop();

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(fetchCount).toBe(countAfterStartup);
  });
});
