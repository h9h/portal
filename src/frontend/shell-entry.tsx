import { Component, useEffect, useState, type ReactNode } from "react";
import { PortalRuntimeProvider, portalFetch, useCurrentPath } from "@portal/runtime";
import { resolveRoute, type RouteTableEntry } from "./router";

export type ComponentLoader = (bundleUrl: string) => Promise<Record<string, unknown>>;

const defaultLoader: ComponentLoader = (bundleUrl) => import(/* @vite-ignore */ bundleUrl);

type Me = { id: string; roles: string[] } | null;
type RoutesResponse = { routes: RouteTableEntry[]; contextOwners: Record<string, string> };
type Status = "loading" | "login" | "forbidden" | "not_found" | "ready";

class MountErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) return <div>This view failed to load.</div>;
    return this.props.children;
  }
}

export function App({ loadComponent = defaultLoader }: { loadComponent?: ComponentLoader }) {
  const path = useCurrentPath();
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [routesData, setRoutesData] = useState<RoutesResponse | null>(null);
  const [mounted, setMounted] = useState<{ Component: React.ComponentType; scsName: string } | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  // Boot once: identity + the full route table.
  useEffect(() => {
    (async () => {
      const meResponse = await portalFetch("/me");
      if (meResponse.status === 401) {
        setMe(null);
        setStatus("login");
        return;
      }
      const meJson = (await meResponse.json()) as NonNullable<Me>;
      setMe(meJson);
      const routesResponse = await portalFetch("/routes");
      setRoutesData((await routesResponse.json()) as RoutesResponse);
    })();
  }, []);

  // Resolve + mount whenever the path (via usePortalNavigate/popstate) or the
  // loaded route table changes.
  useEffect(() => {
    if (me === undefined || me === null || !routesData) return;
    let cancelled = false;
    (async () => {
      const resolution = resolveRoute(routesData.routes, path, me.roles);
      if (resolution.status === "not_found" || resolution.status === "no_component") {
        if (!cancelled) {
          setStatus("not_found");
          setMounted(null);
        }
        return;
      }
      if (resolution.status === "forbidden") {
        if (!cancelled) {
          setStatus("forbidden");
          setMounted(null);
        }
        return;
      }
      const module = await loadComponent(`/_scs/${resolution.entry.scsName}/bundle.js`);
      const ResolvedComponent = module[resolution.entry.component!] as React.ComponentType | undefined;
      if (cancelled) return;
      if (!ResolvedComponent) {
        setStatus("not_found");
        setMounted(null);
        return;
      }
      setMounted({ Component: ResolvedComponent, scsName: resolution.entry.scsName });
      setStatus("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [me, routesData, path, loadComponent]);

  if (status === "loading") return <div>Loading…</div>;
  if (status === "login") return <div>Please log in.</div>;
  if (status === "forbidden") return <div>You don't have access to this page.</div>;
  if (status === "not_found") return <div>Not found.</div>;

  const { Component: Mounted, scsName } = mounted!;
  return (
    <MountErrorBoundary>
      <PortalRuntimeProvider scsName={scsName} contextOwners={routesData!.contextOwners}>
        <Mounted />
      </PortalRuntimeProvider>
    </MountErrorBoundary>
  );
}
