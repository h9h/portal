import type { Database } from "bun:sqlite";
import { createDatabase } from "./db";
import { findOrCreateUser, findUserById, listUsers } from "./auth/users";
import { createRefreshToken, revokeRefreshToken, verifyAndRotateRefreshToken } from "./auth/refresh-tokens";
import { signAccessToken } from "./auth/tokens";
import { createState, verifyState, createStateCookie, readStateCookie, stateNonce } from "./auth/state";
import { getProviders, type OAuthProviderConfig } from "./auth/providers";
import { buildAuthorizeUrl, exchangeCodeForToken, fetchUserProfile } from "./auth/oauth-client";
import { getAuthenticatedUserId } from "./auth/middleware";
import { buildRouteIndex, checkAccess, type RouteIndex } from "./rights/route-access";
import { assignRole, getUserRoles, revokeRole } from "./rights/roles";
import { buildNav } from "./rights/nav";
import { buildContextIndex, type ContextIndex } from "./rights/context-index";
import { detectNameCollisions, type NameCollision } from "./rights/name-index";
import { buildRouteTable, buildContextOwners } from "./shell/route-table";
import { signInternalToken } from "./auth/internal-tokens";
import { createManifestRegistry, parseScsBaseUrls, type ManifestRegistry } from "./scs/manifest-registry";
import { renderShellHtml } from "./shell/bootstrap-html";
import { getShellAssets } from "./shell/bundle";

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
  const stateCookieSecure = process.env.NODE_ENV === "production";
  if (!stateCookieSecure) {
    console.warn(
      'OAuth state cookie is not marked Secure (NODE_ENV is not "production") — fine for local HTTP ' +
        "development, but a real deployment must run behind HTTPS."
    );
  }
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
  let contextIndex: ContextIndex = { owners: new Map(), collisions: [] };
  let nameCollisions: NameCollision[] = [];
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
  // Same shape as logCollisionsIfChanged, with its own lastLogged state so
  // route and context collision logging don't clobber each other.
  let lastLoggedContextCollisions = "";
  function logContextCollisionsIfChanged(index: ContextIndex): void {
    try {
      if (index.collisions.length === 0) return;
      const serialized = JSON.stringify(index.collisions);
      if (serialized === lastLoggedContextCollisions) return;
      lastLoggedContextCollisions = serialized;
      console.error("shared-context key collisions detected (keys disabled until resolved):", index.collisions);
    } catch {
      // never allow a logging failure to propagate into the caller.
    }
  }
  // Same shape as logCollisionsIfChanged/logContextCollisionsIfChanged, with
  // its own lastLogged state so name collision logging doesn't clobber the
  // other two.
  let lastLoggedNameCollisions = "";
  function logNameCollisionsIfChanged(collisions: NameCollision[]): void {
    try {
      if (collisions.length === 0) return;
      const serialized = JSON.stringify(collisions);
      if (serialized === lastLoggedNameCollisions) return;
      lastLoggedNameCollisions = serialized;
      console.error(
        "manifest name collisions detected (bundle resolution and context ownership disabled for these names until resolved):",
        collisions
      );
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
    contextIndex = buildContextIndex(manifestRegistry.getManifests());
    nameCollisions = detectNameCollisions(manifestRegistry.getManifests());
    logCollisionsIfChanged(routeIndex);
    logContextCollisionsIfChanged(contextIndex);
    logNameCollisionsIfChanged(nameCollisions);
    manifestRegistry.onUpdate(() => {
      routeIndex = buildRouteIndex(manifestRegistry.getManifests());
      contextIndex = buildContextIndex(manifestRegistry.getManifests());
      nameCollisions = detectNameCollisions(manifestRegistry.getManifests());
      logCollisionsIfChanged(routeIndex);
      logContextCollisionsIfChanged(contextIndex);
      logNameCollisionsIfChanged(nameCollisions);
    });
  }

  return Bun.serve({
    port: opts.port ?? 3000,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return json({ status: "ok" });
      }

      if (url.pathname === "/auth/providers" && req.method === "GET") {
        return json(Object.values(providers).map((provider) => ({ name: provider.name, label: provider.label })));
      }

      const loginMatch = url.pathname.match(/^\/auth\/login\/([^/]+)$/);
      if (loginMatch && req.method === "GET") {
        const provider = getProvider(providers, loginMatch[1]);
        if (!provider) return json({ error: "unknown provider" }, 404);
        const state = createState(stateSecret);
        const redirectUri = `${configuredBaseUrl ?? url.origin}/auth/callback/${loginMatch[1]}`;
        return new Response(null, {
          status: 302,
          headers: {
            Location: buildAuthorizeUrl(provider, state, redirectUri),
            "Set-Cookie": createStateCookie(stateNonce(state)!, stateCookieSecure),
          },
        });
      }

      const callbackMatch = url.pathname.match(/^\/auth\/callback\/([^/]+)$/);
      if (callbackMatch && req.method === "GET") {
        const providerName = callbackMatch[1];
        const provider = getProvider(providers, providerName);
        if (!provider) return json({ error: "unknown provider" }, 404);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const shellOrigin = configuredBaseUrl ?? url.origin;
        // The provider sends its own `error` param (e.g. access_denied) when
        // the user cancels on its consent screen — a normal user action, not
        // a malformed/forged request. Hand it to the shell's existing
        // #error= screen instead of returning raw JSON. Checked before the
        // code/state check below, which stays reserved for genuinely
        // malformed or forged callback requests.
        if (url.searchParams.get("error")) {
          return Response.redirect(`${shellOrigin}/#error=oauth_failed`, 302);
        }
        if (!code || !state || !verifyState(state, stateSecret)) {
          return json({ error: "invalid state or missing code" }, 400);
        }
        const nonce = stateNonce(state);
        const cookieNonce = readStateCookie(req);
        if (!nonce || !cookieNonce || cookieNonce !== nonce) {
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
          // A real browser navigation lands here — under the page/data-fetch
          // split, a bare navigation only ever gets served the shell HTML, so
          // a JSON body would just be shown as raw text with nothing able to
          // read it. Hand the tokens off via the URL fragment instead: never
          // sent to the server on the request that follows, so it doesn't
          // appear in logs or get forwarded via Referer. The shell reads and
          // clears this on boot (see shell-entry.tsx, Task 6).
          const fragment = new URLSearchParams({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: "900",
          });
          return Response.redirect(`${shellOrigin}/#${fragment}`, 302);
        } catch (err) {
          console.error("oauth callback failed", err);
          return Response.redirect(`${shellOrigin}/#error=oauth_failed`, 302);
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

      if (url.pathname === "/routes" && req.method === "GET") {
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        if (!userId) return json({ error: "unauthorized" }, 401);
        const collidingNames = new Set(nameCollisions.map((c) => c.name));
        const contextOwners = Object.fromEntries(
          Object.entries(buildContextOwners(contextIndex)).filter(([, ownerName]) => !collidingNames.has(ownerName))
        );
        return json({ routes: buildRouteTable(routeIndex), contextOwners });
      }

      const bundleMatch = url.pathname.match(/^\/_scs\/([^/]+)\/bundle\.js$/);
      if (bundleMatch && req.method === "GET") {
        const userId = getAuthenticatedUserId(req, accessTokenSecret);
        if (!userId) return json({ error: "unauthorized" }, 401);
        const requestedScsName = bundleMatch[1];
        // Resolved by the manifest's self-declared name, same trust posture
        // already accepted elsewhere in this codebase for that field (see
        // specification.md's role-namespace-filtering open question) — first
        // match wins, bounded by the existing operator-trusted, static
        // base-URL list. A name currently claimed by more than one distinct
        // base URL (see detectNameCollisions) is excluded entirely rather
        // than resolved non-deterministically: two same-named SCSs would
        // otherwise race on which one's bundle gets served here.
        const collidingNames = new Set(nameCollisions.map((c) => c.name));
        const scsEntry = collidingNames.has(requestedScsName)
          ? undefined
          : (manifestRegistry?.getManifests() ?? []).find(
              (entry) => entry.manifest?.name === requestedScsName && entry.manifest.bundle
            );
        if (!scsEntry || !scsEntry.manifest?.bundle) return json({ error: "not found" }, 404);
        try {
          const bundleResponse = await fetch(`${scsEntry.baseUrl}${scsEntry.manifest.bundle}`, {
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
          });
          if (bundleResponse.status >= 300 && bundleResponse.status < 400) {
            console.error(`bundle fetch for ${requestedScsName} returned an unexpected redirect`);
            return json({ error: "scs fetch failed" }, 502);
          }
          if (!bundleResponse.ok) {
            console.error(`bundle fetch for ${requestedScsName} failed with status ${bundleResponse.status}`);
            return json({ error: "scs fetch failed" }, 502);
          }
          const body = await bundleResponse.arrayBuffer();
          return new Response(body, {
            status: 200,
            // Hardcoded, never the SCS's own declared Content-Type: this is
            // a fixed, directly-navigable Portal-origin URL gated only on
            // authentication (no role check), so an SCS serving its bundle
            // path with e.g. Content-Type: text/html could otherwise have
            // that HTML rendered same-origin under Portal's domain.
            headers: {
              "Content-Type": "text/javascript; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch (err) {
          console.error("bundle fetch failed", err);
          return json({ error: "scs fetch failed" }, 502);
        }
      }

      const shellAssetMatch = url.pathname.match(/^\/_shell\/(react|react-dom|jsx-runtime|runtime|shell)\.js$/);
      if (shellAssetMatch && req.method === "GET") {
        try {
          const assets = await getShellAssets();
          const byName: Record<string, string> = {
            react: assets.reactJs,
            "react-dom": assets.reactDomJs,
            "jsx-runtime": assets.jsxRuntimeJs,
            runtime: assets.runtimeJs,
            shell: assets.shellJs,
          };
          const body = byName[shellAssetMatch[1]];
          // getShellAssets() is memoized for the life of the process (its
          // output never changes without a redeploy), but there's no
          // versioned/hashed URL scheme yet — ETag + no-cache forces
          // revalidation on every request instead of either re-sending
          // ~500KB of react-dom on every navigation or blind long-term
          // caching that can't be busted. A matching If-None-Match short-
          // circuits to a bodyless 304, which is the only part that
          // actually saves the re-download; the header alone does not.
          const etag = `"${Bun.hash(body).toString(16)}"`;
          if (req.headers.get("If-None-Match") === etag) {
            return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache" } });
          }
          return new Response(body, {
            status: 200,
            headers: {
              "Content-Type": "text/javascript; charset=utf-8",
              ETag: etag,
              "Cache-Control": "no-cache",
            },
          });
        } catch (err) {
          console.error("shell asset build failed", err);
          return json({ error: "shell asset build failed" }, 502);
        }
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

      // Page navigation: any GET without the shell's data-marker header, that
      // didn't match one of Portal's own fixed routes above, always gets the
      // shell bootstrap HTML — any path, any auth state. See specification.md's
      // Request flow section for why this replaced the old "401 before the
      // route index is even consulted" behavior for page loads specifically.
      if (req.method === "GET" && req.headers.get("X-Portal-Data") !== "1") {
        return new Response(renderShellHtml(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
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
