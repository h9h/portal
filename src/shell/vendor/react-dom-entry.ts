// Same CJS/ESM interop gap as react-entry.ts (see its comment):
// "react-dom" and "react-dom/client" ship as CommonJS, so `export *` would
// silently drop their named exports once bundled for the browser.
//
// react-dom 19 ships "react-dom" and "react-dom/client" as two genuinely
// distinct CJS modules (verified against node_modules/react-dom/cjs/
// react-dom.production.js vs react-dom-client.production.js — neither wraps
// the other; react-dom/client's whole export surface is createRoot,
// hydrateRoot, version). Both bare specifiers resolve to this SAME built
// asset (see bootstrap-html.ts's import map), so the browser only ever
// instantiates one react-dom module — re-exporting the union of both real
// entry points' named exports here keeps that single-instance property
// while giving each specifier the exports it actually has upstream.
import * as ReactDOMModule from "react-dom";
import * as ReactDOMClientModule from "react-dom/client";

const ReactDOM = (ReactDOMModule as unknown as { default?: typeof ReactDOMModule }).default ?? ReactDOMModule;
const ReactDOMClient = (ReactDOMClientModule as unknown as { default?: typeof ReactDOMClientModule }).default ??
  ReactDOMClientModule;

export const { createRoot, hydrateRoot } = ReactDOMClient;
export const version: string | undefined = (ReactDOMClient as unknown as { version?: string }).version;

// react-dom's own (non-/client) named exports — not part of @types/react-dom
// in every version, so read off the untyped runtime object rather than a
// typed destructure, matching react-entry.ts's precedent for the
// undocumented internals symbol.
const ReactDOMRuntime = ReactDOM as unknown as Record<string, unknown>;
export const createPortal = ReactDOMRuntime.createPortal as typeof import("react-dom").createPortal;
export const flushSync = ReactDOMRuntime.flushSync as typeof import("react-dom").flushSync;
export const preconnect = ReactDOMRuntime.preconnect as typeof import("react-dom").preconnect;
export const prefetchDNS = ReactDOMRuntime.prefetchDNS as typeof import("react-dom").prefetchDNS;
export const preinit = ReactDOMRuntime.preinit as typeof import("react-dom").preinit;
export const preinitModule = ReactDOMRuntime.preinitModule as typeof import("react-dom").preinitModule;
export const preload = ReactDOMRuntime.preload as typeof import("react-dom").preload;
export const preloadModule = ReactDOMRuntime.preloadModule as typeof import("react-dom").preloadModule;
export const requestFormReset = ReactDOMRuntime.requestFormReset as typeof import("react-dom").requestFormReset;
export const unstable_batchedUpdates =
  ReactDOMRuntime.unstable_batchedUpdates as typeof import("react-dom").unstable_batchedUpdates;
export const useFormState = ReactDOMRuntime.useFormState;
export const useFormStatus = ReactDOMRuntime.useFormStatus as typeof import("react-dom").useFormStatus;
export const __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE =
  ReactDOMRuntime.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
