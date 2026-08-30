import { describe, test, expect } from "bun:test";
import { createState, verifyState } from "../../src/auth/state";

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
});
