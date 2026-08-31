import { getStoredTokens, storeTokens, clearTokens, getSessionEpoch } from "./auth";

// GET (or method-less, which defaults to GET) is the only method safe to
// silently retry on 401 — retrying a read has no side effects. A composed
// POST's 401 might be Portal's own "your token is stale" (never reached the
// SCS) or the SCS's own 401 forwarded verbatim (already reached and possibly
// processed by the SCS) — portalFetch can't tell these apart, and retrying
// the latter would resubmit an already-processed mutation. See
// specification.md, Token storage and refresh.
function isRetriableMethod(method: string | undefined): boolean {
  return !method || method.toUpperCase() === "GET";
}

export async function portalFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const stored = getStoredTokens();
  const response = await fetch(input, { ...init, headers: buildHeaders(input, init, stored?.accessToken) });
  if (response.status !== 401 || !stored || !isRetriableMethod(init.method)) return response;

  const refreshed = await refreshTokens();
  if (!refreshed) return response;

  const newStored = getStoredTokens();
  return fetch(input, { ...init, headers: buildHeaders(input, init, newStored?.accessToken) });
}

// Only attach the user's bearer token when the request target is same-origin
// as the current page. portalFetch accepts absolute URLs (a mounted SCS
// component could pass one), and without this guard the token would be sent
// to any origin the caller names — a leak, not something an attacker needs
// to engineer.
function isSameOrigin(input: string): boolean {
  try {
    return new URL(input, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

function buildHeaders(input: string, init: RequestInit, accessToken: string | undefined): Headers {
  const headers = new Headers(init.headers);
  headers.set("X-Portal-Data", "1");
  if (accessToken && isSameOrigin(input)) headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

// Deduped across concurrent callers: refresh tokens rotate on use (see
// specification.md), so two simultaneous refresh attempts would race and
// the loser would fail with an already-invalidated token.
let refreshInFlight: Promise<boolean> | null = null;

function refreshTokens(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const stored = getStoredTokens();
      if (!stored) return false;
      const epochAtStart = getSessionEpoch();
      try {
        const response = await fetch("/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: stored.refreshToken }),
        });
        if (!response.ok) {
          clearTokens();
          return false;
        }
        const body = (await response.json()) as { accessToken: string; refreshToken: string };
        // A logout (clearTokens()) ran while this refresh was in flight —
        // don't resurrect a session the user just cleared by writing the
        // rotated tokens back. The caller just sees the original 401, which
        // is the right outcome here.
        if (getSessionEpoch() !== epochAtStart) return false;
        storeTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken });
        return true;
      } catch {
        clearTokens();
        return false;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}
