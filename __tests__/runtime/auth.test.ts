import { describe, test, expect, afterEach } from "bun:test";
import { withDom } from "../helpers/dom";

withDom();

// sessionStorage persists across every test in this file (withDom() registers
// happy-dom once per file, not per test) — clear it after each test so one
// test's stored session never leaks into the next.
afterEach(() => {
  sessionStorage.clear();
});

describe("getStoredTokens / storeTokens / clearTokens", () => {
  test("getStoredTokens returns null when nothing has been stored", async () => {
    const { getStoredTokens } = await import("../../src/runtime/auth");
    expect(getStoredTokens()).toBeNull();
  });

  test("storeTokens then getStoredTokens round-trips the session", async () => {
    const { getStoredTokens, storeTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "a.b.c", refreshToken: "r-1" });
    expect(getStoredTokens()).toEqual({ accessToken: "a.b.c", refreshToken: "r-1" });
  });

  test("storeTokens overwrites a previously stored session", async () => {
    const { getStoredTokens, storeTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "old", refreshToken: "old-r" });
    storeTokens({ accessToken: "new", refreshToken: "new-r" });
    expect(getStoredTokens()).toEqual({ accessToken: "new", refreshToken: "new-r" });
  });

  test("clearTokens removes the stored session", async () => {
    const { getStoredTokens, storeTokens, clearTokens } = await import("../../src/runtime/auth");
    storeTokens({ accessToken: "a.b.c", refreshToken: "r-1" });
    clearTokens();
    expect(getStoredTokens()).toBeNull();
  });

  test("getStoredTokens returns null for malformed stored JSON, without throwing", async () => {
    const { getStoredTokens } = await import("../../src/runtime/auth");
    sessionStorage.setItem("portal:session", "not valid json{{{");
    expect(getStoredTokens()).toBeNull();
  });

  test("getStoredTokens returns null for a stored value missing the expected shape", async () => {
    const { getStoredTokens } = await import("../../src/runtime/auth");
    sessionStorage.setItem("portal:session", JSON.stringify({ accessToken: "a.b.c" })); // no refreshToken
    expect(getStoredTokens()).toBeNull();
  });
});
