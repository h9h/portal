import { describe, test, expect } from "bun:test";
import { getProviders } from "../../src/auth/providers";

describe("github mapProfile", () => {
  const { mapProfile } = getProviders({}).github;

  test("maps a profile with an email present", () => {
    const profile = mapProfile({ id: 42, email: "octocat@example.com", name: "The Octocat", login: "octocat" });
    expect(profile).toEqual({ providerUserId: "42", email: "octocat@example.com", displayName: "The Octocat" });
  });

  test("maps a profile with email: null", () => {
    const profile = mapProfile({ id: 42, email: null, name: "The Octocat", login: "octocat" });
    expect(profile.email).toBeNull();
  });

  test("falls back displayName from name to login when name is absent", () => {
    const profile = mapProfile({ id: 42, email: null, login: "octocat" });
    expect(profile.displayName).toBe("octocat");
  });

  test("coerces a numeric id to a string providerUserId", () => {
    const profile = mapProfile({ id: 12345, email: null, login: "octocat" });
    expect(profile.providerUserId).toBe("12345");
    expect(typeof profile.providerUserId).toBe("string");
  });
});

describe("getProviders labels", () => {
  test("github has a display label distinct from its provider key", () => {
    const { name, label } = getProviders({}).github;
    expect(name).toBe("github");
    expect(label).toBe("GitHub");
  });
});
