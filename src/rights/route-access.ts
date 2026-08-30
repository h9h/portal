import type { ManifestEntry } from "../scs/manifest-registry";

export type RouteIndexEntry = {
  scsName: string;
  requiredRoles: string[];
};

export type RouteCollision = {
  path: string;
  scsNames: string[];
};

export type RouteIndex = {
  routes: Map<string, RouteIndexEntry>;
  collisions: RouteCollision[];
};

export function buildRouteIndex(entries: ManifestEntry[]): RouteIndex {
  const routes = new Map<string, RouteIndexEntry>();
  const claimants = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (!entry.manifest) continue;
    const scsName = entry.manifest.name;
    for (const route of entry.manifest.routes) {
      const existingClaimants = claimants.get(route.path);
      if (existingClaimants) {
        existingClaimants.add(scsName);
      } else {
        claimants.set(route.path, new Set([scsName]));
        routes.set(route.path, { scsName, requiredRoles: route.requiredRoles });
      }
    }
  }

  const collisions: RouteCollision[] = [];
  for (const [path, scsNames] of claimants) {
    if (scsNames.size > 1) {
      collisions.push({ path, scsNames: [...scsNames].sort() });
      routes.delete(path);
    }
  }

  return { routes, collisions };
}
