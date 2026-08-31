# Shared Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a small, hand-written CSS file (design tokens + a minimal flex/grid utility layer) from Portal, linked once in the shell's bootstrap HTML, so every mounted SCS component gets consistent colors/spacing/typography for free — no import, no build-time dependency. Portal's own persistent frame becomes the first consumer, replacing its hardcoded style values with references to the same tokens.

**Architecture:** `src/shell/theme.css` is a static file (no `Bun.build`, no bundling — it's plain CSS) read once and cached alongside the existing shell assets in `getShellAssets()`. `server.ts`'s existing `/_shell/*` asset route serves it as `GET /_shell/theme.css` (public, unauthenticated, same reasoning and same ETag/304 revalidation pattern as the JS assets). `bootstrap-html.ts` links it once. `portal-frame.tsx` swaps its literal style values for `var(--portal-x, <same literal as fallback>)` references — a value-level change only, no structural/architectural change to the frame itself.

**Tech Stack:** Bun, TypeScript, plain CSS (no framework, no preprocessor). No new dependencies.

**Spec:** `specification.md` (Architecture → Client shell: **Shared theme**, and the **Portal frame (persistent chrome)** paragraph it extends)

## Global Constraints

- `theme.css` defines exactly the tokens and utility classes specification.md's **Shared theme** subsection lists — copy that CSS block verbatim, don't invent additional tokens not in the spec. (`specification.md`)
- `GET /_shell/theme.css` is public (no authentication check), matching every other `/_shell/*` asset. (`specification.md`)
- Every token reference in `portal-frame.tsx` must include a literal fallback value (`var(--portal-x, <fallback>)`), matching the fallback each replaced literal already had — this is the same requirement the spec places on any SCS consuming these tokens. (`specification.md`)
- No new dependencies, no CSS framework, no build-step change beyond what's described here. (`specification.md`, `CLAUDE.md`)
- Every feature needs a set of test cases, run via `bun:test`. (`CLAUDE.md`)

## File Structure

- `src/shell/theme.css` — **new**: the token/utility stylesheet.
- `src/shell/bundle.ts` — **modify**: `ShellAssets` gains `themeCss: string`; `getShellAssets()` reads and caches the new file alongside the existing builds.
- `src/server.ts` — **modify**: the `/_shell/*` asset route also serves `theme.css`, with the correct content type and the same ETag/304 handling the JS assets already have.
- `src/shell/bootstrap-html.ts` — **modify**: links `theme.css` once.
- `src/frontend/portal-frame.tsx` — **modify**: literal style values become `var(--portal-x, <same literal>)` references; the placeholder logo SVG's two hardcoded colors do too.
- Test files: extend `__tests__/shell/bundle.test.ts`, `__tests__/server/composition.test.ts`, `__tests__/shell/bootstrap-html.test.ts`, `__tests__/frontend/portal-frame.test.tsx`.

---

### Task 1: Serve `theme.css`

**Files:**
- Create: `src/shell/theme.css`
- Modify: `src/shell/bundle.ts`, `src/server.ts`, `src/shell/bootstrap-html.ts`
- Test: extend `__tests__/shell/bundle.test.ts`, `__tests__/server/composition.test.ts`, `__tests__/shell/bootstrap-html.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ShellAssets.themeCss: string`; `GET /_shell/theme.css` → `200`, `Content-Type: text/css; charset=utf-8`, same ETag/304 behavior as the JS assets. Task 2 doesn't consume this directly (it just references the token/class *names*, which are a contract, not a runtime dependency) — this task is self-contained.

- [ ] **Step 1: Create the stylesheet**

Create `src/shell/theme.css`:

```css
/* Portal's shared theme: design tokens + a small flex/grid utility layer.
   Served publicly (no auth) at GET /_shell/theme.css and linked once by the
   shell's bootstrap HTML — see specification.md, Client shell: Shared
   theme, for the stability contract these names carry (adding a token or
   class is backward compatible; renaming/removing one is not). */

:root {
  --portal-color-primary: #4338ca;
  --portal-color-primary-contrast: #ffffff;
  --portal-color-text: #1a1a1a;
  --portal-color-text-muted: #666666;
  --portal-color-border: #dddddd;
  --portal-color-surface: #ffffff;
  --portal-color-danger: #b91c1c;

  --portal-font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  --portal-font-size-base: 1rem;
  --portal-font-size-small: 0.85rem;

  --portal-space-1: 0.25rem;
  --portal-space-2: 0.5rem;
  --portal-space-3: 0.75rem;
  --portal-space-4: 1rem;
  --portal-space-6: 1.5rem;

  --portal-radius: 6px;
  --portal-border-width: 1px;
}

.portal-flex { display: flex; }
.portal-flex-col { display: flex; flex-direction: column; }
.portal-flex-wrap { flex-wrap: wrap; }
.portal-items-center { align-items: center; }
.portal-justify-between { justify-content: space-between; }
.portal-gap-1 { gap: var(--portal-space-1); }
.portal-gap-2 { gap: var(--portal-space-2); }
.portal-gap-3 { gap: var(--portal-space-3); }
.portal-gap-4 { gap: var(--portal-space-4); }

.portal-grid { display: grid; }
.portal-grid-cols-2 { grid-template-columns: repeat(2, 1fr); }
.portal-grid-cols-3 { grid-template-columns: repeat(3, 1fr); }
```

- [ ] **Step 2: Write the failing tests**

In `__tests__/shell/bundle.test.ts`, add (anywhere in the `describe("getShellAssets", ...)` block, e.g. after the existing `"builds all five assets as non-empty JS text"` test):

```ts
  test("also loads theme.css, containing the documented tokens and utility classes", async () => {
    const assets = await getShellAssets();
    expect(assets.themeCss.length).toBeGreaterThan(0);
    expect(assets.themeCss).toContain("--portal-color-primary");
    expect(assets.themeCss).toContain("--portal-space-4");
    expect(assets.themeCss).toContain(".portal-flex");
    expect(assets.themeCss).toContain(".portal-grid-cols-2");
  });
```

In `__tests__/server/composition.test.ts`, find:

```ts
describe("GET /_shell/*", () => {
  test("serves each asset unauthenticated, with a JS content-type", async () => {
    for (const name of ["react", "react-dom", "jsx-runtime", "runtime", "shell"]) {
      const response = await fetch(`${portal.url}_shell/${name}.js`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
      const body = await response.text();
      expect(body.length).toBeGreaterThan(0);
    }
  });
```

Add a new test right after it (leave the existing test's JS-only loop unchanged):

```ts

  test("serves theme.css unauthenticated, with a CSS content-type", async () => {
    const response = await fetch(`${portal.url}_shell/theme.css`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("--portal-color-primary");
  });
```

In `__tests__/shell/bootstrap-html.test.ts`, add a new test after the existing body-margin-reset test, before the `describe`'s closing `});`:

```ts

  test("links the shared theme stylesheet", () => {
    const html = renderShellHtml();
    expect(html).toContain('<link rel="stylesheet" href="/_shell/theme.css"');
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test __tests__/shell/bundle.test.ts __tests__/server/composition.test.ts __tests__/shell/bootstrap-html.test.ts`
Expected: FAIL — `themeCss` doesn't exist on `ShellAssets` yet, `/_shell/theme.css` 404s, and the `<link>` tag isn't in the HTML yet.

- [ ] **Step 4: Implement**

In `src/shell/bundle.ts`, replace:

```ts
export type ShellAssets = {
  reactJs: string;
  reactDomJs: string;
  jsxRuntimeJs: string;
  runtimeJs: string;
  shellJs: string;
};
```

with:

```ts
export type ShellAssets = {
  reactJs: string;
  reactDomJs: string;
  jsxRuntimeJs: string;
  runtimeJs: string;
  shellJs: string;
  themeCss: string;
};
```

Replace:

```ts
      const [reactJs, reactDomJs, jsxRuntimeJs, runtimeJs, shellJs] = await Promise.all([
        buildOne(new URL("./vendor/react-entry.ts", import.meta.url).pathname),
        buildOne(new URL("./vendor/react-dom-entry.ts", import.meta.url).pathname, ["react"]),
        buildOne(new URL("./vendor/jsx-runtime-entry.ts", import.meta.url).pathname),
        buildOne(new URL("../runtime/index.ts", import.meta.url).pathname, ["react"]),
        buildOne(new URL("../frontend/shell-boot.tsx", import.meta.url).pathname, [
          "react",
          "react-dom/client",
          "@portal/runtime",
        ]),
      ]);
      return { reactJs, reactDomJs, jsxRuntimeJs, runtimeJs, shellJs };
```

with:

```ts
      const [reactJs, reactDomJs, jsxRuntimeJs, runtimeJs, shellJs, themeCss] = await Promise.all([
        buildOne(new URL("./vendor/react-entry.ts", import.meta.url).pathname),
        buildOne(new URL("./vendor/react-dom-entry.ts", import.meta.url).pathname, ["react"]),
        buildOne(new URL("./vendor/jsx-runtime-entry.ts", import.meta.url).pathname),
        buildOne(new URL("../runtime/index.ts", import.meta.url).pathname, ["react"]),
        buildOne(new URL("../frontend/shell-boot.tsx", import.meta.url).pathname, [
          "react",
          "react-dom/client",
          "@portal/runtime",
        ]),
        // theme.css is plain, hand-written CSS — no Bun.build needed, just
        // read the file. Cached alongside the built assets for the same
        // reason: its content never changes without a redeploy.
        Bun.file(new URL("./theme.css", import.meta.url).pathname).text(),
      ]);
      return { reactJs, reactDomJs, jsxRuntimeJs, runtimeJs, shellJs, themeCss };
```

In `src/server.ts`, replace:

```ts
      const shellAssetMatch = url.pathname.match(/^\/_shell\/(react|react-dom|jsx-runtime|runtime|shell)\.js$/);
      if (shellAssetMatch && req.method === "GET") {
        try {
          const assets = await getShellAssets();
          const byName: Record<string, string> = {
            react: assets.reactJs,
            "react-dom": assets.reactDomJs,
            "jsx-runtime": assets.jsxRuntimeJs,
            runtime: assets.runtimeJs,
            shell: assets.shellJs,
          };
          const body = byName[shellAssetMatch[1]];
          // getShellAssets() is memoized for the life of the process (its
          // output never changes without a redeploy), but there's no
          // versioned/hashed URL scheme yet — ETag + no-cache forces
          // revalidation on every request instead of either re-sending
          // ~500KB of react-dom on every navigation or blind long-term
          // caching that can't be busted. A matching If-None-Match short-
          // circuits to a bodyless 304, which is the only part that
          // actually saves the re-download; the header alone does not.
          const etag = `"${Bun.hash(body).toString(16)}"`;
          if (req.headers.get("If-None-Match") === etag) {
            return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache" } });
          }
          return new Response(body, {
            status: 200,
            headers: {
              "Content-Type": "text/javascript; charset=utf-8",
              ETag: etag,
              "Cache-Control": "no-cache",
            },
          });
        } catch (err) {
          console.error("shell asset build failed", err);
          return json({ error: "shell asset build failed" }, 502);
        }
      }
```

with:

```ts
      const shellAssetMatch = url.pathname.match(/^\/_shell\/(react|react-dom|jsx-runtime|runtime|shell|theme)\.(js|css)$/);
      if (shellAssetMatch && req.method === "GET") {
        try {
          const assets = await getShellAssets();
          const byName: Record<string, { body: string; contentType: string }> = {
            react: { body: assets.reactJs, contentType: "text/javascript; charset=utf-8" },
            "react-dom": { body: assets.reactDomJs, contentType: "text/javascript; charset=utf-8" },
            "jsx-runtime": { body: assets.jsxRuntimeJs, contentType: "text/javascript; charset=utf-8" },
            runtime: { body: assets.runtimeJs, contentType: "text/javascript; charset=utf-8" },
            shell: { body: assets.shellJs, contentType: "text/javascript; charset=utf-8" },
            theme: { body: assets.themeCss, contentType: "text/css; charset=utf-8" },
          };
          const asset = byName[shellAssetMatch[1]];
          // getShellAssets() is memoized for the life of the process (its
          // output never changes without a redeploy), but there's no
          // versioned/hashed URL scheme yet — ETag + no-cache forces
          // revalidation on every request instead of either re-sending
          // ~500KB of react-dom on every navigation or blind long-term
          // caching that can't be busted. A matching If-None-Match short-
          // circuits to a bodyless 304, which is the only part that
          // actually saves the re-download; the header alone does not.
          const etag = `"${Bun.hash(asset.body).toString(16)}"`;
          if (req.headers.get("If-None-Match") === etag) {
            return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache" } });
          }
          return new Response(asset.body, {
            status: 200,
            headers: {
              "Content-Type": asset.contentType,
              ETag: etag,
              "Cache-Control": "no-cache",
            },
          });
        } catch (err) {
          console.error("shell asset build failed", err);
          return json({ error: "shell asset build failed" }, 502);
        }
      }
```

In `src/shell/bootstrap-html.ts`, replace:

```ts
<meta charset="utf-8" />
<title>Portal</title>
<style>body{margin:0}</style>
<script type="importmap">${JSON.stringify(importMap, null, 2)}</script>
</head>
```

with:

```ts
<meta charset="utf-8" />
<title>Portal</title>
<style>body{margin:0}</style>
<link rel="stylesheet" href="/_shell/theme.css" />
<script type="importmap">${JSON.stringify(importMap, null, 2)}</script>
</head>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test __tests__/shell/bundle.test.ts __tests__/server/composition.test.ts __tests__/shell/bootstrap-html.test.ts`
Expected: PASS, all tests including the new ones.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/shell/theme.css src/shell/bundle.ts src/server.ts src/shell/bootstrap-html.ts __tests__/shell/bundle.test.ts __tests__/server/composition.test.ts __tests__/shell/bootstrap-html.test.ts
git commit -m "feat: serve a shared theme stylesheet (design tokens + flex/grid utilities)"
```

---

### Task 2: Portal's own frame consumes the shared theme

**Files:**
- Modify: `src/frontend/portal-frame.tsx`
- Test: extend `__tests__/frontend/portal-frame.test.tsx`

**Interfaces:**
- Consumes: the token/class names Task 1's `theme.css` defines (by convention/contract only — this task has no code dependency on Task 1's files; it would still typecheck and run even if Task 1 hadn't landed, since these are just CSS strings, not imports).
- Produces: no change to `PortalFrame`'s props, behavior, or exports — this task changes style *values* only.

- [ ] **Step 1: Write the failing test**

**Important — do not test this via the rendered DOM.** happy-dom's `CSSStyleDeclaration` silently drops any style property whose value contains `var(...)` — verified directly: setting `style.borderBottom` (or any property) to a string containing `var(--x, y)` results in that property never appearing in `outerHTML`/`getAttribute("style")`/the `.style.*` getters at all, with no error. This isn't specific to shorthand properties — even a single simple property like `color` is dropped the same way. So a DOM-based assertion (`element.style.borderBottom`, `container.innerHTML`, etc.) can never observe whether the component actually renders a `var(...)` value in this test environment — it would either always fail (false negative) or, worse, silently pass for the wrong reason. Test the source text directly instead — a small, honest check that the literal-value swap actually happened, distinct from (and not a replacement for) the manual visual check in Step 7, which is what actually proves this renders correctly in a real browser.

Add to `__tests__/frontend/portal-frame.test.tsx`, inside `describe("PortalFrame", ...)` (anywhere — e.g. right after the first test, `"renders a placeholder logo linking to /, ..."`):

```tsx
  test("the header's border and padding reference the shared theme's tokens, each with the same literal fallback it had before", async () => {
    // Not a DOM-rendering test — see the note above Step 1 in this task's
    // brief for why: happy-dom's CSSStyleDeclaration silently drops any
    // style value containing var(...), so this checks the component's own
    // source text instead.
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../../src/frontend/portal-frame.tsx", import.meta.url), "utf8");
    expect(source).toContain("var(--portal-color-border, #ddd)");
    expect(source).toContain("var(--portal-space-3, 0.75rem)");
    expect(source).toContain("var(--portal-space-6, 1.5rem)");
    expect(source).toContain("var(--portal-color-primary, #4338ca)");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test __tests__/frontend/portal-frame.test.tsx`
Expected: FAIL — the header's inline styles are still literal values, not `var(...)` references.

- [ ] **Step 3: Swap literal values for token references**

In `src/frontend/portal-frame.tsx`, replace:

```tsx
const styles = {
  page: { display: "flex", flexDirection: "column", minHeight: "100vh" },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    padding: "0.75rem 1.5rem",
    borderBottom: "1px solid #ddd",
  },
  logo: { display: "flex", alignItems: "center", gap: "0.5rem", textDecoration: "none", color: "inherit" },
  nav: { display: "flex", gap: "1rem", flexWrap: "wrap" },
  authControls: { display: "flex", alignItems: "center", gap: "0.75rem" },
  main: { flex: 1, padding: "1.5rem" },
  footer: { padding: "1rem 1.5rem", borderTop: "1px solid #ddd", fontSize: "0.85rem", color: "#666" },
} satisfies Record<string, CSSProperties>;
```

with:

```tsx
const styles = {
  page: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
    fontFamily: "var(--portal-font-family, system-ui, -apple-system, 'Segoe UI', sans-serif)",
    color: "var(--portal-color-text, #1a1a1a)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--portal-space-4, 1rem)",
    padding: "var(--portal-space-3, 0.75rem) var(--portal-space-6, 1.5rem)",
    borderBottom: "var(--portal-border-width, 1px) solid var(--portal-color-border, #ddd)",
  },
  logo: {
    display: "flex",
    alignItems: "center",
    gap: "var(--portal-space-2, 0.5rem)",
    textDecoration: "none",
    color: "inherit",
  },
  nav: { display: "flex", gap: "var(--portal-space-4, 1rem)", flexWrap: "wrap" },
  authControls: { display: "flex", alignItems: "center", gap: "var(--portal-space-3, 0.75rem)" },
  main: { flex: 1, padding: "var(--portal-space-6, 1.5rem)" },
  footer: {
    padding: "var(--portal-space-4, 1rem) var(--portal-space-6, 1.5rem)",
    borderTop: "var(--portal-border-width, 1px) solid var(--portal-color-border, #ddd)",
    fontSize: "var(--portal-font-size-small, 0.85rem)",
    color: "var(--portal-color-text-muted, #666)",
  },
} satisfies Record<string, CSSProperties>;
```

Replace:

```tsx
function PortalLogoPlaceholder() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" role="img" aria-label="Portal logo placeholder">
      <rect width="28" height="28" rx="6" fill="#4338ca" />
      <text x="14" y="19" textAnchor="middle" fontSize="14" fontFamily="sans-serif" fill="#fff">
        P
      </text>
    </svg>
  );
}
```

with:

```tsx
function PortalLogoPlaceholder() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" role="img" aria-label="Portal logo placeholder">
      <rect width="28" height="28" rx="6" fill="var(--portal-color-primary, #4338ca)" />
      <text
        x="14"
        y="19"
        textAnchor="middle"
        fontSize="14"
        fontFamily="sans-serif"
        fill="var(--portal-color-primary-contrast, #fff)"
      >
        P
      </text>
    </svg>
  );
}
```

Note what did **not** change: `styles.page` gained two new properties (`fontFamily`, `color`) that didn't exist before — these aren't a "swap," they're new, deliberate additions so the token-driven typography/text-color cascades to the whole frame (and, by inheritance, into mounted SCS content that doesn't set its own). Every other change in this step is a literal-value-for-`var()` swap only; no property name, no layout behavior, and no structural JSX changes anywhere in this file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test __tests__/frontend/portal-frame.test.tsx`
Expected: PASS, all tests — both the new one and every pre-existing test in the file (none of them assert on literal style *values*, only on rendered text/hrefs/behavior, so this value-only change doesn't touch what they check).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/portal-frame.tsx __tests__/frontend/portal-frame.test.tsx
git commit -m "feat: consume the shared theme's tokens in Portal's own frame"
```

- [ ] **Step 7: Manual visual check**

No automated test can confirm the page actually *looks* right (CSS custom property fallback resolution vs. actual `theme.css` values matching is implicitly covered by the token names being identical strings in both files, but a visual sanity check is still worth doing since this task's whole point is appearance). Run `bun run dev`, load the app in a browser, and confirm the header/footer render identically to before this change (same purple logo, same spacing, same border) — the change should be visually invisible, since every fallback value is the same as the literal it replaced. Report the result (pass/fail) in this task's completion note.
