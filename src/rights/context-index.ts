import type { ManifestEntry } from "../scs/manifest-registry";

export type ContextCollision = {
  key: string;
  scsNames: string[];
};

export type ContextIndex = {
  owners: Map<string, string>;
  collisions: ContextCollision[];
};

export function buildContextIndex(entries: ManifestEntry[]): ContextIndex {
  const owners = new Map<string, string>();
  // key -> (baseUrl -> declared name), same reasoning as buildRouteIndex's
  // claimants map: keyed on the trusted base URL, not the self-declared name.
  const claimants = new Map<string, Map<string, string>>();

  for (const entry of entries) {
    if (!entry.manifest) continue;
    const scsName = entry.manifest.name;
    for (const key of entry.manifest.publishesContext) {
      const existingClaimants = claimants.get(key);
      if (existingClaimants) {
        existingClaimants.set(entry.baseUrl, scsName);
      } else {
        claimants.set(key, new Map([[entry.baseUrl, scsName]]));
        owners.set(key, scsName);
      }
    }
  }

  const collisions: ContextCollision[] = [];
  for (const [key, byBaseUrl] of claimants) {
    if (byBaseUrl.size > 1) {
      collisions.push({ key, scsNames: [...new Set(byBaseUrl.values())].sort() });
      owners.delete(key);
    }
  }

  return { owners, collisions };
}
