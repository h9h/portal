// Static bootstrap page: no per-request data. The four /_shell/* URLs below
// don't exist as real endpoints until a later task adds them (see this
// plan's Task 9) — this file only needs to produce correct, stable HTML
// structure; it doesn't need those endpoints to work yet.
export function renderShellHtml(): string {
  const importMap = {
    imports: {
      react: "/_shell/react.js",
      "react-dom/client": "/_shell/react-dom.js",
      "@portal/runtime": "/_shell/runtime.js",
    },
  };
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Portal</title>
<script type="importmap">${JSON.stringify(importMap, null, 2)}</script>
</head>
<body>
<div id="portal-root"></div>
<script type="module" src="/_shell/shell.js"></script>
</body>
</html>`;
}
