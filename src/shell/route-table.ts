import type { RouteIndex } from "../rights/route-access";
import type { ContextIndex } from "../rights/context-index";
import type { RouteTableEntry } from "../frontend/router";

export function buildRouteTable(index: RouteIndex): RouteTableEntry[] {
  const table: RouteTableEntry[] = [];
  for (const [path, entry] of index.routes) {
    table.push({
      path,
      scsName: entry.scsName,
      requiredRoles: entry.requiredRoles,
      ...(entry.component ? { component: entry.component } : {}),
    });
  }
  return table;
}

export function buildContextOwners(index: ContextIndex): Record<string, string> {
  return Object.fromEntries(index.owners);
}
