import { describe, test, expect } from "bun:test";
import { createDatabase } from "../../src/db";
import { assignRole, revokeRole, getUserRoles } from "../../src/rights/roles";

describe("role storage", () => {
  test("a newly created user has no roles", () => {
    const db = createDatabase(":memory:");
    expect(getUserRoles(db, "user-1")).toEqual([]);
  });

  test("assigning a role makes it show up in getUserRoles", () => {
    const db = createDatabase(":memory:");
    assignRole(db, "user-1", "orders:admin");
    expect(getUserRoles(db, "user-1")).toEqual(["orders:admin"]);
  });

  test("assigning the same role twice is idempotent", () => {
    const db = createDatabase(":memory:");
    assignRole(db, "user-1", "orders:admin");
    assignRole(db, "user-1", "orders:admin");
    expect(getUserRoles(db, "user-1")).toEqual(["orders:admin"]);
  });

  test("a user can hold multiple roles", () => {
    const db = createDatabase(":memory:");
    assignRole(db, "user-1", "orders:admin");
    assignRole(db, "user-1", "billing:viewer");
    expect(getUserRoles(db, "user-1").sort()).toEqual(["billing:viewer", "orders:admin"]);
  });

  test("revoking a role removes it", () => {
    const db = createDatabase(":memory:");
    assignRole(db, "user-1", "orders:admin");
    revokeRole(db, "user-1", "orders:admin");
    expect(getUserRoles(db, "user-1")).toEqual([]);
  });

  test("revoking a role the user doesn't have is a no-op", () => {
    const db = createDatabase(":memory:");
    expect(() => revokeRole(db, "user-1", "orders:admin")).not.toThrow();
    expect(getUserRoles(db, "user-1")).toEqual([]);
  });

  test("roles are scoped per user", () => {
    const db = createDatabase(":memory:");
    assignRole(db, "user-1", "orders:admin");
    expect(getUserRoles(db, "user-2")).toEqual([]);
  });
});
