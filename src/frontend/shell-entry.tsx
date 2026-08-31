import { Component, useEffect, useState, type ReactNode } from "react";
import { PortalRuntimeProvider, portalFetch, useCurrentPath } from "@portal/runtime";
import { storeTokens } from "../runtime/auth";
import { resolveRoute, type RouteTableEntry } from "./router";
import { PortalFrame, type Me, type Provider, type NavItem } from "./portal-frame";

export type ComponentLoader = (bundleUrl: string) => Promise<Record<string, unknown>>;

// A browser's dynamic `import()` can't attach an `Authorization` header, and
// GET /_scs/:scsName/bundle.js requires one (see specification.md, Client
// shell). So this doesn't `import()` the network URL directly — it fetches
// the bundle via `portalFetch` (which does attach the header, and
// transparently refreshes-and-retries on a stale token) and mounts the
// resulting source from a same-origin `blob:` URL, which dynamic `import()`
// can load with no network request/headers of its own. The blob URL is
// revoked as soon as the import settles (success or failure) — it only ever
// needs to exist long enough for that one `import()` call.
export const defaultLoader: ComponentLoader = async (bundleUrl) => {
  const response = await portalFetch(bundleUrl);
  if (!response.ok) {
    throw new Error(`failed to load SCS bundle ${bundleUrl}: ${response.status}`);
  }
  const code = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    return await import(/* @vite-ignore */ blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
};

type RoutesResponse = { routes: RouteTableEntry[]; contextOwners: Record<string, string> };
type Status = "loading" | "login" | "forbidden" | "not_found" | "error" | "ready";

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
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [navItems, setNavItems] = useState<NavItem[]>([]);

  // Boot once: identity + the full route table. Any rejection here (network
  // failure, unparseable JSON) must still resolve to a terminal status —
  // otherwise `status` is stuck at "loading" forever, since nothing else
  // ever sets it and MountErrorBoundary can't catch a rejected promise
  // inside a useEffect (it only catches render/lifecycle errors).
  useEffect(() => {
    (async () => {
      try {
        // Auth hand-off: a successful/failed OAuth callback redirects here
        // with the token pair (or an error) in the URL fragment, since a
        // bare browser navigation can only ever be served the shell HTML —
        // there's no code running yet able to read a JSON response body.
        // Consume it once, then scrub it from the URL so it doesn't linger
        // in history or get re-read on a later reload.
        const hash = new URLSearchParams(window.location.hash.slice(1));
        if (hash.has("access_token") && hash.has("refresh_token")) {
          storeTokens({ accessToken: hash.get("access_token")!, refreshToken: hash.get("refresh_token")! });
        } else if (hash.has("error")) {
          setLoginError("Sign-in failed. Please try again.");
        }
        if (window.location.hash) {
          history.replaceState(null, "", window.location.pathname + window.location.search);
        }

        const meResponse = await portalFetch("/me");
        if (meResponse.status === 401) {
          setMe(null);
          const providersResponse = await portalFetch("/auth/providers");
          setProviders((await providersResponse.json()) as Provider[]);
          setStatus("login");
          return;
        }
        const meJson = (await meResponse.json()) as NonNullable<Me>;
        setMe(meJson);
        const routesResponse = await portalFetch("/routes");
        setRoutesData((await routesResponse.json()) as RoutesResponse);
      } catch (err) {
        console.error("shell boot failed", err);
        setStatus("error");
      }
    })();
  }, []);

  // Independent of the /me boot sequence above and never fatal: /nav is
  // display-only (see specification.md, Context model), and now allows
  // anonymous callers, so this can run regardless of auth state. A failure
  // here must never affect `status` — it just leaves the nav space empty.
  useEffect(() => {
    (async () => {
      try {
        const navResponse = await portalFetch("/nav");
        if (!navResponse.ok) return;
        const navJson = (await navResponse.json()) as { nav: NavItem[] };
        setNavItems(navJson.nav);
      } catch (err) {
        console.error("nav fetch failed", err);
      }
    })();
  }, []);

  // Resolve + mount whenever the path (via usePortalNavigate/popstate) or the
  // loaded route table changes.
  useEffect(() => {
    if (me === undefined || me === null || !routesData) return;
    // Reset to "loading" before resolving the new path, so a navigation
    // doesn't keep rendering the previous route's component (with the
    // previous scsName in PortalRuntimeProvider) while the new one loads.
    setStatus("loading");
    setMounted(null);
    let cancelled = false;
    (async () => {
      try {
        const resolution = resolveRoute(routesData.routes, path, me.roles);
        if (resolution.status === "not_found" || resolution.status === "no_component") {
          if (!cancelled) setStatus("not_found");
          return;
        }
        if (resolution.status === "forbidden") {
          if (!cancelled) setStatus("forbidden");
          return;
        }
        const module = await loadComponent(`/_scs/${resolution.entry.scsName}/bundle.js`);
        const ResolvedComponent = module[resolution.entry.component!] as React.ComponentType | undefined;
        if (cancelled) return;
        if (!ResolvedComponent) {
          setStatus("not_found");
          return;
        }
        setMounted({ Component: ResolvedComponent, scsName: resolution.entry.scsName });
        setStatus("ready");
      } catch (err) {
        if (!cancelled) {
          console.error("route resolve/mount failed", err);
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me, routesData, path, loadComponent]);

  function renderContent(): ReactNode {
    if (status === "loading") return <div>Loading…</div>;
    if (status === "login") {
      return (
        <div>
          {loginError && <p>{loginError}</p>}
          {providers.map((provider) => (
            <a key={provider.name} href={`/auth/login/${provider.name}`}>
              Sign in with {provider.label}
            </a>
          ))}
        </div>
      );
    }
    if (status === "forbidden") return <div>You don't have access to this page.</div>;
    if (status === "not_found") return <div>Not found.</div>;
    if (status === "error") return <div>Something went wrong loading this page.</div>;

    const { Component: Mounted, scsName } = mounted!;
    return (
      <MountErrorBoundary>
        <PortalRuntimeProvider scsName={scsName} contextOwners={routesData!.contextOwners}>
          <Mounted />
        </PortalRuntimeProvider>
      </MountErrorBoundary>
    );
  }

  return (
    <PortalFrame me={me} providers={providers} navItems={navItems}>
      {renderContent()}
    </PortalFrame>
  );
}
