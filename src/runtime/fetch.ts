import { getStoredTokens, storeTokens, clearTokens } from "./auth";

export async function portalFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const stored = getStoredTokens();
  const response = await fetch(input, { ...init, headers: buildHeaders(init, stored?.accessToken) });
  if (response.status !== 401 || !stored) return response;

  const refreshed = await refreshTokens();
  if (!refreshed) return response;

  const newStored = getStoredTokens();
  return fetch(input, { ...init, headers: buildHeaders(init, newStored?.accessToken) });
}

function buildHeaders(init: RequestInit, accessToken: string | undefined): Headers {
  const headers = new Headers(init.headers);
  headers.set("X-Portal-Data", "1");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
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
