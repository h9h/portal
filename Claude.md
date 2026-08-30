# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This repository is currently an empty scaffold: only `specification.md`, `bunfig.toml`, and this file exist. There is no `package.json`, no source directory, and no tests yet, and nothing has been committed to git. Do not assume any build/lint/test commands exist until `package.json` is created — check for one before running `bun install`/`bun test`/etc.

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

- Dev server: `https://localhost:3000` (HTTPS enabled).
- Tests: `bun:test`, environment `node`, test root `./__tests__`, coverage enabled, ignoring `vendor/**`, `submodules/**`, `fixtures/**`.

