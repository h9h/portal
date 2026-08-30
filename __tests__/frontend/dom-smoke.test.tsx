import { describe, test, expect } from "bun:test";
import { withDom } from "../helpers/dom";

withDom();

describe("JSX + happy-dom smoke test", () => {
  test("a JSX element renders into a happy-dom container via react-dom/client", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<div>hello</div>);
    });

    expect(container.textContent).toBe("hello");
  });
});
