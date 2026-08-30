import { describe, test, expect } from "bun:test";
import { renderShellHtml } from "../../src/shell/bootstrap-html";

describe("renderShellHtml", () => {
  test("includes an import map resolving react, react-dom/client, and @portal/runtime", () => {
    const html = renderShellHtml();
    expect(html).toContain('type="importmap"');
    expect(html).toContain('"react": "/_shell/react.js"');
    expect(html).toContain('"react-dom/client": "/_shell/react-dom.js"');
    expect(html).toContain('"@portal/runtime": "/_shell/runtime.js"');
  });

  // Fix-round regression test (whole-branch review): specification.md's
  // Client shell section documents the bare specifier as "react-dom" (not
  // "react-dom/client"), and any third-party SCS bundle built with the
  // standard automatic JSX runtime emits a bare `import ... from
  // "react/jsx-runtime"` that Portal's own bundles avoid only via a
  // dedicated build-time plugin an SCS author has no access to.
  test("also resolves the bare react-dom specifier and react/jsx-runtime", () => {
    const html = renderShellHtml();
    expect(html).toContain('"react-dom": "/_shell/react-dom.js"');
    expect(html).toContain('"react/jsx-runtime": "/_shell/jsx-runtime.js"');
  });

  test("includes a root mount element and the shell's own module script", () => {
    const html = renderShellHtml();
    expect(html).toContain('id="portal-root"');
    expect(html).toContain('<script type="module" src="/_shell/shell.js">');
  });

  test("is a complete, well-formed HTML document", () => {
    const html = renderShellHtml();
    expect(html.trim().toLowerCase().startsWith("<!doctype html>")).toBe(true);
  });
});
