import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { signInternalToken, verifyInternalToken } from "../../src/auth/internal-tokens";

const SECRET = "test-secret";
const AUDIENCE = "https://orders.example";

function constructTokenWithPayload(payloadStr: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(payloadStr).toString("base64url");
  const signature = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("internal tokens", () => {
  test("a freshly signed token verifies and carries the user id and roles", () => {
    const token = signInternalToken("user-1", ["orders:admin"], AUDIENCE, SECRET);
    const payload = verifyInternalToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("user-1");
    expect(payload!.roles).toEqual(["orders:admin"]);
    expect(payload!.aud).toBe(AUDIENCE);
  });

  test("a token can carry an empty roles array", () => {
    const token = signInternalToken("user-1", [], AUDIENCE, SECRET);
    const payload = verifyInternalToken(token, SECRET);
    expect(payload!.roles).toEqual([]);
  });

  test("an expired token fails verification", () => {
    const token = signInternalToken("user-1", ["orders:admin"], AUDIENCE, SECRET, -1);
    expect(verifyInternalToken(token, SECRET)).toBeNull();
  });

  test("a token signed with a different secret fails verification", () => {
    const token = signInternalToken("user-1", ["orders:admin"], AUDIENCE, SECRET);
    expect(verifyInternalToken(token, "wrong-secret")).toBeNull();
  });

  test("a tampered payload fails verification", () => {
    const token = signInternalToken("user-1", ["orders:admin"], AUDIENCE, SECRET);
    const [header, , signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: "user-2", roles: ["orders:admin"], aud: AUDIENCE, exp: 9999999999 })
    ).toString("base64url");
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    expect(verifyInternalToken(tampered, SECRET)).toBeNull();
  });

  test("a validly-signed token with invalid JSON payload returns null", () => {
    const token = constructTokenWithPayload("not valid json{");
    expect(verifyInternalToken(token, SECRET)).toBeNull();
  });

  test("a validly-signed token missing required fields returns null", () => {
    const missingRoles = constructTokenWithPayload(JSON.stringify({ sub: "user-1", aud: AUDIENCE, exp: 9999999999 }));
    expect(verifyInternalToken(missingRoles, SECRET)).toBeNull();

    const missingSub = constructTokenWithPayload(JSON.stringify({ roles: [], aud: AUDIENCE, exp: 9999999999 }));
    expect(verifyInternalToken(missingSub, SECRET)).toBeNull();

    const missingAud = constructTokenWithPayload(
      JSON.stringify({ sub: "user-1", roles: [], exp: 9999999999 })
    );
    expect(verifyInternalToken(missingAud, SECRET)).toBeNull();

    const rolesNotArray = constructTokenWithPayload(
      JSON.stringify({ sub: "user-1", roles: "orders:admin", aud: AUDIENCE, exp: 9999999999 })
    );
    expect(verifyInternalToken(rolesNotArray, SECRET)).toBeNull();

    const rolesNotStrings = constructTokenWithPayload(
      JSON.stringify({ sub: "user-1", roles: [1, 2], aud: AUDIENCE, exp: 9999999999 })
    );
    expect(verifyInternalToken(rolesNotStrings, SECRET)).toBeNull();
  });
});
