import { describe, test, expect } from "bun:test";
import { withDom } from "../helpers/dom";

withDom();

// happy-dom defaults to "about:blank"; pushState against it can't resolve a
// relative path (window.location.pathname comes back as "blank"). Set a real
// https: origin via happy-dom's own `window.happyDOM.setURL` first — it does
// not add a history entry — then reach the path via a normal pushState so it
// lands in the real history stack, which the popstate test below needs for
// history.back() to have somewhere to go.
function setInitialPath(path: string): void {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
    "https://localhost:3000/"
  );
  history.pushState(null, "", path);
}

describe("usePortalNavigate / useCurrentPath", () => {
  test("useCurrentPath reflects the current location", async () => {
    setInitialPath("/orders");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { useCurrentPath } = await import("../../src/runtime/navigate");

    const seen: string[] = [];
    function Reader() {
      seen.push(useCurrentPath());
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Reader />);
    });

    expect(seen[seen.length - 1]).toBe("/orders");
  });

  test("usePortalNavigate updates history and is reflected by useCurrentPath in another mounted tree", async () => {
    setInitialPath("/orders");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { usePortalNavigate, useCurrentPath } = await import("../../src/runtime/navigate");
    const React = await import("react");

    function Navigator() {
      const navigate = usePortalNavigate();
      React.useEffect(() => {
        navigate("/billing");
      }, [navigate]);
      return null;
    }
    const seen: string[] = [];
    function Reader() {
      seen.push(useCurrentPath());
      return null;
    }

    const containerA = document.createElement("div");
    const containerB = document.createElement("div");
    document.body.appendChild(containerA);
    document.body.appendChild(containerB);
    const rootA = createRoot(containerA);
    const rootB = createRoot(containerB);

    act(() => {
      rootB.render(<Reader />);
    });
    act(() => {
      rootA.render(<Navigator />);
    });

    expect(seen[seen.length - 1]).toBe("/billing");
    expect(window.location.pathname).toBe("/billing");
  });

  test("a browser back/forward (popstate) is reflected by useCurrentPath", async () => {
    setInitialPath("/orders");
    history.pushState(null, "", "/billing");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { useCurrentPath } = await import("../../src/runtime/navigate");

    const seen: string[] = [];
    function Reader() {
      seen.push(useCurrentPath());
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Reader />);
    });
    expect(seen[seen.length - 1]).toBe("/billing");

    act(() => {
      history.back();
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(seen[seen.length - 1]).toBe("/orders");
  });
});
