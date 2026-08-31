# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Portal is under active implementation. `package.json` exists with `dev`, `start`, `start:prod`, `test`, and `typecheck` scripts (see `GETTING_STARTED.md` for setup, including registering a GitHub OAuth App and env var handling). Source lives under `src/`, organized by concern: `auth/` (OAuth2 login, tokens, refresh, users), `rights/` (roles, route access, nav composition), `runtime/` (shared cross-SCS frontend context and portalFetch), `shell/` (SPA shell bundling/bootstrap), `scs/` (self-contained-system manifest registry), and `server.ts` (the backend-for-frontend entrypoint). Tests live under `__tests__/`, mirroring that structure; run `bun test` (currently 322 passing tests) and `bun run typecheck` before considering any change done.

## Specification

`specification.md` is the source of truth for what Portal does. Portal is a framework for building a web application with context-dependent views composed from a microservice / self-contained-system architecture. It provides: registration, login, password reset, rights management (role-based), rights-secured routing, and a rights/context-dependent navigation menu.

Any functional extension beyond `specification.md` must be written into and approved in `specification.md` before implementation.

## Tech stack and conventions

- TypeScript for both frontend and backend-for-frontend.
- Runtime and bundler: bun. Prefer bun's built-in functionality (test runner, bundler, server) over adding external libraries.
- Frontend framework: real `react`/`react-dom`, JSX via React's automatic runtime (see `bunfig.toml`/`tsconfig.json` — `jsx = "react-jsx"`, `jsxImportSource = "react"`). DOM-dependent tests use `@happy-dom/global-registrator`, scoped per-file via `__tests__/helpers/dom.ts`'s `withDom()` — never as a global `bun:test` preload.
- Auth: OAuth 2 against a configurable set of external authorization servers, selected explicitly by the user (e.g. "Sign in with GitHub"). GitHub is the first provider; Portal does not own user credentials. On first login, Portal provisions a local profile and initial role(s) for that identity — there is no separate sign-up form or password reset flow.
- Minimize external dependencies — ask before introducing a new one.
- Every feature needs a set of test cases.

## bunfig.toml

- Dev server: `http://localhost:3000` (plain HTTP; `[serve]` has no `https` setting — it only applies to Bun's built-in static-file dev server, not `src/server.ts`'s direct `Bun.serve()` call).
- Tests: `bun:test`, environment `node`, test root `./__tests__`, coverage enabled, ignoring `vendor/**`, `submodules/**`, `fixtures/**`.

