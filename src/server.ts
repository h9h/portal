import type { Database } from "bun:sqlite";
import { createDatabase } from "./db";
import { findOrCreateUser, findUserById, listUsers } from "./auth/users";
import { createRefreshToken, revokeRefreshToken, verifyAndRotateRefreshToken } from "./auth/refresh-tokens";
import { signAccessToken } from "./auth/tokens";
import { createState, verifyState } from "./auth/state";
import { getProviders, type OAuthProviderConfig } from "./auth/providers";
import { buildAuthorizeUrl, exchangeCodeForToken, fetchUserProfile } from "./auth/oauth-client";
import { getAuthenticatedUserId } from "./auth/middleware";
import { buildRouteIndex, checkAccess, type RouteIndex } from "./rights/route-access";
import { assignRole, getUserRoles, revokeRole } from "./rights/roles";
import { buildNav } from "./rights/nav";
import { signInternalToken } from "./auth/internal-tokens";
import { createManifestRegistry, parseScsBaseUrls, type ManifestRegistry } from "./scs/manifest-registry";

export type ServerOptions = {
  port?: number;
  db?: Database;
  providers?: Record<string, OAuthProviderConfig>;
  accessTokenSecret?: string;
  stateSecret?: string;
  internalTokenSecret?: string;
  baseUrl?: string;
  manifestRegistry?: ManifestRegistry;
  adminEmails?: string[];
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Looks up a provider by name without falling through to inherited
// Object.prototype members (e.g. "constructor", "__proto__", "toString").
function getProvider(providers: Record<string, OAuthProviderConfig>, name: string): OAuthProviderConfig | undefined {
  if (!Object.prototype.hasOwnProperty.call(providers, name)) return undefined;
  return providers[name];
}

export function parseAdminEmails(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// Resolves a signing secret from explicit opts, then env, then a dev default.
// Fails fast in production if neither opts nor env supplied a value, since
// booting with the hardcoded dev default would let anyone who reads this
// source forge valid tokens.
function resolveSecret(explicit: string | undefined, envVar: string, devDefault: string): string {
  const value = explicit ?? process.env[envVar];
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${envVar} must be set in production (refusing to boot with the dev default)`);
  }
  console.warn(`${envVar} is not set; using an insecure development default. Set ${envVar} before deploying.`);
  return devDefault;
}

export function createServer(opts: ServerOptions = {}) {
  const db = opts.db ?? createDatabase(process.env.DATABASE_PATH ?? "portal.sqlite");
  const providers = opts.providers ?? getProviders();
  const accessTokenSecret = resolveSecret(opts.accessTokenSecret, "ACCESS_TOKEN_SECRET", "dev-secret-change-me");
  const stateSecret = resolveSecret(opts.stateSecret, "STATE_SECRET", "dev-state-secret-change-me");
  const configuredBaseUrl = (opts.baseUrl ?? process.env.PORTAL_BASE_URL)?.replace(/\/+$/, "");
  const adminEmails = opts.adminEmails ?? parseAdminEmails(process.env.PORTAL_ADMIN_EMAILS);
  if (adminEmails.length === 0) {
    console.warn("No PORTAL_ADMIN_EMAILS configured; no user will be auto-granted portal:admin on login.");
  }
  const manifestRegistry = opts.manifestRegistry;
  // internalTokenSecret is only resolved (and only reads INTERNAL_TOKEN_SECRET
  // / warns / can throw in production) when a manifestRegistry is actually
  // configured, so a registry-less deployment behaves exactly as if this
  // task's code didn't exist.
  let internalTokenSecret: string | undefined;
  let routeIndex: RouteIndex = { routes: new Map(), collisions: [] };
  // Tracks the previously logged collision set (by content) so a persistent
  // misconfiguration is reported once, not on every refresh. Wrapped so a
  // logging bug here can never throw and abort the registry's onUpdate
  // notify loop for other listeners.
  let lastLoggedCollisions = "";
  function logCollisionsIfChanged(index: RouteIndex): void {
    try {
      if (index.collisions.length === 0) return;
      const serialized = JSON.stringify(index.collisions);
      if (serialized === lastLoggedCollisions) return;
      lastLoggedCollisions = serialized;
      console.error("route collisions detected (routes disabled until resolved):", index.collisions);
    } catch {
      // never allow a logging failure to propagate into the caller.
    }
  }
  // Returns the authenticated caller's userId if they hold portal:admin, or
  // a Response to return immediately (401 unauthenticated, 403 not an admin).
  function requireAdmin(req: Request): string | Response {
    const userId = getAuthenticatedUserId(req, accessTokenSecret);
    if (!userId) return json({ error: "unauthorized" }, 401);
    if (!getUserRoles(db, userId).includes("portal:admin")) return json({ error: "forbidden" }, 403);
    return userId;
  }
  if (manifestRegistry) {
    internalTokenSecret = resolveSecret(
      opts.internalTokenSecret,
      "INTERNAL_TOKEN_SECRET",
      "dev-internal-secret-change-me"
    );
    routeIndex = buildRouteIndex(manifestRegistry.getManifests());
    logCollisionsIfChanged(routeIndex);
    manifestRegistry.onUpdate(() => {
      routeIndex = buildRouteIndex(manifestRegistry.getManifests());
      logCollisionsIfChanged(routeIndex);
    });
  }

  return Bun.serve({
    port: opts.port ?? 3000,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return json({ status: "ok" });
      }

      const loginMatch = url.pathname.match(/^\/auth\/login\/([^/]+)$/);
      if (loginMatch && req.method === "GET") {
        const provider = getProvider(providers, loginMatch[1]);
        if (!provider) return json({ error: "unknown provider" }, 404);
        const state = createState(stateSecret);
        const redirectUri = `${configuredBaseUrl ?? url.origin}/auth/callback/${loginMatch[1]}`;
        return Response.redirect(buildAuthorizeUrl(provider, state, redirectUri), 302);
      }

      const callbackMatch = url.pathname.match(/^\/auth\/callback\/([^/]+)$/);
      if (callbackMatch && req.method === "GET") {
        const providerName = callbackMatch[1];
        const provider = getProvider(providers, providerName);
        if (!provider) return json({ error: "unknown provider" }, 404);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state || !verifyState(state, stateSecret)) {
          return json({ error: "invalid state or missing code" }, 400);
        }
        const redirectUri = `${configuredBaseUrl ?? url.origin}/auth/callback/${providerName}`;
        try {
          const providerAccessToken = await exchangeCodeForToken(provider, code, redirectUri);
          const profile = await fetchUserProfile(provider, providerAccessToken);
          const user = findOrCreateUser(db, providerName, profile);
          if (user.email && adminEmails.includes(user.email)) {
            assignRole(db, user.id, "portal:admin");
          }
          const accessToken = signAccessToken(user.id, accessTokenSecret);
          const refreshToken = createRefreshToken(db, user.id);
          return json({ accessToken, refreshToken, expiresIn: 900 });
        } catch (err) {
          console.error("oauth callback failed", err);
          return json({ error: "oauth exchange failed" }, 502);
        }
      }

      if (url.pathname === "/auth/refresh" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const refreshToken = body && typeof body === "object" ? (body as { refreshToken?: unknown }).refreshToken : undefined;
        if (typeof refreshToken !== "string" || !refreshToken) return json({ error: "missing refreshToken" }, 400);
        const result = verifyAndRotateRefreshToken(db, refreshToken);
        if (!result) return json({ error: "invalid or expired refresh token" }, 401);
        const accessToken = signAccessToken(result.userId, accessTokenSecret);
        return json({ accessToken, refreshToken: result.newToken, expiresIn: 900 });
      }

      if (url.pathname === "/auth/logout" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const refreshToken = body && typeof body === "object" ? (body as { refreshToken?: unknown }).refreshToken : undefined;
        if (typeof refreshToken === "string" && refreshToken) revokeRefreshToken(db, refreshToken);
        return json({ status: "ok" });
      }

      if (url.pathname === "/me" && req.method === "GET") {
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        if (!userId) return json({ error: "unauthorized" }, 401);
        const row = db
          .query(
            `SELECT id, provider, provider_user_id as providerUserId, email, display_name as displayName
             FROM users WHERE id = ?`
          )
          .get(userId) as
          | { id: string; provider: string; providerUserId: string; email: string | null; displayName: string | null }
          | null;
        if (!row) return json({ error: "unauthorized" }, 401);
        return json({ ...row, roles: getUserRoles(db, userId) });
      }

      if (url.pathname === "/nav" && req.method === "GET") {
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        if (!userId) return json({ error: "unauthorized" }, 401);
        const userRoles = getUserRoles(db, userId);
        // Unlike routeIndex (cached, refreshed via onUpdate), /nav reads the
        // manifest registry live on every request — buildNav is cheap enough
        // not to need caching. This means /nav can briefly disagree with
        // route enforcement during a manifest refresh window (self-healing
        // once the refresh completes); acceptable since nav is display-only.
        const nav = manifestRegistry ? buildNav(manifestRegistry.getManifests(), userRoles) : [];
        return json({ nav });
      }

      if (url.pathname === "/admin/users" && req.method === "GET") {
        const adminCheck = requireAdmin(req);
        if (adminCheck instanceof Response) return adminCheck;
        const users = listUsers(db).map((user) => ({ ...user, roles: getUserRoles(db, user.id) }));
        return json({ users });
      }

      const assignRoleMatch = url.pathname.match(/^\/admin\/users\/([^/]+)\/roles$/);
      if (assignRoleMatch && req.method === "POST") {
        const adminCheck = requireAdmin(req);
        if (adminCheck instanceof Response) return adminCheck;
        const targetUserId = assignRoleMatch[1];
        if (!findUserById(db, targetUserId)) return json({ error: "user not found" }, 404);
        const body = await req.json().catch(() => null);
        const rawRole = body && typeof body === "object" ? (body as { role?: unknown }).role : undefined;
        const role = typeof rawRole === "string" ? rawRole.trim() : undefined;
        if (!role) return json({ error: "missing role" }, 400);
        assignRole(db, targetUserId, role);
        return json({ userId: targetUserId, roles: getUserRoles(db, targetUserId) });
      }

      const revokeRoleMatch = url.pathname.match(/^\/admin\/users\/([^/]+)\/roles\/revoke$/);
      if (revokeRoleMatch && req.method === "POST") {
        const adminCheck = requireAdmin(req);
        if (adminCheck instanceof Response) return adminCheck;
        const targetUserId = revokeRoleMatch[1];
        if (!findUserById(db, targetUserId)) return json({ error: "user not found" }, 404);
        const body = await req.json().catch(() => null);
        const rawRole = body && typeof body === "object" ? (body as { role?: unknown }).role : undefined;
        const role = typeof rawRole === "string" ? rawRole.trim() : undefined;
        if (!role) return json({ error: "missing role" }, 400);
        revokeRole(db, targetUserId, role);
        return json({ userId: targetUserId, roles: getUserRoles(db, targetUserId) });
      }

      if (manifestRegistry && req.method === "GET") {
        // Bind the current value of routeIndex to a local const so both reads
        // below are guaranteed to see the same snapshot, regardless of any
        // future edit that adds an `await` between them.
        const index = routeIndex;
        const normalizedPath = url.pathname === "/" ? url.pathname : url.pathname.replace(/\/+$/, "");
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        if (!userId) return json({ error: "unauthorized" }, 401);

        const userRoles = getUserRoles(db, userId);
        const result = checkAccess(index, normalizedPath, userRoles);

        if (result.status === "forbidden") {
          console.warn(
            `forbidden: user ${userId} missing one of [${result.requiredRoles.join(", ")}] for ${normalizedPath}`
          );
          return json({ error: "forbidden" }, 403);
        }

        if (result.status === "allowed") {
          const route = index.routes.get(normalizedPath)!;
          const scsRoles = userRoles.filter(
            (role) => role.startsWith(`${route.scsName}:`) && !role.startsWith("portal:")
          );
          // internalTokenSecret is always resolved above when manifestRegistry is set,
          // which is the only way to reach this branch.
          const internalToken = signInternalToken(userId, scsRoles, route.baseUrl, internalTokenSecret!);
          try {
            const fragmentResponse = await fetch(`${route.baseUrl}${normalizedPath}${url.search}`, {
              headers: { Authorization: `Bearer ${internalToken}` },
              redirect: "manual",
              signal: AbortSignal.timeout(10_000),
            });
            if (fragmentResponse.status >= 300 && fragmentResponse.status < 400) {
              console.error(`scs fragment fetch for ${normalizedPath} returned an unexpected redirect`);
              return json({ error: "scs fetch failed" }, 502);
            }
            const body = await fragmentResponse.arrayBuffer();
            return new Response(body, {
              status: fragmentResponse.status,
              headers: {
                "Content-Type": fragmentResponse.headers.get("Content-Type") ?? "application/octet-stream",
              },
            });
          } catch (err) {
            console.error("scs fragment fetch failed", err);
            return json({ error: "scs fetch failed" }, 502);
          }
        }

        // result.status === "not_found": fall through to the 404 below.
      }

      return json({ error: "not found" }, 404);
    },
  });
}

if (import.meta.main) {
  const scsBaseUrls = parseScsBaseUrls(process.env.PORTAL_SCS_URLS);
  const manifestRegistry = scsBaseUrls.length > 0 ? await createManifestRegistry(scsBaseUrls) : undefined;
  const server = createServer({ port: Number(process.env.PORT ?? 3000), manifestRegistry });
  console.log(`Portal listening on ${server.url}`);
}
