// Static bootstrap page: no per-request data. The /_shell/* URLs below are
// served by server.ts's asset-serving route (see src/shell/bundle.ts).
export function renderShellHtml(): string {
  const importMap = {
    imports: {
      react: "/_shell/react.js",
      "react-dom": "/_shell/react-dom.js",
      "react-dom/client": "/_shell/react-dom.js",
      "react/jsx-runtime": "/_shell/jsx-runtime.js",
      "@portal/runtime": "/_shell/runtime.js",
    },
  };
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Portal</title>
<style>body{margin:0}</style>
<script type="importmap">${JSON.stringify(importMap, null, 2)}</script>
</head>
<body>
<div id="portal-root"></div>
<script type="module" src="/_shell/shell.js"></script>
</body>
</html>`;
}
