import { describe, test, expect } from "bun:test";
import { createState, verifyState, createStateCookie, readStateCookie, stateNonce } from "../../src/auth/state";

const SECRET = "state-secret";

describe("OAuth state", () => {
  test("a freshly created state verifies", () => {
    const state = createState(SECRET);
    expect(verifyState(state, SECRET)).toBe(true);
  });

  test("a state signed with a different secret fails verification", () => {
    const state = createState(SECRET);
    expect(verifyState(state, "wrong-secret")).toBe(false);
  });

  test("a malformed state fails verification", () => {
    expect(verifyState("not-a-valid-state", SECRET)).toBe(false);
  });

  test("two states are not identical (nonce varies)", () => {
    expect(createState(SECRET)).not.toBe(createState(SECRET));
  });

  test("a state with extra trailing segments fails verification", () => {
    const state = createState(SECRET);
    const stateWithGarbage = `${state}.garbage`;
    expect(verifyState(stateWithGarbage, SECRET)).toBe(false);
  });
});

describe("createStateCookie", () => {
  test("contains the nonce", () => {
    expect(createStateCookie("the-nonce", true)).toContain("portal_oauth_state=the-nonce");
  });

  test("is HttpOnly", () => {
    expect(createStateCookie("the-nonce", true)).toContain("HttpOnly");
  });

  test("is SameSite=Lax", () => {
    expect(createStateCookie("the-nonce", true)).toContain("SameSite=Lax");
  });

  test("is scoped to Path=/auth/callback", () => {
    expect(createStateCookie("the-nonce", true)).toContain("Path=/auth/callback");
  });

  test("has a short Max-Age of 600 seconds", () => {
    expect(createStateCookie("the-nonce", true)).toContain("Max-Age=600");
  });

  test("includes Secure when secure is true", () => {
    expect(createStateCookie("the-nonce", true)).toContain("Secure");
  });

  test("omits Secure when secure is false", () => {
    expect(createStateCookie("the-nonce", false)).not.toContain("Secure");
  });
});

describe("readStateCookie", () => {
  function requestWithCookie(cookieHeader: string | null): Request {
    const headers: Record<string, string> = {};
    if (cookieHeader !== null) headers["Cookie"] = cookieHeader;
    return new Request("https://example.com/auth/callback/fake", { headers });
  }

  test("returns the value for a present cookie", () => {
    expect(readStateCookie(requestWithCookie("portal_oauth_state=abc"))).toBe("abc");
  });

  test("returns null when the Cookie header is absent", () => {
    expect(readStateCookie(requestWithCookie(null))).toBeNull();
  });

  test("returns null when the named cookie isn't among several present ones", () => {
    expect(readStateCookie(requestWithCookie("other=1; another=2"))).toBeNull();
  });

  test("picks the right value out of multiple cookies", () => {
    expect(readStateCookie(requestWithCookie("other=1; portal_oauth_state=abc; another=2"))).toBe("abc");
  });
});

describe("stateNonce", () => {
  test("returns the nonce segment for a real createState(...) output", () => {
    const state = createState(SECRET);
    expect(stateNonce(state)).toBe(state.split(".")[0]);
  });

  test("returns null for a malformed/single-segment string", () => {
    expect(stateNonce("not-a-valid-state")).toBeNull();
  });
});
