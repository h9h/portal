import { parseManifest, type SCSManifest } from "./manifest";

export type ManifestEntry = {
  baseUrl: string;
  manifest: SCSManifest | null;
  stale: boolean;
  lastFetchedAt: number | null;
};

export type ManifestRegistryOptions = {
  refreshIntervalMs?: number;
  fetchFn?: typeof fetch;
};

export type ManifestRegistry = {
  getManifests(): ManifestEntry[];
  stop(): void;
};

export function parseScsBaseUrls(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export async function createManifestRegistry(
  baseUrls: string[],
  opts: ManifestRegistryOptions = {}
): Promise<ManifestRegistry> {
  const fetchFn = opts.fetchFn ?? fetch;
  const refreshIntervalMs = opts.refreshIntervalMs ?? 60_000;
  const entries = new Map<string, ManifestEntry>();

  async function fetchOne(baseUrl: string): Promise<void> {
    const existing = entries.get(baseUrl);
    try {
      const response = await fetchFn(`${baseUrl}/.portal/manifest`);
      if (!response.ok) throw new Error(`manifest fetch failed with status ${response.status}`);
      const json = await response.json();
      const manifest = parseManifest(json);
      if (!manifest) throw new Error("malformed manifest");
      entries.set(baseUrl, { baseUrl, manifest, stale: false, lastFetchedAt: Date.now() });
    } catch (err) {
      console.error(`manifest fetch failed for ${baseUrl}`, err);
      entries.set(baseUrl, {
        baseUrl,
        manifest: existing?.manifest ?? null,
        stale: true,
        lastFetchedAt: existing?.lastFetchedAt ?? null,
      });
    }
  }

  async function fetchAll(): Promise<void> {
    await Promise.all(baseUrls.map(fetchOne));
  }

  await fetchAll();

  const timer = setInterval(() => {
    fetchAll();
  }, refreshIntervalMs);

  return {
    getManifests(): ManifestEntry[] {
      return baseUrls.map((baseUrl) => entries.get(baseUrl)!);
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}
