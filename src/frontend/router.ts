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

// Client-side only — a UX gate to decide what to render, never the security
// boundary. Exact-path matching, same as the server-side route index (no
// trailing-slash normalization, no parameterized/prefix routes).
export function resolveRoute(table: RouteTableEntry[], path: string, userRoles: string[]): RouteResolution {
  const entry = table.find((r) => r.path === path);
  if (!entry) return { status: "not_found" };
  const allowed = entry.requiredRoles.length === 0 || entry.requiredRoles.some((r) => userRoles.includes(r));
  if (!allowed) return { status: "forbidden", requiredRoles: entry.requiredRoles };
  if (!entry.component) return { status: "no_component" };
  return { status: "matched", entry };
}
