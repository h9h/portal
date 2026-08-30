import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { signAccessToken, verifyAccessToken } from "../../src/auth/tokens";

const SECRET = "test-secret";

// Helper to construct a token with a specific payload and valid signature
function constructTokenWithPayload(payloadStr: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(payloadStr).toString("base64url");
  const signature = createHmac("sha256", SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

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

  test("a validly-signed token with invalid JSON payload returns null", () => {
    // Construct a token with a payload that's not valid JSON but is validly signed
    const token = constructTokenWithPayload("not valid json{");
    expect(verifyAccessToken(token, SECRET)).toBeNull();
  });

  test("a validly-signed token missing required fields returns null", () => {
    // Missing 'exp' field
    const token1 = constructTokenWithPayload(JSON.stringify({ sub: "user-1" }));
    expect(verifyAccessToken(token1, SECRET)).toBeNull();

    // Missing 'sub' field
    const token2 = constructTokenWithPayload(JSON.stringify({ exp: 9999999999 }));
    expect(verifyAccessToken(token2, SECRET)).toBeNull();

    // Wrong types
    const token3 = constructTokenWithPayload(JSON.stringify({ sub: 123, exp: "not-a-number" }));
    expect(verifyAccessToken(token3, SECRET)).toBeNull();
  });
});
