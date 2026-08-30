import { describe, test, expect } from "bun:test";
import { createDatabase } from "../../src/db";
import { findOrCreateUser } from "../../src/auth/users";

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
