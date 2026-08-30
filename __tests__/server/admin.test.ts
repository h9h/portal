import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer } from "../../src/server";
import { createDatabase } from "../../src/db";
import { findOrCreateUser } from "../../src/auth/users";
import { assignRole, getUserRoles } from "../../src/rights/roles";
import { signAccessToken } from "../../src/auth/tokens";

const ACCESS_SECRET = "access-secret";

let db: ReturnType<typeof createDatabase>;
let portal: ReturnType<typeof createServer>;
let adminUserId: string;
let adminAccessToken: string;
let targetUserId: string;
let nonAdminAccessToken: string;

beforeEach(() => {
  db = createDatabase(":memory:");

  const admin = findOrCreateUser(db, "github", { providerUserId: "1", email: "admin@example.com", displayName: "Admin" });
  adminUserId = admin.id;
  assignRole(db, adminUserId, "portal:admin");
  adminAccessToken = signAccessToken(adminUserId, ACCESS_SECRET);

  const target = findOrCreateUser(db, "github", { providerUserId: "2", email: "target@example.com", displayName: "Target" });
  targetUserId = target.id;
  nonAdminAccessToken = signAccessToken(targetUserId, ACCESS_SECRET);

  portal = createServer({
    port: 0,
    db,
    accessTokenSecret: ACCESS_SECRET,
    stateSecret: "state-secret",
  });
});

afterEach(() => {
  portal.stop();
});

describe("GET /admin/users", () => {
  test("an unauthenticated request returns 401", async () => {
    const response = await fetch(`${portal.url}admin/users`);
    expect(response.status).toBe(401);
  });

  test("an authenticated non-admin request returns 403", async () => {
    const response = await fetch(`${portal.url}admin/users`, {
      headers: { Authorization: `Bearer ${nonAdminAccessToken}` },
    });
    expect(response.status).toBe(403);
  });

  test("an admin request lists every user with their roles", async () => {
    const response = await fetch(`${portal.url}admin/users`, {
      headers: { Authorization: `Bearer ${adminAccessToken}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: { id: string; email: string | null; roles: string[] }[] };
    expect(body.users).toHaveLength(2);
    const admin = body.users.find((u) => u.id === adminUserId)!;
    expect(admin.roles).toEqual(["portal:admin"]);
    const target = body.users.find((u) => u.id === targetUserId)!;
    expect(target.roles).toEqual([]);
  });
});

describe("POST /admin/users/:userId/roles", () => {
  test("an unauthenticated request returns 401", async () => {
    const response = await fetch(`${portal.url}admin/users/${targetUserId}/roles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "orders:admin" }),
    });
    expect(response.status).toBe(401);
  });

  test("an authenticated non-admin request returns 403", async () => {
    const response = await fetch(`${portal.url}admin/users/${targetUserId}/roles`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nonAdminAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "orders:admin" }),
    });
    expect(response.status).toBe(403);
  });

  test("an admin can assign a role to another user", async () => {
    const response = await fetch(`${portal.url}admin/users/${targetUserId}/roles`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "orders:admin" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { userId: string; roles: string[] };
    expect(body.userId).toBe(targetUserId);
    expect(body.roles).toEqual(["orders:admin"]);
    expect(getUserRoles(db, targetUserId)).toEqual(["orders:admin"]);
  });

  test("assigning the same role twice is idempotent", async () => {
    await fetch(`${portal.url}admin/users/${targetUserId}/roles`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "orders:admin" }),
    });
    const response = await fetch(`${portal.url}admin/users/${targetUserId}/roles`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "orders:admin" }),
    });
    expect(response.status).toBe(200);
    expect(getUserRoles(db, targetUserId)).toEqual(["orders:admin"]);
  });

  test("assigning a role to an unknown user returns 404", async () => {
    const response = await fetch(`${portal.url}admin/users/does-not-exist/roles`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "orders:admin" }),
    });
    expect(response.status).toBe(404);
  });

  test("a missing or empty role in the body returns 400", async () => {
    const response = await fetch(`${portal.url}admin/users/${targetUserId}/roles`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  test("an admin can revoke their own portal:admin role (no special guard)", async () => {
    const response = await fetch(`${portal.url}admin/users/${adminUserId}/roles/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "portal:admin" }),
    });
    expect(response.status).toBe(200);
    expect(getUserRoles(db, adminUserId)).toEqual([]);
  });
});

describe("POST /admin/users/:userId/roles/revoke", () => {
  test("an unauthenticated request returns 401", async () => {
    const response = await fetch(`${portal.url}admin/users/${targetUserId}/roles/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "orders:admin" }),
    });
    expect(response.status).toBe(401);
  });

  test("an admin can revoke a role from another user", async () => {
    assignRole(db, targetUserId, "orders:admin");

    const response = await fetch(`${portal.url}admin/users/${targetUserId}/roles/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "orders:admin" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { userId: string; roles: string[] };
    expect(body.roles).toEqual([]);
    expect(getUserRoles(db, targetUserId)).toEqual([]);
  });

  test("revoking a role the user doesn't have is a no-op success", async () => {
    const response = await fetch(`${portal.url}admin/users/${targetUserId}/roles/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "orders:admin" }),
    });
    expect(response.status).toBe(200);
    expect(getUserRoles(db, targetUserId)).toEqual([]);
  });

  test("revoking a role from an unknown user returns 404", async () => {
    const response = await fetch(`${portal.url}admin/users/does-not-exist/roles/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "orders:admin" }),
    });
    expect(response.status).toBe(404);
  });
});
