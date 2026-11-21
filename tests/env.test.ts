import { describe, expect, it } from "vitest";
import {
  parseJwtEnv,
  parseMongoEnv,
  parseServerEnv,
} from "../src/config/env.js";

describe("parseMongoEnv", () => {
  it("requires a mongodb URI and defaults the database name", () => {
    expect(parseMongoEnv({ MONGODB_URI: "mongodb+srv://u:p@cluster.example.net/" })).toEqual({
      MONGODB_URI: "mongodb+srv://u:p@cluster.example.net/",
      MONGODB_DB_NAME: "wedora",
    });
    expect(() => parseMongoEnv({})).toThrow(/MONGODB_URI/);
    expect(() => parseMongoEnv({ MONGODB_URI: "postgres://x" })).toThrow(/MONGODB_URI/);
  });

  it("never includes the URI value in errors", () => {
    expect(() =>
      parseMongoEnv({ MONGODB_URI: "mongodb://user:supersecret@h", MONGODB_DB_NAME: "bad name!" }),
    ).toThrow(/^(?!.*supersecret).*MONGODB_DB_NAME/);
  });
});

describe("parseJwtEnv", () => {
  it("defaults to the local Next.js auth server in development", () => {
    expect(parseJwtEnv({})).toEqual({
      BETTER_AUTH_JWKS_URL: "http://localhost:3000/api/auth/jwks",
      BETTER_AUTH_ISSUER: "http://localhost:3000",
      BETTER_AUTH_AUDIENCE: "http://localhost:3000",
    });
  });

  it("requires explicit HTTPS values in production", () => {
    expect(() => parseJwtEnv({ NODE_ENV: "production" })).toThrow(/BETTER_AUTH_JWKS_URL/);
    expect(() =>
      parseJwtEnv({
        NODE_ENV: "production",
        BETTER_AUTH_JWKS_URL: "http://wedora.example/api/auth/jwks",
        BETTER_AUTH_ISSUER: "https://wedora.example",
        BETTER_AUTH_AUDIENCE: "https://wedora.example",
      }),
    ).toThrow(/BETTER_AUTH_JWKS_URL/);
  });
});

describe("parseServerEnv", () => {
  it("applies local development defaults", () => {
    expect(parseServerEnv({})).toEqual({
      NODE_ENV: "development",
      PORT: 5000,
      CLIENT_ORIGIN: "http://localhost:3000",
    });
  });

  it("coerces PORT from a string", () => {
    expect(parseServerEnv({ PORT: "8080" }).PORT).toBe(8080);
  });

  it.each([
    "http://localhost:3000/",
    "https://wedora.vercel.app/dashboard",
    "ftp://wedora.app",
    "not-a-url",
  ])("rejects CLIENT_ORIGIN %s", (value) => {
    expect(() => parseServerEnv({ CLIENT_ORIGIN: value })).toThrow(
      /CLIENT_ORIGIN/,
    );
  });

  it("requires an explicit CLIENT_ORIGIN in production", () => {
    expect(() => parseServerEnv({ NODE_ENV: "production" })).toThrow(
      /CLIENT_ORIGIN/,
    );
    expect(
      parseServerEnv({
        NODE_ENV: "production",
        CLIENT_ORIGIN: "https://wedora.vercel.app",
      }).CLIENT_ORIGIN,
    ).toBe("https://wedora.vercel.app");
  });

  it("names invalid variables without echoing their values", () => {
    expect(() => parseServerEnv({ PORT: "secret-value" })).toThrow(
      "Invalid server configuration. Check: PORT.",
    );
  });
});
