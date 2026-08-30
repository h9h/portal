import { createContext, createElement, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import { createContextStore } from "./store";

// One module-level store: since `@portal/runtime` is loaded once (as a
// single browser module, shared via the import map — see Client shell in
// specification.md), every mounted component from every SCS reads/writes
// this same singleton, regardless of which SCS's bundle it came from.
const store = createContextStore();

export type PortalIdentity = {
  scsName: string;
  contextOwners: Record<string, string>;
};

const IdentityContext = createContext<PortalIdentity | null>(null);

export function PortalRuntimeProvider(props: PortalIdentity & { children: ReactNode }) {
  const { children, ...identity } = props;
  return createElement(IdentityContext.Provider, { value: identity }, children);
}

export function usePublishedContext(key: string): unknown {
  return useSyncExternalStore(
    useCallback((onChange) => store.subscribe(key, onChange), [key]),
    () => store.get(key)
  );
}

export function usePublishContext(key: string): (value: unknown) => void {
  const identity = useContext(IdentityContext);
  return useCallback(
    (value: unknown) => {
      if (!identity) {
        console.warn(`usePublishContext("${key}") called outside a PortalRuntimeProvider; ignored.`);
        return;
      }
      if (identity.contextOwners[key] !== identity.scsName) {
        console.warn(
          `usePublishContext("${key}") ignored: not owned by "${identity.scsName}" ` +
            `(owner: ${identity.contextOwners[key] ?? "none — undeclared or collision-voided"}).`
        );
        return;
      }
      store.set(key, value);
    },
    [identity, key]
  );
}
