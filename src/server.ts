import type { Database } from "bun:sqlite";
import { createDatabase } from "./db";
import { findOrCreateUser } from "./auth/users";
import { createRefreshToken, revokeRefreshToken, verifyAndRotateRefreshToken } from "./auth/refresh-tokens";
import { signAccessToken } from "./auth/tokens";
import { createState, verifyState } from "./auth/state";
import { getProviders, type OAuthProviderConfig } from "./auth/providers";
import { buildAuthorizeUrl, exchangeCodeForToken, fetchUserProfile } from "./auth/oauth-client";
import { getAuthenticatedUserId } from "./auth/middleware";

export type ServerOptions = {
  port?: number;
  db?: Database;
  providers?: Record<string, OAuthProviderConfig>;
  accessTokenSecret?: string;
  stateSecret?: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createServer(opts: ServerOptions = {}) {
  const db = opts.db ?? createDatabase(process.env.DATABASE_PATH ?? "portal.sqlite");
  const providers = opts.providers ?? getProviders();
  const accessTokenSecret = opts.accessTokenSecret ?? process.env.ACCESS_TOKEN_SECRET ?? "dev-secret-change-me";
  const stateSecret = opts.stateSecret ?? process.env.STATE_SECRET ?? "dev-state-secret-change-me";

  return Bun.serve({
    port: opts.port ?? 3000,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return json({ status: "ok" });
      }

      const loginMatch = url.pathname.match(/^\/auth\/login\/([^/]+)$/);
      if (loginMatch && req.method === "GET") {
        const provider = providers[loginMatch[1]];
        if (!provider) return json({ error: "unknown provider" }, 404);
        const state = createState(stateSecret);
        const redirectUri = `${url.origin}/auth/callback/${loginMatch[1]}`;
        return Response.redirect(buildAuthorizeUrl(provider, state, redirectUri), 302);
      }

      const callbackMatch = url.pathname.match(/^\/auth\/callback\/([^/]+)$/);
      if (callbackMatch && req.method === "GET") {
        const providerName = callbackMatch[1];
        const provider = providers[providerName];
        if (!provider) return json({ error: "unknown provider" }, 404);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state || !verifyState(state, stateSecret)) {
          return json({ error: "invalid state or missing code" }, 400);
        }
        const redirectUri = `${url.origin}/auth/callback/${providerName}`;
        const providerAccessToken = await exchangeCodeForToken(provider, code, redirectUri);
        const profile = await fetchUserProfile(provider, providerAccessToken);
        const user = findOrCreateUser(db, providerName, profile);
        const accessToken = signAccessToken(user.id, accessTokenSecret);
        const refreshToken = createRefreshToken(db, user.id);
        return json({ accessToken, refreshToken, expiresIn: 900 });
      }

      if (url.pathname === "/auth/refresh" && req.method === "POST") {
        const body = (await req.json()) as { refreshToken?: string };
        if (!body.refreshToken) return json({ error: "missing refreshToken" }, 400);
        const result = verifyAndRotateRefreshToken(db, body.refreshToken);
        if (!result) return json({ error: "invalid or expired refresh token" }, 401);
        const accessToken = signAccessToken(result.userId, accessTokenSecret);
        return json({ accessToken, refreshToken: result.newToken, expiresIn: 900 });
      }

      if (url.pathname === "/auth/logout" && req.method === "POST") {
        const body = (await req.json()) as { refreshToken?: string };
        if (body.refreshToken) revokeRefreshToken(db, body.refreshToken);
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
        return json({ ...row, roles: [] });
      }

      return json({ error: "not found" }, 404);
    },
  });
}

if (import.meta.main) {
  const server = createServer({ port: Number(process.env.PORT ?? 3000) });
  console.log(`Portal listening on ${server.url}`);
}
