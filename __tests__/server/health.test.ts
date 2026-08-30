import { describe, test, expect, afterAll } from "bun:test";
import { createServer } from "../../src/server";
import { createDatabase } from "../../src/db";

describe("GET /health", () => {
  const server = createServer({ port: 0, db: createDatabase(":memory:") });
  afterAll(() => server.stop());

  test("returns ok status", async () => {
    const response = await fetch(`${server.url}health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });
});

describe("GET (unmarked, no manifestRegistry configured)", () => {
  // Fix-round regression test (whole-branch review): the shell-HTML
  // fallback branch in src/server.ts is structurally NOT gated on
  // manifestRegistry being configured, but every other test exercising it
  // does so against a server that DOES have one — flagged as the property
  // most likely to regress silently (e.g. a future edit that "helpfully"
  // adds a `manifestRegistry &&` guard to match the block below it).
  const server = createServer({ port: 0, db: createDatabase(":memory:") });
  afterAll(() => server.stop());

  test("still serves the shell HTML for an unmarked GET to an arbitrary unknown path", async () => {
    const response = await fetch(`${server.url}some-arbitrary-unknown-path`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(await response.text()).toContain('id="portal-root"');
  });
});
