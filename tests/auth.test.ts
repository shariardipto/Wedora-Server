import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import {
  createAuthenticator,
  currentUser,
  requireRole,
} from "../src/middleware/auth.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import {
  bearerFor,
  createFakeUserService,
  jwtShapedVerifier,
  makeUser,
  TEST_CONFIG,
} from "./helpers.js";

function setup() {
  const customer = makeUser({ role: "customer", name: "Cara Customer" });
  const vendor = makeUser({ role: "vendor", businessName: "Bloom & Co" });
  const admin = makeUser({ role: "admin" });
  const blocked = makeUser({ role: "customer", isBlocked: true });
  const roleless = makeUser({ role: null });
  const { service, store } = createFakeUserService([
    customer,
    vendor,
    admin,
    blocked,
    roleless,
  ]);
  const app = createApp(TEST_CONFIG, { verifyToken: jwtShapedVerifier, users: service });
  const id = (doc: { _id: { toHexString(): string } }) => doc._id.toHexString();
  return { app, store, customer, vendor, admin, blocked, roleless, id };
}

describe("authentication (401) vs authorization (403)", () => {
  it("returns 401 with WWW-Authenticate when no token is sent", async () => {
    const { app } = setup();
    const response = await request(app).get("/api/me");
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.body.error.code).toBe("AUTH_REQUIRED");
  });

  it.each(["Basic abc", "Bearer", "Bearer not-a-jwt", `Bearer ${"a".repeat(9000)}.b.c`])(
    "returns 401 for a malformed Authorization header (%#)",
    async (header) => {
      const { app } = setup();
      const response = await request(app).get("/api/me").set("Authorization", header);
      expect(response.status).toBe(401);
    },
  );

  it("returns 401 for an invalid token", async () => {
    const { app } = setup();
    const response = await request(app)
      .get("/api/me")
      .set("Authorization", "Bearer forged.token.value");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_TOKEN");
  });

  it("returns 401 when the token's user no longer exists", async () => {
    const { app } = setup();
    const response = await request(app)
      .get("/api/me")
      .set("Authorization", bearerFor("aaaaaaaaaaaaaaaaaaaaaaaa"));
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("returns 403 ACCOUNT_BLOCKED for blocked users", async () => {
    const { app, blocked, id } = setup();
    const response = await request(app)
      .get("/api/me")
      .set("Authorization", bearerFor(id(blocked)));
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ACCOUNT_BLOCKED");
  });

  it("reads role and block status from the database on every request", async () => {
    const { app, store, customer, id } = setup();
    const auth = bearerFor(id(customer));
    expect((await request(app).get("/api/me").set("Authorization", auth)).status).toBe(200);

    store.get(id(customer))!.isBlocked = true; // admin blocks the user mid-session
    const after = await request(app).get("/api/me").set("Authorization", auth);
    expect(after.status).toBe(403);
  });
});

describe("GET /api/me", () => {
  it("returns the current profile without Stripe identifiers", async () => {
    const { app, vendor, id } = setup();
    const response = await request(app)
      .get("/api/me")
      .set("Authorization", bearerFor(id(vendor)));

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body.data).toMatchObject({
      id: id(vendor),
      role: "vendor",
      businessName: "Bloom & Co",
      subscriptionPlan: "free",
      isPremium: false,
    });
    expect(JSON.stringify(response.body)).not.toContain("cus_secret");
  });

  it("is available to users who have not chosen a role yet", async () => {
    const { app, roleless, id } = setup();
    const response = await request(app)
      .get("/api/me")
      .set("Authorization", bearerFor(id(roleless)));
    expect(response.status).toBe(200);
    expect(response.body.data.role).toBeNull();
  });
});

describe("POST /api/me/role (Google onboarding)", () => {
  it("sets the role once for a roleless user", async () => {
    const { app, roleless, id } = setup();
    const response = await request(app)
      .post("/api/me/role")
      .set("Authorization", bearerFor(id(roleless)))
      .send({ role: "vendor" });
    expect(response.status).toBe(200);
    expect(response.body.data.role).toBe("vendor");
  });

  it("refuses to change an existing role (409)", async () => {
    const { app, customer, id } = setup();
    const response = await request(app)
      .post("/api/me/role")
      .set("Authorization", bearerFor(id(customer)))
      .send({ role: "vendor" });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ROLE_ALREADY_SET");
  });

  it.each([{ role: "admin" }, { role: "" }, {}, { role: "vendor", isBlocked: false }])(
    "rejects invalid payload %j with 400",
    async (body) => {
      const { app, roleless, id } = setup();
      const response = await request(app)
        .post("/api/me/role")
        .set("Authorization", bearerFor(id(roleless)))
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    },
  );
});

describe("requireRole", () => {
  function roleApp() {
    const { store, customer, vendor, admin, roleless, id } = setup();
    const service = createFakeUserService([...store.values()]).service;
    const authenticate = createAuthenticator(jwtShapedVerifier, service);
    const app = express();
    app.get("/admin-only", authenticate(), requireRole("admin"), (req, res) => {
      res.json({ success: true, data: currentUser(req).role });
    });
    app.get("/vendor-or-admin", authenticate(), requireRole("vendor", "admin"), (_req, res) => {
      res.json({ success: true });
    });
    app.use(errorHandler);
    return { app, customer, vendor, admin, roleless, id };
  }

  it("allows the matching role and forbids others with 403", async () => {
    const { app, customer, vendor, admin, id } = roleApp();
    expect((await request(app).get("/admin-only").set("Authorization", bearerFor(id(admin)))).status).toBe(200);
    const asVendor = await request(app).get("/admin-only").set("Authorization", bearerFor(id(vendor)));
    expect(asVendor.status).toBe(403);
    expect(asVendor.body.error.code).toBe("FORBIDDEN_ROLE");
    expect((await request(app).get("/admin-only").set("Authorization", bearerFor(id(customer)))).status).toBe(403);
    expect((await request(app).get("/vendor-or-admin").set("Authorization", bearerFor(id(vendor)))).status).toBe(200);
  });

  it("blocks roleless users from role-protected routes with ROLE_REQUIRED", async () => {
    const { app, roleless, id } = roleApp();
    const response = await request(app)
      .get("/vendor-or-admin")
      .set("Authorization", bearerFor(id(roleless)));
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ROLE_REQUIRED");
  });
});
