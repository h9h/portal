import { describe, test, expect } from "bun:test";
import { signAccessToken } from "../../src/auth/tokens";
import { getAuthenticatedUserId } from "../../src/auth/middleware";

const SECRET = "test-secret";

describe("getAuthenticatedUserId", () => {
  test("returns the user id for a valid bearer token", () => {
    const token = signAccessToken("user-1", SECRET);
    const req = new Request("http://localhost/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(getAuthenticatedUserId(req, SECRET)).toBe("user-1");
  });

  test("returns null when there is no Authorization header", () => {
    const req = new Request("http://localhost/me");
    expect(getAuthenticatedUserId(req, SECRET)).toBeNull();
  });

  test("returns null for a malformed Authorization header", () => {
    const req = new Request("http://localhost/me", { headers: { Authorization: "not-bearer token" } });
    expect(getAuthenticatedUserId(req, SECRET)).toBeNull();
  });

  test("returns null for an invalid token", () => {
    const req = new Request("http://localhost/me", { headers: { Authorization: "Bearer garbage" } });
    expect(getAuthenticatedUserId(req, SECRET)).toBeNull();
  });
});
