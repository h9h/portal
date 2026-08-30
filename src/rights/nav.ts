import type { ManifestEntry } from "../scs/manifest-registry";

export type NavItem = {
  label: string;
  path: string;
  domain: string;
};

export function buildNav(entries: ManifestEntry[], userRoles: string[]): NavItem[] {
  const nav: NavItem[] = [];
  for (const entry of entries) {
    if (!entry.manifest) continue;
    for (const item of entry.manifest.nav) {
      const visible = item.requiredRoles.length === 0 || item.requiredRoles.some((role) => userRoles.includes(role));
      if (visible) {
        nav.push({ label: item.label, path: item.path, domain: entry.manifest.name });
      }
    }
  }
  return nav;
}
