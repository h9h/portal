import { describe, test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getShellAssets,
  getShellJsBundles,
  getThemeCss,
  __resetShellAssetsCacheForTests,
} from "../../src/shell/bundle";

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
  test("builds all five assets as non-empty JS text", async () => {
    const assets = await getShellAssets();
    expect(assets.reactJs.length).toBeGreaterThan(0);
    expect(assets.reactDomJs.length).toBeGreaterThan(0);
    expect(assets.jsxRuntimeJs.length).toBeGreaterThan(0);
    expect(assets.runtimeJs.length).toBeGreaterThan(0);
    expect(assets.shellJs.length).toBeGreaterThan(0);
  });

  test("also loads theme.css, containing the documented tokens and utility classes", async () => {
    const assets = await getShellAssets();
    expect(assets.themeCss.length).toBeGreaterThan(0);
    expect(assets.themeCss).toContain("--portal-color-primary");
    expect(assets.themeCss).toContain("--portal-space-4");
    expect(assets.themeCss).toContain(".portal-flex");
    expect(assets.themeCss).toContain(".portal-grid-cols-2");
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

  // Fix-round regression test (whole-branch review): a third-party SCS
  // bundle built with the standard automatic JSX runtime (Babel/esbuild/SWC/
  // TS all do this the same way) emits a bare `import { jsx } from
  // "react/jsx-runtime"` with no way to know it needs covering — unlike
  // Portal's own bundles, which sidestep this via bundle.ts's
  // inlineJsxRuntime plugin. This asset exists so the shell's import map
  // (bootstrap-html.ts) can resolve that bare specifier for any SCS.
  test("the built jsx-runtime.js bundle exposes jsx, jsxs, and Fragment as real named exports", async () => {
    const assets = await getShellAssets();
    const mod = await importFromSource(assets.jsxRuntimeJs);
    expect(typeof mod.jsx).toBe("function");
    expect(typeof mod.jsxs).toBe("function");
    expect(mod.Fragment).toBeTruthy();
  });

  // Fix-round regression test (whole-branch review): react-dom's own CJS
  // build reads this symbol directly off "react" at module-load time to
  // coordinate with react's shared dispatcher (see react-entry.ts's
  // comment) and does NOT throw if it's undefined — a missing/renamed
  // symbol here would only surface as a browser crash on first render, with
  // nothing in this suite catching it beforehand.
  test("the built react.js bundle exports the internals symbol react-dom reads at module-load time", async () => {
    const assets = await getShellAssets();
    const mod = await importFromSource(assets.reactJs);
    expect(mod.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE).toBeTruthy();
  });

  // Fix-round regression test (final-review re-review): "react-dom" and
  // "react-dom/client" are genuinely distinct CJS modules in react 19 — the
  // /client entry point's whole export surface is createRoot/hydrateRoot/
  // version, nothing else. Both bare specifiers resolve to this one asset
  // (bootstrap-html.ts), so it must expose the union of both entry points'
  // real exports, not just /client's.
  test("the built react-dom.js bundle exposes both react-dom/client's and react-dom's real named exports", async () => {
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
    // react-dom/client's surface
    expect(typeof mod.createRoot).toBe("function");
    expect(typeof mod.hydrateRoot).toBe("function");
    // react-dom's own (non-/client) surface — what a spec-conformant SCS
    // importing from the bare "react-dom" specifier actually needs
    expect(typeof mod.createPortal).toBe("function");
    expect(typeof mod.flushSync).toBe("function");
    expect(typeof mod.unstable_batchedUpdates).toBe("function");
  });

  test("repeated calls return the same cached build (do not rebuild every time)", async () => {
    const first = await getShellAssets();
    const second = await getShellAssets();
    expect(second).toBe(first);
  });

  // Fix-round regression test (whole-branch review): getShellAssets() used
  // to cache the *rejected* promise from a failed build, so one transient
  // Bun.build failure bricked every /_shell/* request for the rest of the
  // process's life. Forces one real Bun.build call to fail (only Bun.build
  // itself is stubbed, for exactly one call — buildOne, getShellAssets, and
  // every other build in this test still run for real), then confirms the
  // very next call gets a fresh, real, successful build rather than the
  // same cached rejection.
  test("a build failure does not poison the cache — the next call gets a fresh attempt", async () => {
    __resetShellAssetsCacheForTests();
    const originalBuild = Bun.build;
    let calls = 0;
    (Bun as unknown as { build: typeof Bun.build }).build = ((...args: Parameters<typeof Bun.build>) => {
      calls++;
      if (calls === 1) {
        return Promise.resolve({
          success: false,
          logs: [{ message: "simulated build failure" }],
          outputs: [],
        }) as unknown as ReturnType<typeof Bun.build>;
      }
      return originalBuild(...args);
    }) as typeof Bun.build;

    try {
      await expect(getShellAssets()).rejects.toThrow(/simulated build failure/);
      const assets = await getShellAssets();
      expect(assets.reactJs.length).toBeGreaterThan(0);
      expect(assets.shellJs.length).toBeGreaterThan(0);
    } finally {
      Bun.build = originalBuild;
    }
  });

  // Regression test for the fix that split theme.css's cache out from the
  // JS bundles': theme.css is a plain file read that cannot fail the same
  // way a Bun.build call can, so a JS build failure must not affect it —
  // getThemeCss() should still resolve normally even while
  // getShellJsBundles() is failing.
  test("getThemeCss() is unaffected by a getShellJsBundles() failure", async () => {
    __resetShellAssetsCacheForTests();
    const originalBuild = Bun.build;
    (Bun as unknown as { build: typeof Bun.build }).build = (() =>
      Promise.resolve({
        success: false,
        logs: [{ message: "simulated build failure" }],
        outputs: [],
      })) as unknown as typeof Bun.build;

    try {
      await expect(getShellJsBundles()).rejects.toThrow(/simulated build failure/);
      const themeCss = await getThemeCss();
      expect(themeCss).toContain("--portal-color-primary");
    } finally {
      Bun.build = originalBuild;
      __resetShellAssetsCacheForTests();
    }
  });
});
