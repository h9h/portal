export type RouteTableEntry = {
  path: string;
  scsName: string;
  requiredRoles: string[];
  component?: string;
};

export type RouteResolution =
  | { status: "not_found" }
  | { status: "forbidden"; requiredRoles: string[] }
  | { status: "no_component" }
  | { status: "matched"; entry: RouteTableEntry };

// Strips trailing slashes from a path, leaving a bare "/" untouched. Mirrors
// the normalization src/server.ts applies to the request path before ever
// consulting the route index (see its composition catch-all), so a client
// navigation to a trailing-slash path resolves the same entry the server
// would serve data for.
export function normalizePath(path: string): string {
  return path === "/" ? path : path.replace(/\/+$/, "");
}

// Client-side only — a UX gate to decide what to render, never the security
// boundary. The route table itself is matched with exact-string equality (no
// parameterized/prefix routes) — same as the server-side route index. The
// request path is normalized (trailing slashes stripped, "/" left as-is)
// before that lookup, mirroring the normalization the server applies before
// consulting its own route index.
export function resolveRoute(table: RouteTableEntry[], path: string, userRoles: string[]): RouteResolution {
  const normalizedPath = normalizePath(path);
  const entry = table.find((r) => r.path === normalizedPath);
  if (!entry) return { status: "not_found" };
  const allowed = entry.requiredRoles.length === 0 || entry.requiredRoles.some((r) => userRoles.includes(r));
  if (!allowed) return { status: "forbidden", requiredRoles: entry.requiredRoles };
  if (!entry.component) return { status: "no_component" };
  return { status: "matched", entry };
}
