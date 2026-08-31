import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { usePortalNavigate, usePortalLogout } from "@portal/runtime";
// Me/Provider/NavItem are owned by shell-entry.tsx: it's the component that
// actually fetches /me, /routes, and /nav and decides their shape from the
// API responses — PortalFrame is just the presentational consumer of that
// already-fetched state, so it imports the types rather than defining them.
import type { Me, Provider, NavItem } from "./shell-entry";

export type PortalFrameProps = {
  me: Me | undefined;
  providers: Provider[];
  navItems: NavItem[];
  children: ReactNode;
};

const styles = {
  page: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
    fontFamily: "var(--portal-font-family, system-ui, -apple-system, 'Segoe UI', sans-serif)",
    color: "var(--portal-color-text, #1a1a1a)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--portal-space-4, 1rem)",
    padding: "var(--portal-space-3, 0.75rem) var(--portal-space-6, 1.5rem)",
    borderBottom: "var(--portal-border-width, 1px) solid var(--portal-color-border, #ddd)",
  },
  logo: {
    display: "flex",
    alignItems: "center",
    gap: "var(--portal-space-2, 0.5rem)",
    textDecoration: "none",
    color: "inherit",
  },
  nav: { display: "flex", gap: "var(--portal-space-4, 1rem)", flexWrap: "wrap" },
  authControls: { display: "flex", alignItems: "center", gap: "var(--portal-space-3, 0.75rem)" },
  main: { flex: 1, padding: "var(--portal-space-6, 1.5rem)" },
  footer: {
    padding: "var(--portal-space-4, 1rem) var(--portal-space-6, 1.5rem)",
    borderTop: "var(--portal-border-width, 1px) solid var(--portal-color-border, #ddd)",
    fontSize: "var(--portal-font-size-small, 0.85rem)",
    color: "var(--portal-color-text-muted, #666)",
  },
} satisfies Record<string, CSSProperties>;

// Preserves normal <a> semantics (open in new tab, copy link, modifier-key
// clicks) for anything but a plain left-click — the pattern specification.md's
// Client shell section already calls for: "a component that wants a real <a>
// to navigate client-side calls usePortalNavigate() from its own click
// handler."
function InternalLink({
  path,
  navigate,
  style,
  children,
}: {
  path: string;
  navigate: (path: string) => void;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <a
      href={path}
      style={style}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(path);
      }}
    >
      {children}
    </a>
  );
}

function PortalLogoPlaceholder() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" role="img" aria-label="Portal logo placeholder">
      <rect width="28" height="28" rx="6" fill="var(--portal-color-primary, #4338ca)" />
      <text
        x="14"
        y="19"
        textAnchor="middle"
        fontSize="14"
        fontFamily="sans-serif"
        fill="var(--portal-color-primary-contrast, #fff)"
      >
        P
      </text>
    </svg>
  );
}

function AuthControls({
  me,
  providers,
  navigate,
}: {
  me: Me | undefined;
  providers: Provider[];
  navigate: (path: string) => void;
}) {
  const logout = usePortalLogout();

  if (me === undefined) return null;

  if (me === null) {
    return (
      <div style={styles.authControls}>
        {providers.map((provider) => (
          <a key={provider.name} href={`/auth/login/${provider.name}`}>
            Sign in with {provider.label}
          </a>
        ))}
      </div>
    );
  }

  const label = me.displayName ?? me.email ?? me.id;
  return (
    <div style={styles.authControls}>
      <InternalLink path="/profile" navigate={navigate}>
        {label}
      </InternalLink>
      <button
        type="button"
        onClick={() => {
          void logout();
        }}
      >
        Logout
      </button>
    </div>
  );
}

export function PortalFrame({ me, providers, navItems, children }: PortalFrameProps) {
  const navigate = usePortalNavigate();

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <InternalLink path="/" navigate={navigate} style={styles.logo}>
          <PortalLogoPlaceholder />
          <span>Portal</span>
        </InternalLink>
        <nav style={styles.nav}>
          {navItems.map((item) => (
            <InternalLink key={`${item.domain}:${item.path}`} path={item.path} navigate={navigate}>
              {item.label}
            </InternalLink>
          ))}
        </nav>
        <AuthControls me={me} providers={providers} navigate={navigate} />
      </header>
      <main style={styles.main}>{children}</main>
      <footer style={styles.footer}>Contact: hello@example.com</footer>
    </div>
  );
}
