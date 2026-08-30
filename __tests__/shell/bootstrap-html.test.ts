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
