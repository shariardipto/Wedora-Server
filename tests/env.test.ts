import { describe, expect, it } from "vitest";
import { parseServerEnv } from "../src/config/env.js";

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
