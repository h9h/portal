import { describe, test, expect, mock } from "bun:test";
import { createContextStore } from "../../src/runtime/store";

describe("createContextStore", () => {
  test("get returns undefined for a key never set", () => {
    const store = createContextStore();
    expect(store.get("profile")).toBeUndefined();
  });

  test("set then get returns the value", () => {
    const store = createContextStore();
    store.set("profile", { name: "Ada" });
    expect(store.get("profile")).toEqual({ name: "Ada" });
  });

  test("subscribe is notified on set for that key", () => {
    const store = createContextStore();
    const listener = mock(() => {});
    store.subscribe("profile", listener);
    store.set("profile", { name: "Ada" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("subscribe is not notified for a different key", () => {
    const store = createContextStore();
    const listener = mock(() => {});
    store.subscribe("profile", listener);
    store.set("contactData", { address: "1 Main St" });
    expect(listener).not.toHaveBeenCalled();
  });

  test("unsubscribing stops further notifications", () => {
    const store = createContextStore();
    const listener = mock(() => {});
    const unsubscribe = store.subscribe("profile", listener);
    unsubscribe();
    store.set("profile", { name: "Ada" });
    expect(listener).not.toHaveBeenCalled();
  });

  test("multiple subscribers to the same key are all notified", () => {
    const store = createContextStore();
    const a = mock(() => {});
    const b = mock(() => {});
    store.subscribe("profile", a);
    store.subscribe("profile", b);
    store.set("profile", { name: "Ada" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test("a listener that unsubscribes itself during notification does not break other listeners", () => {
    const store = createContextStore();
    let unsubscribeA: () => void;
    const a = mock(() => unsubscribeA());
    const b = mock(() => {});
    unsubscribeA = store.subscribe("profile", a);
    store.subscribe("profile", b);
    store.set("profile", { name: "Ada" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
