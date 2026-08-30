import type { ManifestEntry } from "../scs/manifest-registry";

export type RouteIndexEntry = {
  scsName: string;
  baseUrl: string;
  requiredRoles: string[];
  component?: string;
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
  // path -> (baseUrl -> declared name). Keying the inner map on baseUrl (the
  // configured, trusted network endpoint) rather than the manifest's
  // self-declared name means collision detection can't be fooled by two
  // distinct SCSs that happen to declare the same name.
  const claimants = new Map<string, Map<string, string>>();

  for (const entry of entries) {
    if (!entry.manifest) continue;
    const scsName = entry.manifest.name;
    for (const route of entry.manifest.routes) {
      const existingClaimants = claimants.get(route.path);
      if (existingClaimants) {
        existingClaimants.set(entry.baseUrl, scsName);
      } else {
        claimants.set(route.path, new Map([[entry.baseUrl, scsName]]));
        routes.set(route.path, {
          scsName,
          baseUrl: entry.baseUrl,
          requiredRoles: [...route.requiredRoles],
          ...(route.component ? { component: route.component } : {}),
        });
      }
    }
  }

  const collisions: RouteCollision[] = [];
  for (const [path, byBaseUrl] of claimants) {
    if (byBaseUrl.size > 1) {
      collisions.push({ path, scsNames: [...new Set(byBaseUrl.values())].sort() });
      routes.delete(path);
    }
  }

  return { routes, collisions };
}

export type AccessResult =
  | { status: "allowed" }
  | { status: "not_found" }
  | { status: "forbidden"; requiredRoles: string[] };

/**
 * Decides whether an already-authenticated user may access a given route path.
 *
 * Preconditions the caller must uphold:
 * - `userRoles` must belong to an authenticated user. This function has no
 *   notion of "anonymous" — an empty array just means a user with no roles,
 *   which is sufficient for any route with an empty `requiredRoles`. Do not
 *   call this before authentication.
 * - `path` must already be normalized (exact match, no trailing slash
 *   handling, case-sensitive, no query string). Normalize the request path
 *   once, in one place, before calling this function.
 */
export function checkAccess(index: RouteIndex, path: string, userRoles: string[]): AccessResult {
  const route = index.routes.get(path);
  if (!route) return { status: "not_found" };
  if (route.requiredRoles.length === 0) return { status: "allowed" };
  const hasRequiredRole = route.requiredRoles.some((role) => userRoles.includes(role));
  if (hasRequiredRole) return { status: "allowed" };
  return { status: "forbidden", requiredRoles: route.requiredRoles };
}
