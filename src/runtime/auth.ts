const STORAGE_KEY = "portal:session";

export type StoredSession = {
  accessToken: string;
  refreshToken: string;
};

// sessionStorage can throw (private/incognito browsing in some browsers,
// storage quota) — reads/writes here must never crash the app; worst case,
// the user is treated as logged out.

export function getStoredTokens(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") return null;
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
  } catch {
    return null;
  }
}

export function storeTokens(session: StoredSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // see comment above — a failed store just means the user stays logged out
  }
}

export function clearTokens(): void {
  sessionEpoch += 1;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // see comment above
  }
}

// Bumped by clearTokens() so an in-flight refresh (see refreshTokens() in
// fetch.ts) can detect a logout that happened underneath it and skip writing
// stale tokens back. auth.ts is compiled into two separate browser bundles
// (runtime.js, via fetch.ts/logout.ts; and shell.js, via shell-entry.tsx's
// own relative import), but this only needs clearTokens() and
// refreshTokens()'s epoch check to share one compiled copy — and both are
// reached via runtime.js's own import graph, so they do.
let sessionEpoch = 0;

export function getSessionEpoch(): number {
  return sessionEpoch;
}
