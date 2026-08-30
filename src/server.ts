export type ServerOptions = {
  port?: number;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createServer(opts: ServerOptions = {}) {
  return Bun.serve({
    port: opts.port ?? 3000,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return json({ status: "ok" });
      }
      return json({ error: "not found" }, 404);
    },
  });
}

if (import.meta.main) {
  const server = createServer({ port: Number(process.env.PORT ?? 3000) });
  console.log(`Portal listening on ${server.url}`);
}
