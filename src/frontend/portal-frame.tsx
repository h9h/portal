import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { usePortalNavigate, usePortalLogout } from "@portal/runtime";

export type Me = {
  id: string;
  roles: string[];
  displayName: string | null;
  email: string | null;
} | null;

export type Provider = { name: string; label: string };

export type NavItem = { label: string; path: string; domain: string };

export type PortalFrameProps = {
  me: Me | undefined;
  providers: Provider[];
  navItems: NavItem[];
  children: ReactNode;
};

const styles = {
  page: { display: "flex", flexDirection: "column", minHeight: "100vh" },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    padding: "0.75rem 1.5rem",
    borderBottom: "1px solid #ddd",
  },
  logo: { display: "flex", alignItems: "center", gap: "0.5rem", textDecoration: "none", color: "inherit" },
  nav: { display: "flex", gap: "1rem", flexWrap: "wrap" },
  authControls: { display: "flex", alignItems: "center", gap: "0.75rem" },
  main: { flex: 1, padding: "1.5rem" },
  footer: { padding: "1rem 1.5rem", borderTop: "1px solid #ddd", fontSize: "0.85rem", color: "#666" },
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
      <rect width="28" height="28" rx="6" fill="#4338ca" />
      <text x="14" y="19" textAnchor="middle" fontSize="14" fontFamily="sans-serif" fill="#fff">
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
