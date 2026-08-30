import { describe, test, expect } from "bun:test";
import { createDatabase } from "../../src/db";
import { findOrCreateUser } from "../../src/auth/users";
import {
  createRefreshToken,
  verifyAndRotateRefreshToken,
  revokeRefreshToken,
} from "../../src/auth/refresh-tokens";

function setupUser(db: ReturnType<typeof createDatabase>) {
  return findOrCreateUser(db, "github", { providerUserId: "1", email: null, displayName: null }).id;
}

describe("refresh tokens", () => {
  test("a freshly created token verifies and rotates to a new token", () => {
    const db = createDatabase(":memory:");
    const userId = setupUser(db);
    const token = createRefreshToken(db, userId);

    const result = verifyAndRotateRefreshToken(db, token);

    expect(result).not.toBeNull();
    expect(result!.userId).toBe(userId);
    expect(result!.newToken).not.toBe(token);
  });

  test("a token cannot be used twice (rotation invalidates the old one)", () => {
    const db = createDatabase(":memory:");
    const userId = setupUser(db);
    const token = createRefreshToken(db, userId);

    verifyAndRotateRefreshToken(db, token);
    const secondAttempt = verifyAndRotateRefreshToken(db, token);

    expect(secondAttempt).toBeNull();
  });

  test("an unknown token fails verification", () => {
    const db = createDatabase(":memory:");
    expect(verifyAndRotateRefreshToken(db, "does-not-exist")).toBeNull();
  });

  test("revoking a token makes it fail verification", () => {
    const db = createDatabase(":memory:");
    const userId = setupUser(db);
    const token = createRefreshToken(db, userId);

    revokeRefreshToken(db, token);

    expect(verifyAndRotateRefreshToken(db, token)).toBeNull();
  });
});
