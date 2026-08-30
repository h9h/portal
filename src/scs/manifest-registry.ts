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
  fetchTimeoutMs?: number;
};

export type ManifestRegistry = {
  getManifests(): ManifestEntry[];
  onUpdate(listener: () => void): () => void;
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
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 10_000;
  const urls = [...new Set(baseUrls.map((u) => u.replace(/\/+$/, "")))];
  const entries = new Map<string, ManifestEntry>();
  const listeners = new Set<() => void>();

  async function fetchOne(baseUrl: string): Promise<void> {
    const existing = entries.get(baseUrl);
    try {
      const response = await fetchFn(`${baseUrl}/.portal/manifest`, {
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
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
    await Promise.all(urls.map(fetchOne));
    for (const listener of listeners) listener();
  }

  await fetchAll();

  const timer = setInterval(() => {
    fetchAll();
  }, refreshIntervalMs);

  return {
    getManifests(): ManifestEntry[] {
      return urls.map((baseUrl) => entries.get(baseUrl)!);
    },
    onUpdate(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}
