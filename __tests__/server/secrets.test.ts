import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "../../src/server";
import { createDatabase } from "../../src/db";

const originalNodeEnv = process.env.NODE_ENV;
const originalAccessTokenSecret = process.env.ACCESS_TOKEN_SECRET;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;

  if (originalAccessTokenSecret === undefined) delete process.env.ACCESS_TOKEN_SECRET;
  else process.env.ACCESS_TOKEN_SECRET = originalAccessTokenSecret;
});

describe("resolveSecret production guard", () => {
  test("throws in production when no secret is supplied via opts or env", () => {
    process.env.NODE_ENV = "production";
    delete process.env.ACCESS_TOKEN_SECRET;

    expect(() => createServer({ port: 0, db: createDatabase(":memory:") })).toThrow();
  });

  test("throws in production when accessTokenSecret opt is an empty string", () => {
    process.env.NODE_ENV = "production";
    delete process.env.ACCESS_TOKEN_SECRET;

    expect(() =>
      createServer({ port: 0, db: createDatabase(":memory:"), accessTokenSecret: "", stateSecret: "state-secret" })
    ).toThrow();
  });

  test("throws in production when ACCESS_TOKEN_SECRET env var is an empty string", () => {
    process.env.NODE_ENV = "production";
    process.env.ACCESS_TOKEN_SECRET = "";

    expect(() => createServer({ port: 0, db: createDatabase(":memory:"), stateSecret: "state-secret" })).toThrow();
  });

  test("does not throw outside production when no secret is supplied", () => {
    delete process.env.NODE_ENV;
    delete process.env.ACCESS_TOKEN_SECRET;

    const server = createServer({ port: 0, db: createDatabase(":memory:") });
    server.stop();
  });
});
