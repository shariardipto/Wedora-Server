import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";

const CLIENT_ORIGIN = "http://localhost:3000";
const app = createApp({ CLIENT_ORIGIN });

describe("Wedora API baseline", () => {
  it("reports health without caching", async () => {
    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      success: true,
      data: { status: "ok", service: "wedora-api" },
    });
  });

  it("answers the root URL instead of a 404", async () => {
    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const response = await request(app).get("/api/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      message: "This API route does not exist.",
      error: { code: "ROUTE_NOT_FOUND" },
    });
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await request(app)
      .post("/api/health")
      .set("Content-Type", "application/json")
      .send("{ not json");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_JSON");
  });

  it("rejects oversized JSON bodies with 413", async () => {
    const response = await request(app)
      .post("/api/health")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ text: "x".repeat(110_000) }));

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("allows CORS only for the configured client origin", async () => {
    const allowed = await request(app)
      .get("/api/health")
      .set("Origin", CLIENT_ORIGIN);
    const other = await request(app)
      .get("/api/health")
      .set("Origin", "https://evil.example");

    expect(allowed.headers["access-control-allow-origin"]).toBe(CLIENT_ORIGIN);
    expect(other.headers["access-control-allow-origin"]).not.toBe(
      "https://evil.example",
    );
  });

  it("does not advertise the framework", async () => {
    const response = await request(app).get("/api/health");

    expect(response.headers["x-powered-by"]).toBeUndefined();
  });
});
