export type ShellAssets = {
  reactJs: string;
  reactDomJs: string;
  jsxRuntimeJs: string;
  runtimeJs: string;
  shellJs: string;
  themeCss: string;
};

export type ShellJsBundles = Omit<ShellAssets, "themeCss">;

let cachedBundles: Promise<ShellJsBundles> | null = null;
let cachedThemeCss: Promise<string> | null = null;
let cachedAssets: Promise<ShellAssets> | null = null;

// Lazy + memoized: createServer() stays synchronous (every existing test
// depends on that), so bundling happens on first request to any /_shell/*
// asset, not at server construction time. All builds share one cache across
// every createServer() instance in a process, since the bundled output only
// depends on this repo's own source files, never on server instance config.
export function getShellJsBundles(): Promise<ShellJsBundles> {
  if (!cachedBundles) {
    const build = (async () => {
      const [reactJs, reactDomJs, jsxRuntimeJs, runtimeJs, shellJs] = await Promise.all([
        buildOne(Bun.fileURLToPath(new URL("./vendor/react-entry.ts", import.meta.url))),
        buildOne(Bun.fileURLToPath(new URL("./vendor/react-dom-entry.ts", import.meta.url)), ["react"]),
        buildOne(Bun.fileURLToPath(new URL("./vendor/jsx-runtime-entry.ts", import.meta.url))),
        buildOne(Bun.fileURLToPath(new URL("../runtime/index.ts", import.meta.url)), ["react"]),
        buildOne(Bun.fileURLToPath(new URL("../frontend/shell-boot.tsx", import.meta.url)), [
          "react",
          "react-dom/client",
          "@portal/runtime",
        ]),
      ]);
      return { reactJs, reactDomJs, jsxRuntimeJs, runtimeJs, shellJs };
    })();
    // A transient failure (e.g. a passing but temporarily broken build)
    // must not poison every future call for the rest of the process's
    // life — clear the cache on rejection so the next request gets a
    // fresh build attempt. This only clears the cache slot; the rejection
    // itself still propagates to whoever is awaiting `build` right now.
    build.catch(() => {
      if (cachedBundles === build) cachedBundles = null;
    });
    cachedBundles = build;
  }
  return cachedBundles;
}

// theme.css is plain, hand-written CSS — no Bun.build needed, just a file
// read — and deliberately cached separately from the JS bundles above: a
// transient Bun.build failure must not 502 this static file read too, and a
// request for theme.css alone shouldn't wait on bundling five unrelated JS
// assets first.
export function getThemeCss(): Promise<string> {
  if (!cachedThemeCss) {
    const read = Bun.file(Bun.fileURLToPath(new URL("./theme.css", import.meta.url))).text();
    read.catch(() => {
      if (cachedThemeCss === read) cachedThemeCss = null;
    });
    cachedThemeCss = read;
  }
  return cachedThemeCss;
}

// Convenience combination of both caches above, for callers that want every
// shell asset at once (e.g. this file's own test suite). Memoized in its own
// right so repeated calls return the exact same object, not just equal ones.
export function getShellAssets(): Promise<ShellAssets> {
  if (!cachedAssets) {
    const combined = Promise.all([getShellJsBundles(), getThemeCss()]).then(([bundles, themeCss]) => ({
      ...bundles,
      themeCss,
    }));
    combined.catch(() => {
      if (cachedAssets === combined) cachedAssets = null;
    });
    cachedAssets = combined;
  }
  return cachedAssets;
}

// Test-only seam: the caches above are module-level singletons shared by
// every caller in the process (including every other test file that hits
// `GET /_shell/*`), so a test that wants to force a fresh build — e.g. to
// exercise the retry-after-failure path above — needs a way to clear them
// without waiting on execution order across files.
export function __resetShellAssetsCacheForTests(): void {
  cachedBundles = null;
  cachedThemeCss = null;
  cachedAssets = null;
}

async function buildOne(entrypoint: string, external: string[] = []): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    format: "esm",
    target: "browser",
    external,
    plugins: [inlineJsxRuntime],
    // Bun picks the dev JSX runtime (`jsxDEV` from "react/jsx-dev-runtime")
    // based on the *actual* process.env.NODE_ENV at build time, which is
    // unset under `bun --watch src/server.ts` — `define` forces the
    // production runtime for this build only, without mutating the server
    // process's own NODE_ENV.
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) {
    throw new Error(`bundle build failed for ${entrypoint}: ${result.logs.map((l) => l.message).join("; ")}`);
  }
  return await result.outputs[0].text();
}

// Bun's automatic JSX runtime transform compiles every JSX call to an import
// from "react/jsx-runtime" (or "react/jsx-dev-runtime") — a bare specifier
// distinct from "react" itself, per the standard react-jsx convention shared
// by Babel/esbuild/SWC/TS, not a Bun quirk. Marking "react" external, so the
// browser loads one shared copy via the import map (see bootstrap-html.ts),
// makes Bun treat that jsx-runtime subpath as external too, by package-name
// association — and the import map doesn't cover it, so the browser can't
// resolve it. This plugin redirects just that one subpath to its real
// file on disk so Bun inlines it instead: safe to duplicate across every
// bundle, since jsx-runtime is a handful of pure, stateless helper functions
// (no shared module state, no dependency on react's own internals) — unlike
// "react" itself, which must stay a true singleton for hooks/context to work.
const inlineJsxRuntime: Bun.BunPlugin = {
  name: "inline-react-jsx-runtime",
  setup(build) {
    build.onResolve({ filter: /^react\/jsx-(dev-)?runtime$/ }, (args) => ({
      path: Bun.resolveSync(args.path, import.meta.dir),
    }));
  },
};
