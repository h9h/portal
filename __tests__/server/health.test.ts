import { describe, test, expect, afterAll } from "bun:test";
import { createServer } from "../../src/server";

describe("GET /health", () => {
  const server = createServer({ port: 0 });
  afterAll(() => server.stop());

  test("returns ok status", async () => {
    const response = await fetch(`${server.url}health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });
});
