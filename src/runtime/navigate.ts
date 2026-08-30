import { useCallback, useSyncExternalStore } from "react";

type Listener = () => void;
const listeners = new Set<Listener>();

export function usePortalNavigate(): (path: string) => void {
  return useCallback((path: string) => {
    history.pushState(null, "", path);
    for (const listener of [...listeners]) listener();
  }, []);
}

export function useCurrentPath(): string {
  return useSyncExternalStore(
    (onChange) => {
      const onPopState = () => onChange();
      window.addEventListener("popstate", onPopState);
      listeners.add(onChange);
      return () => {
        window.removeEventListener("popstate", onPopState);
        listeners.delete(onChange);
      };
    },
    () => window.location.pathname
  );
}
