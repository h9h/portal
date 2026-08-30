export type RouteEntry = {
  path: string;
  requiredRoles: string[];
  component?: string;
};

export type NavEntry = {
  label: string;
  path: string;
  requiredRoles: string[];
};

export type SCSManifest = {
  name: string;
  bundle?: string;
  routes: RouteEntry[];
  nav: NavEntry[];
  publishesContext: string[];
  consumesContext: string[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseRouteEntry(value: unknown): RouteEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== "string" || !isStringArray(obj.requiredRoles)) return null;
  if (obj.component !== undefined && typeof obj.component !== "string") return null;
  return {
    path: obj.path,
    requiredRoles: obj.requiredRoles,
    ...(typeof obj.component === "string" ? { component: obj.component } : {}),
  };
}

function parseNavEntry(value: unknown): NavEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.label !== "string" || typeof obj.path !== "string" || !isStringArray(obj.requiredRoles)) {
    return null;
  }
  return { label: obj.label, path: obj.path, requiredRoles: obj.requiredRoles };
}

export function parseManifest(json: unknown): SCSManifest | null {
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name.length === 0) return null;
  if (obj.bundle !== undefined && (typeof obj.bundle !== "string" || obj.bundle.length === 0)) return null;
  if (!Array.isArray(obj.routes) || !Array.isArray(obj.nav)) return null;
  if (obj.publishesContext !== undefined && !isStringArray(obj.publishesContext)) return null;
  if (obj.consumesContext !== undefined && !isStringArray(obj.consumesContext)) return null;

  const routes: RouteEntry[] = [];
  for (const raw of obj.routes) {
    const entry = parseRouteEntry(raw);
    if (!entry) return null;
    routes.push(entry);
  }

  const nav: NavEntry[] = [];
  for (const raw of obj.nav) {
    const entry = parseNavEntry(raw);
    if (!entry) return null;
    nav.push(entry);
  }

  return {
    name: obj.name,
    ...(typeof obj.bundle === "string" ? { bundle: obj.bundle } : {}),
    routes,
    nav,
    publishesContext: isStringArray(obj.publishesContext) ? obj.publishesContext : [],
    consumesContext: isStringArray(obj.consumesContext) ? obj.consumesContext : [],
  };
}
