// Same CJS/ESM interop gap as react-entry.ts (see its comment): react's
// automatic-JSX-runtime module ships as CommonJS too, so `export * from
// "react/jsx-runtime"` would silently drop its named exports once bundled
// for the browser. Re-export each name explicitly off the runtime namespace
// object instead.
//
// Unlike react-entry.ts/react-dom-entry.ts, this entry point does NOT mark
// "react" external and produces a fully self-contained bundle: react's
// jsx-runtime module (verified in
// node_modules/react/cjs/react-jsx-runtime.production.js) is stateless
// helper functions with no dependency on react's own module-level state —
// see bundle.ts's inlineJsxRuntime plugin comment for why it's safe to
// duplicate/inline across every bundle that needs it, unlike "react" itself
// (which must stay a true singleton for hooks/context to work). This file is
// built into its own /_shell/jsx-runtime.js asset so a third-party SCS
// bundle's bare `import ... from "react/jsx-runtime"` — emitted by any
// standard automatic-JSX-runtime build, not just Portal's own — resolves via
// the shell's import map (see bootstrap-html.ts).
import * as JsxRuntimeModule from "react/jsx-runtime";

const JsxRuntime = (JsxRuntimeModule as unknown as { default?: typeof JsxRuntimeModule }).default ??
  JsxRuntimeModule;

export const { Fragment, jsx, jsxs } = JsxRuntime;
