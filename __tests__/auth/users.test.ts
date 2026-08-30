import { describe, test, expect } from "bun:test";
import { createDatabase } from "../../src/db";
import { findOrCreateUser, findUserById, listUsers } from "../../src/auth/users";

describe("findOrCreateUser", () => {
  test("creates a new user on first login", () => {
    const db = createDatabase(":memory:");
    const user = findOrCreateUser(db, "github", {
      providerUserId: "123",
      email: "octocat@example.com",
      displayName: "The Octocat",
    });
    expect(user.provider).toBe("github");
    expect(user.providerUserId).toBe("123");
    expect(user.email).toBe("octocat@example.com");
    expect(user.id).toBeTruthy();
  });

  test("returns the same user on a second login", () => {
    const db = createDatabase(":memory:");
    const first = findOrCreateUser(db, "github", {
      providerUserId: "123",
      email: "octocat@example.com",
      displayName: "The Octocat",
    });
    const second = findOrCreateUser(db, "github", {
      providerUserId: "123",
      email: "octocat@example.com",
      displayName: "The Octocat",
    });
    expect(second.id).toBe(first.id);
  });

  test("treats the same provider user id from a different provider as a different user", () => {
    const db = createDatabase(":memory:");
    const githubUser = findOrCreateUser(db, "github", {
      providerUserId: "123",
      email: "a@example.com",
      displayName: "A",
    });
    const otherUser = findOrCreateUser(db, "gitlab", {
      providerUserId: "123",
      email: "b@example.com",
      displayName: "B",
    });
    expect(otherUser.id).not.toBe(githubUser.id);
  });
});

describe("findUserById", () => {
  test("returns null for an unknown id", () => {
    const db = createDatabase(":memory:");
    expect(findUserById(db, "does-not-exist")).toBeNull();
  });

  test("returns the user for a known id", () => {
    const db = createDatabase(":memory:");
    const created = findOrCreateUser(db, "github", {
      providerUserId: "1",
      email: "octocat@example.com",
      displayName: "The Octocat",
    });
    const found = findUserById(db, created.id);
    expect(found).toEqual(created);
  });
});

describe("listUsers", () => {
  test("returns an empty array when there are no users", () => {
    const db = createDatabase(":memory:");
    expect(listUsers(db)).toEqual([]);
  });

  test("returns every user", () => {
    const db = createDatabase(":memory:");
    const a = findOrCreateUser(db, "github", { providerUserId: "1", email: "a@example.com", displayName: "A" });
    const b = findOrCreateUser(db, "github", { providerUserId: "2", email: "b@example.com", displayName: "B" });
    const users = listUsers(db);
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("returns users in creation order", () => {
    const db = createDatabase(":memory:");
    const first = findOrCreateUser(db, "github", { providerUserId: "1", email: "a@example.com", displayName: "A" });
    const second = findOrCreateUser(db, "github", { providerUserId: "2", email: "b@example.com", displayName: "B" });
    const users = listUsers(db);
    expect(users.map((u) => u.id)).toEqual([first.id, second.id]);
  });
});
