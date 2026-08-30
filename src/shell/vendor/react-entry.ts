// `react` ships as CommonJS (`module.exports = {...}`), and Bun's bundler
// cannot statically enumerate a CJS module's exports — so `export * from
// "react"` silently drops every named export from this file's *static* ESM
// export list once bundled for the browser (only an explicitly named
// `export { default } from "react"` survives). Verified against a real
// browser: with the blanket `export *` form, any SCS bundle or shell code
// doing `import { useState } from "react"` failed with "The requested
// module 'react' does not provide an export named 'useState'". Re-exporting
// each name explicitly — read off the same runtime namespace object — keeps
// every export statically declared while still resolving to react's real
// (CJS) values. The list mirrors react@19's actual runtime export surface
// (node_modules/react/cjs/react.production.js).
import * as ReactModule from "react";

const React = (ReactModule as unknown as { default?: typeof ReactModule }).default ?? ReactModule;

export default React;
export const {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  cache,
  cacheSignal,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = React;

// Undocumented internal react-dom's own browser bundle reads directly off
// the "react" namespace import to coordinate with react's shared dispatcher
// at runtime (verified in react-dom's bundled output) — not part of react's
// public typed surface (@types/react), so read off the untyped runtime
// object rather than the destructure above.
export const __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = (React as any)
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
