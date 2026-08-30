import { describe, test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getShellAssets } from "../../src/shell/bundle";

// Dynamically imports ESM source text by writing it to a real temp file
// first (a data: URL works for small snippets, but Bun rejects a
// react-sized one with "NameTooLong"), so this exercises the *same*
// spec-compliant static-export resolution a real browser performs (Bun's
// ESM loader, like V8/JavaScriptCore, rejects a named import that isn't in
// the module's statically-declared export list) — not a string/regex proxy
// for it. This is how the "react does not provide an export named
// 'useState'"-style bug (found via real-browser manual verification, see
// task-9-report.md) actually gets caught by a test.
async function importFromSource(code: string): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), "portal-shell-assets-"));
  const path = join(dir, "module.js");
  await Bun.write(path, code);
  return import(path);
}

describe("getShellAssets", () => {
  test("builds all four assets as non-empty JS text", async () => {
    const assets = await getShellAssets();
    expect(assets.reactJs.length).toBeGreaterThan(0);
    expect(assets.reactDomJs.length).toBeGreaterThan(0);
    expect(assets.runtimeJs.length).toBeGreaterThan(0);
    expect(assets.shellJs.length).toBeGreaterThan(0);
  });

  test("the react-dom bundle imports react as an external, not a bundled copy", async () => {
    const assets = await getShellAssets();
    expect(assets.reactDomJs).toMatch(/from\s*["']react["']/);
  });

  test("the runtime and shell bundles import react as an external", async () => {
    const assets = await getShellAssets();
    expect(assets.runtimeJs).toMatch(/from\s*["']react["']/);
    expect(assets.shellJs).toMatch(/from\s*["']react["']/);
  });

  test("the shell bundle imports @portal/runtime as an external, not inlined", async () => {
    const assets = await getShellAssets();
    expect(assets.shellJs).toMatch(/from\s*["']@portal\/runtime["']/);
  });

  // Regression test, found via real-browser manual verification (Step 13):
  // Bun's automatic JSX runtime transform compiles every JSX call to an
  // import from "react/jsx-runtime" (or, under a non-production build,
  // "react/jsx-dev-runtime") — a bare specifier distinct from "react" itself
  // and not one of the three the shell's import map declares (react,
  // react-dom/client, @portal/runtime; see bootstrap-html.ts). Left
  // unhandled, the browser throws "Failed to resolve module specifier" the
  // instant it tries to load the shell bundle. `bundle.ts` fixes this two
  // ways: `define` forces the production runtime choice regardless of the
  // build process's own NODE_ENV, and a Bun plugin inlines the jsx-runtime
  // module (safe: it's stateless helper functions, unlike "react" itself,
  // which must stay a shared singleton) instead of leaving it external.
  test("the shell bundle never imports a react/jsx-*-runtime specifier (inlined instead, and never the dev runtime)", async () => {
    const assets = await getShellAssets();
    expect(assets.shellJs).not.toContain("jsx-dev-runtime");
    expect(assets.shellJs).not.toContain("jsxDEV");
    expect(assets.shellJs).not.toMatch(/from\s*["']react\/jsx-runtime["']/);
  });

  // Regression test, found via real-browser manual verification (Step 13):
  // "react" and "react-dom/client" both ship as CommonJS
  // (`module.exports = {...}`). Bun's bundler cannot statically enumerate a
  // CJS module's exports, so the vendor entry points' original
  // `export * from "react"` form silently dropped every named export from
  // the *bundled* module's static ESM export list — only the explicitly
  // named `export { default } from "react"` survived. A real browser threw
  // "The requested module 'react' does not provide an export named
  // 'useState'" (and the same for react-dom's 'createRoot'). Fixed in
  // react-entry.ts/react-dom-entry.ts by re-exporting each name explicitly
  // off the runtime namespace object, which keeps every export statically
  // declared.
  test("the built react.js bundle exposes react's real named exports (not just default)", async () => {
    const assets = await getShellAssets();
    const mod = await importFromSource(assets.reactJs);
    expect(typeof mod.useState).toBe("function");
    expect(typeof mod.useEffect).toBe("function");
    expect(typeof mod.createContext).toBe("function");
    expect(typeof mod.createElement).toBe("function");
    expect(typeof mod.Component).toBe("function");
    expect(mod.default).toBeTruthy();
  });

  test("the built react-dom.js bundle exposes createRoot as a real named export", async () => {
    const assets = await getShellAssets();
    // react-dom.js imports "react" as an external bare specifier (by
    // design — one shared react.js, not a copy per bundle); resolve it here
    // to a real file so this dynamic import can actually execute, mirroring
    // what the browser's import map does at request time.
    const dir = await mkdtemp(join(tmpdir(), "portal-shell-assets-"));
    const reactPath = join(dir, "react.js");
    await Bun.write(reactPath, assets.reactJs);
    const patched = assets.reactDomJs.replaceAll(/from\s*["']react["']/g, `from "${new URL(`file://${reactPath}`)}"`);
    const mod = await importFromSource(patched);
    expect(typeof mod.createRoot).toBe("function");
  });

  test("repeated calls return the same cached build (do not rebuild every time)", async () => {
    const first = await getShellAssets();
    const second = await getShellAssets();
    expect(second).toBe(first);
  });
});
