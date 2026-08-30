import { useCallback } from "react";
import { getStoredTokens, clearTokens } from "./auth";

export function usePortalLogout(): () => Promise<void> {
  return useCallback(async () => {
    const stored = getStoredTokens();
    clearTokens();
    if (stored) {
      try {
        await fetch("/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: stored.refreshToken }),
        });
      } catch {
        // best-effort: the local session is already cleared either way
      }
    }
    window.location.assign("/");
  }, []);
}
