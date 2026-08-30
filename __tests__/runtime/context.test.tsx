import { describe, test, expect, mock, spyOn } from "bun:test";
import { withDom } from "../helpers/dom";

withDom();

describe("usePublishedContext / usePublishContext / PortalRuntimeProvider", () => {
  test("a value published by an owning SCS is read by usePublishedContext", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { usePublishedContext, usePublishContext, PortalRuntimeProvider } = await import("../../src/runtime/context");

    const seen: unknown[] = [];

    function Publisher() {
      const publish = usePublishContext("profile");
      React.useEffect(() => {
        publish({ name: "Ada" });
      }, [publish]);
      return null;
    }
    function Reader() {
      const value = usePublishedContext("profile");
      seen.push(value);
      return null;
    }
    const React = await import("react");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <PortalRuntimeProvider scsName="profile" contextOwners={{ profile: "profile" }}>
          <Publisher />
          <Reader />
        </PortalRuntimeProvider>
      );
    });

    expect(seen[seen.length - 1]).toEqual({ name: "Ada" });
  });

  test("usePublishContext is a no-op with a warning for an unowned key", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { usePublishedContext, usePublishContext, PortalRuntimeProvider } = await import("../../src/runtime/context");
    const React = await import("react");

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    function Publisher() {
      const publish = usePublishContext("contactData"); // owned by "contactData", not "profile"
      React.useEffect(() => {
        publish({ address: "1 Main St" });
      }, [publish]);
      return null;
    }
    const seen: unknown[] = [];
    function Reader() {
      seen.push(usePublishedContext("contactData"));
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <PortalRuntimeProvider scsName="profile" contextOwners={{ contactData: "contactData" }}>
          <Publisher />
          <Reader />
        </PortalRuntimeProvider>
      );
    });

    expect(seen[seen.length - 1]).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("usePublishContext for a collision-voided key (absent from contextOwners) is a no-op with a warning", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { usePublishedContext, usePublishContext, PortalRuntimeProvider } = await import("../../src/runtime/context");
    const React = await import("react");

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    function Publisher() {
      const publish = usePublishContext("shared");
      React.useEffect(() => {
        publish("value");
      }, [publish]);
      return null;
    }
    const seen: unknown[] = [];
    function Reader() {
      seen.push(usePublishedContext("shared"));
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <PortalRuntimeProvider scsName="profile" contextOwners={{}}>
          <Publisher />
          <Reader />
        </PortalRuntimeProvider>
      );
    });

    expect(seen[seen.length - 1]).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("usePublishContext outside any PortalRuntimeProvider is a no-op with a warning", async () => {
    const { createRoot } = await import("react-dom/client");
    const { usePublishContext } = await import("../../src/runtime/context");

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    function Publisher() {
      const publish = usePublishContext("profile");
      publish("value"); // called directly during render is fine for this assertion's purpose
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const { act: act2 } = await import("react");
    act2(() => {
      root.render(<Publisher />);
    });

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("a reader in a different mounted tree sees updates published from another tree (shared singleton store)", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { usePublishedContext, usePublishContext, PortalRuntimeProvider } = await import("../../src/runtime/context");
    const React = await import("react");

    function Publisher() {
      const publish = usePublishContext("profile");
      React.useEffect(() => {
        publish({ name: "Grace" });
      }, [publish]);
      return null;
    }
    const seen: unknown[] = [];
    function Reader() {
      seen.push(usePublishedContext("profile"));
      return null;
    }

    const containerA = document.createElement("div");
    const containerB = document.createElement("div");
    document.body.appendChild(containerA);
    document.body.appendChild(containerB);
    const rootA = createRoot(containerA);
    const rootB = createRoot(containerB);

    act(() => {
      rootA.render(
        <PortalRuntimeProvider scsName="profile" contextOwners={{ profile: "profile" }}>
          <Publisher />
        </PortalRuntimeProvider>
      );
    });
    act(() => {
      rootB.render(
        <PortalRuntimeProvider scsName="contactData" contextOwners={{ profile: "profile" }}>
          <Reader />
        </PortalRuntimeProvider>
      );
    });

    expect(seen[seen.length - 1]).toEqual({ name: "Grace" });
  });
});
