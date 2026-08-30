// Same CJS/ESM interop gap as react-entry.ts (see its comment):
// "react-dom/client" ships as CommonJS too, so `export * from
// "react-dom/client"` silently drops its named exports once bundled for the
// browser. Re-export each name explicitly instead.
import * as ReactDOMClientModule from "react-dom/client";

const ReactDOMClient = (ReactDOMClientModule as unknown as { default?: typeof ReactDOMClientModule }).default ??
  ReactDOMClientModule;

export const { createRoot, hydrateRoot } = ReactDOMClient;
export const version: string | undefined = (ReactDOMClient as unknown as { version?: string }).version;
