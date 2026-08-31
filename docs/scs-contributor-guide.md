# Getting Started for SCS Contributors

This guide is for building a self-contained system (SCS) that plugs into
Portal — a separate service that owns one domain (its own data, its own
routes, its own React component(s)), registered with Portal via a manifest.
It assumes you've read `specification.md`'s Architecture section, which is
the actual contract; this guide is the practical walkthrough of building
against it.

Every code example here is real, working code from
[`scs-profile`](../scs-profile) (a sibling repo, assuming you've cloned it
next to this one) — a complete, minimal reference SCS that implements
everything this guide covers: a mounted page, an owned `GET`+`POST` data
endpoint, internal-token verification, and shared-context publishing. When
in doubt, read its `specification.md` and source directly — this guide
walks through the same ground at a slower pace, with the reasoning behind
each piece.

## What an SCS actually is

A plain HTTP server (any language, any framework — Portal has no opinion
here) exposing:

- `GET /.portal/manifest` — a JSON document describing what this SCS
  contributes: its routes, its nav entries, its shared-context keys.
- `GET /.portal/bundle.js` *(only if it mounts a page)* — a browser-loadable
  JS module exposing one React component export per mountable page.
- Whatever data endpoints its manifest declares — `GET` and/or `POST`,
  matching what its routes say.

Portal fetches your manifest at startup and periodically thereafter,
proxies composed requests to you server-to-server (attaching a signed
internal token so you know who's asking), and — for a page route — serves
your bundle to the browser, which mounts your component into Portal's
persistent frame.

You never talk to the browser directly, and the browser never talks to you
directly. Everything crosses through Portal.

## 1. The manifest

`GET /.portal/manifest` returns a JSON object. `scs-profile`'s is about as
small as this gets:

```json
{
  "name": "profile",
  "bundle": "/.portal/bundle.js",
  "routes": [
    { "path": "/profile", "requiredRoles": [], "methods": ["GET", "POST"], "component": "ProfileView" }
  ],
  "nav": [{ "label": "Profile", "path": "/profile", "requiredRoles": [] }],
  "publishesContext": ["profile"],
  "consumesContext": []
}
```

- **`name`**: your SCS's identity, used to namespace roles (`profile:editor`,
  `orders:admin`, etc.) and as the audience for internal tokens. Pick
  something stable — Portal doesn't care what it is, but role names and
  logs will reference it forever.
- **`routes`**: each entry is a path Portal will compose for you. `methods`
  defaults to `["GET"]` if omitted — only `GET` and `POST` are supported
  (no `PUT`/`PATCH`/`DELETE`, matching Portal's own API convention). A
  route with a `component` gets mounted as a page when its path matches the
  current URL; a route without one is a pure data endpoint, fetched by
  code inside an already-mounted component. **A route can only declare
  `component` if `"GET"` is in its `methods`** — nothing can ever navigate
  to a page whose route doesn't answer `GET`.
- **`requiredRoles`**: one list per route entry, covering every method that
  entry declares — there's no separate "read role" vs "write role" on the
  same path. If you want viewing open to everyone but editing role-gated,
  declare two entries at two different paths (e.g. `/orders` GET-only,
  `/orders/edit` POST-only with its own `requiredRoles`). `scs-profile`
  uses `requiredRoles: []` on `/profile` deliberately — viewing/editing a
  profile isn't gated by *role* at all, it's gated by *ownership* (see
  below), which is a different mechanism.
- **`nav`**: entries the shell's persistent header shows. Same
  `requiredRoles` semantics as routes, but nav entries are never
  collision-checked the way routes are — duplicate nav paths across SCSs
  are harmless, just a list of links.
- **`publishesContext`** / **`consumesContext`**: see §5, Shared context.

Portal rejects a malformed manifest as a whole (not partially) — a route
naming a nonexistent `component`, a `methods` value outside
`["GET", "POST"]`, or a `component` without `"GET"` in `methods` all fail
the whole manifest, and Portal keeps serving whatever it last successfully
fetched (or nothing, if it's never had a good one).

## 2. Building the bundle

`GET /.portal/bundle.js` needs to be a single ESM module exporting one
named export per mountable component (matching the `component` field in
your manifest routes). The tricky part isn't the component itself — it's
making sure it shares Portal's *one* React instance instead of shipping its
own copy.

Portal's shell page declares an import map resolving `"react"`,
`"react-dom"`, and `"@portal/runtime"` to its own first-party assets. Your
bundle needs to treat those three as *external* — not bundle them in — so
the browser resolves them through that same import map. `scs-profile`'s
`src/bundle.ts` does this with `Bun.build`:

```ts
const result = await Bun.build({
  entrypoints: [entrypoint],
  format: "esm",
  target: "browser",
  external: ["react", "react-dom", "@portal/runtime"],
  plugins: [inlineJsxRuntime],
  define: { "process.env.NODE_ENV": '"production"' },
});
```

One wrinkle: React's automatic JSX transform compiles every JSX
expression into an import from `"react/jsx-runtime"` — a *different* bare
specifier than `"react"` itself. Marking `"react"` external makes your
bundler treat `"react/jsx-runtime"` as external too (by package-name
association), but Portal's import map doesn't cover that specific
subpath, so the browser can't resolve it. `scs-profile`'s `bundle.ts` fixes
this with a small resolve-plugin that redirects just that one specifier to
its real file on disk, so it gets inlined instead of left external:

```ts
const inlineJsxRuntime: Bun.BunPlugin = {
  name: "inline-react-jsx-runtime",
  setup(build) {
    build.onResolve({ filter: /^react\/jsx-(dev-)?runtime$/ }, (args) => ({
      path: Bun.resolveSync(args.path, import.meta.dir),
    }));
  },
};
```

If you're not using Bun to build, the equivalent applies with any
bundler: mark `react`/`react-dom`/`@portal/runtime` external, and make sure
whatever your JSX transform imports for its runtime helpers ends up
inlined, not left as an unresolvable bare specifier.

### Typechecking against `@portal/runtime` in your own repo

`@portal/runtime` isn't a real package you can `npm install` — it's
Portal's own module, resolved by the browser's import map at actual
runtime. Your repo has no access to it at build/test time. `scs-profile`
solves this with a small local stand-in
(`src/portal-runtime-stub.ts`) wired through `tsconfig.json`'s `paths`:

```json
{
  "compilerOptions": {
    "paths": {
      "@portal/runtime": ["./src/portal-runtime-stub.ts"]
    }
  }
}
```

Bun (and most modern bundlers) resolve `paths` at both typecheck time and
run time — but your bundle build's `external` list still takes precedence
over path resolution when actually producing `/.portal/bundle.js`, so the
stub never ends up in your shipped output; only the real bare specifier
does, for the browser to resolve. The stub itself just needs to be
type-shaped correctly and behave sanely enough for your own tests — it's
never shipped:

```ts
export async function portalFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

export function usePublishContext(_key: string): (value: unknown) => void {
  return () => {};
}
```

(`scs-profile`'s actual stub goes a little further — it records publish
calls so its own tests can assert on them. See its source for that detail
if you need to test context-publishing yourself.)

## 3. Verifying the internal token

Every composed request Portal makes to you carries `Authorization: Bearer
<token>` — a signed, short-lived token identifying who's asking. There's no
shared library for this (Portal and every SCS are independent codebases,
possibly in different languages) — you re-implement verification yourself,
against a secret shared out-of-band (`INTERNAL_TOKEN_SECRET`, set to the
exact same value on both sides).

The token is HS256, JWT-shaped:
`base64url(header).base64url(payload).base64url(hmac-sha256-signature)`,
carrying `{ sub, roles, aud, exp }`:

- `sub`: the userId. This is your ownership key — "is this the caller's
  own record" is *your* job to check, using this field, not Portal's.
- `roles`: the caller's roles within your own namespace (Portal never
  forwards `portal:`-prefixed roles or another SCS's roles to you).
- `aud`: the exact base URL Portal has you registered at. **Check this.**
  It stops a token minted for a different SCS from being replayed against
  you.
- `exp`: seconds since epoch. Reject if it's passed.

`scs-profile`'s `src/internal-token.ts` is the reference verification —
read it directly; the essential shape is:

1. Split on `.`; reject anything that isn't exactly 3 parts.
2. Recompute the HMAC-SHA256 signature over `header.payload` with your
   shared secret; compare with a **constant-time** comparison (Node's
   `crypto.timingSafeEqual`), never `===` — signature comparison is exactly
   the kind of check a timing side-channel can leak.
3. Decode and validate the payload's shape (`sub`/`aud` strings, `exp`
   number, `roles` a string array) — reject anything malformed.
4. Reject if `exp` has passed.
5. Reject if `aud` doesn't match your own configured base URL.

Any failure → treat the caller as unauthenticated (`401`, no further
detail — don't tell a caller *why* their token was rejected; it doesn't
help a legitimate caller and it helps an attacker).

**A real gotcha worth knowing up front:** your own configured base URL
(`SCS_BASE_URL` in `scs-profile`'s case) must exactly match whatever base
URL Portal's `PORTAL_SCS_URLS` registers you under — trailing slash,
`localhost` vs `127.0.0.1`, the port, all of it. A mismatch means Portal
signs tokens for one string and you check against another, and *every*
request gets rejected with no client-visible explanation (by design — see
above). This bit `scs-profile` during its own development; its server logs
a diagnostic hint on any token rejection specifically because of this, and
its own `specification.md` documents the requirement explicitly. Do the
same in your own SCS — an undiagnosable, deliberately-silent 401 is one of
the least fun bugs to chase down.

## 4. Data endpoints: ownership vs. roles

Portal's role check answers "does this class of user reach this path at
all." It does not answer "which specific record may they touch" — that's
entirely your job, using the `sub` claim. `scs-profile`'s `/profile` route
declares `requiredRoles: []` (any authenticated user may call it), and its
own handler always reads/writes the row keyed by the *caller's own*
`sub` — there is no code path by which one user can name another user's
data. If your SCS needs finer-grained access (e.g. "any team member can
view, only the owner can edit"), that logic lives in your own handler too;
Portal's manifest-level role check is a coarse gate, not a full
authorization system.

For a `POST`, Portal forwards the request body and `Content-Type` header
to you unmodified — validate the body yourself (shape, types) before
writing anything; a malformed body should be a `400`, not a crash or a
silent no-op.

## 5. Shared context (optional)

If your SCS is the natural owner of something other SCSs might want to
show without knowing anything about your routes or database — a display
name, an avatar, anything display-only — declare it in `publishesContext`,
and call `usePublishContext(key)` from your mounted component once you
have the value. This is a *browser-only* mechanism: it never touches
Portal's server, never crosses a network boundary, and doesn't survive a
full page reload — it's just a small pub/sub store shared by every
mounted component in the current page, matching however many SCSs happen
to be composed together in a given session. `scs-profile` publishes
`{ displayName, avatarUrl }` under the key `"profile"` once both its own
data and Portal's `/me` have loaded — see its `ProfileView` component for
the exact pattern (fetch, then publish only once you have real data — never
publish partial or stale values).

## 6. Registering and running locally

1. Start your SCS on its own port (`scs-profile` uses `4001`, to avoid
   colliding with Portal's `3000`).
2. Set `INTERNAL_TOKEN_SECRET` on your SCS to the exact same value Portal's
   own `INTERNAL_TOKEN_SECRET` is set to.
3. Add your SCS's base URL to Portal's `PORTAL_SCS_URLS` env var
   (comma-separated if there's more than one SCS), then restart Portal so
   it picks up the change.
4. Sign in to Portal in a browser; your nav entry and routes should now be
   live.

`scs-profile`'s own `specification.md` (`Running it` section) has the
exact env var names and a worked example of this whole sequence — copy it.

## Where to go from here

Clone `scs-profile`, run its own tests (`bun test`), read its five source
files in order (`internal-token.ts` → `db.ts` → `manifest.ts` +
`bundle.ts` → `profile-view.tsx` → `server.ts`) — each is small and does
exactly one thing, and together they're the smallest complete example of
everything in this guide. Copy the parts you need; it's meant to be a
starting point, not a framework to depend on.
