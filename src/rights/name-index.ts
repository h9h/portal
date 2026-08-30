import type { ManifestEntry } from "../scs/manifest-registry";

export type NameCollision = {
  name: string;
  baseUrls: string[];
};

// Same shape as buildRouteIndex/buildContextIndex's collision detection:
// two distinct SCSs (distinct base URLs — the trusted, operator-configured
// endpoint) self-declaring the same manifest `name` is a collision, since
// `name` is what the client (identity.scsName, contextOwners) and the
// bundle proxy (/_scs/:scsName/bundle.js) both use to resolve "which SCS is
// this". Keyed on baseUrl so one SCS declaring its own name twice (e.g.
// across a stale-then-fresh refresh) never counts as a collision.
export function detectNameCollisions(entries: ManifestEntry[]): NameCollision[] {
  const baseUrlsByName = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (!entry.manifest) continue;
    const name = entry.manifest.name;
    const existing = baseUrlsByName.get(name);
    if (existing) {
      existing.add(entry.baseUrl);
    } else {
      baseUrlsByName.set(name, new Set([entry.baseUrl]));
    }
  }

  const collisions: NameCollision[] = [];
  for (const [name, baseUrls] of baseUrlsByName) {
    if (baseUrls.size > 1) {
      collisions.push({ name, baseUrls: [...baseUrls].sort() });
    }
  }
  return collisions;
}
