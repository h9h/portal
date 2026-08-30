import { describe, test, expect } from "bun:test";
import { signAccessToken, verifyAccessToken } from "../../src/auth/tokens";

const SECRET = "test-secret";

describe("access tokens", () => {
  test("a freshly signed token verifies and carries the user id", () => {
    const token = signAccessToken("user-1", SECRET);
    const payload = verifyAccessToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("user-1");
  });

  test("an expired token fails verification", () => {
    const token = signAccessToken("user-1", SECRET, -1);
    expect(verifyAccessToken(token, SECRET)).toBeNull();
  });

  test("a token signed with a different secret fails verification", () => {
    const token = signAccessToken("user-1", SECRET);
    expect(verifyAccessToken(token, "wrong-secret")).toBeNull();
  });

  test("a tampered payload fails verification", () => {
    const token = signAccessToken("user-1", SECRET);
    const [header, , signature] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: "user-2", exp: 9999999999 })).toString("base64url");
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    expect(verifyAccessToken(tampered, SECRET)).toBeNull();
  });
});
