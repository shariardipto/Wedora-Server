import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { createFakeServiceStore } from "./fake-service-store.js";
import { bearerFor, createFakeUserService, jwtShapedVerifier, makeUser, TEST_CONFIG, validInput } from "./helpers.js";

function setup() {
  const vendor = makeUser({ role: "vendor", name: "Vera Vendor" });
  const otherVendor = makeUser({ role: "vendor" });
  const premiumVendor = makeUser({
    role: "vendor",
    subscriptionPlan: "premium",
    subscriptionExpiresAt: new Date(Date.now() + 86_400_000),
  });
  const blockedVendor = makeUser({ role: "vendor", isBlocked: true });
  const customer = makeUser({ role: "customer" });
  const admin = makeUser({ role: "admin" });
  const all = [vendor, otherVendor, premiumVendor, blockedVendor, customer, admin];
  const users = createFakeUserService(all).service;
  const { store, seed, docs } = createFakeServiceStore(all);
  const app = createApp(TEST_CONFIG, { verifyToken: jwtShapedVerifier, users, services: store });
  const as = (user: { _id: { toHexString(): string } }) => ({ Authorization: bearerFor(user._id.toHexString()) });
  return { app, seed, docs, vendor, otherVendor, premiumVendor, blockedVendor, customer, admin, as };
}

describe("public browsing", () => {
  it("lists only public services without signing in", async () => {
    const { app, seed, vendor, blockedVendor } = setup();
    seed(vendor._id, { serviceName: "Visible" });
    seed(vendor._id, { serviceName: "Pending", status: "pending" });
    seed(vendor._id, { serviceName: "Paused", isAvailable: false });
    seed(vendor._id, { serviceName: "Rejected", status: "rejected" });
    seed(blockedVendor._id, { serviceName: "Blocked vendor" });

    const response = await request(app).get("/api/services");
    expect(response.status).toBe(200);
    expect(response.body.data.map((s: { serviceName: string }) => s.serviceName)).toEqual(["Visible"]);
    expect(response.body.meta).toMatchObject({ page: 1, total: 1 });
  });

  it("validates query parameters (400)", async () => {
    const { app } = setup();
    expect((await request(app).get("/api/services?sort=random")).status).toBe(400);
    expect((await request(app).get("/api/services?category=fireworks")).status).toBe(400);
  });

  it("serves featured services and category counts", async () => {
    const { app, seed, vendor } = setup();
    seed(vendor._id, { category: "catering" });
    const featured = await request(app).get("/api/services/featured?limit=6");
    expect(featured.body.data).toHaveLength(1);
    const counts = await request(app).get("/api/services/categories");
    expect(counts.body.data).toContainEqual({ category: "catering", count: 1 });
    expect(counts.body.data).toHaveLength(6);
  });
});

describe("GET /api/services/:id visibility", () => {
  it("requires sign-in (401)", async () => {
    const { app, seed, vendor } = setup();
    const doc = seed(vendor._id);
    expect((await request(app).get(`/api/services/${doc._id}`)).status).toBe(401);
  });

  it("shows public services to customers, hides others (404)", async () => {
    const { app, seed, vendor, customer, as } = setup();
    const visible = seed(vendor._id);
    const pending = seed(vendor._id, { status: "pending" });
    const ok = await request(app).get(`/api/services/${visible._id}`).set(as(customer));
    expect(ok.status).toBe(200);
    expect(ok.body.data.vendor).toMatchObject({ name: "Vera Vendor", isPremium: false });
    expect((await request(app).get(`/api/services/${pending._id}`).set(as(customer))).status).toBe(404);
  });

  it("lets the owner and admins open non-public services", async () => {
    const { app, seed, vendor, otherVendor, admin, as } = setup();
    const rejected = seed(vendor._id, { status: "rejected", rejectionReason: "Blurry photos" });
    expect((await request(app).get(`/api/services/${rejected._id}`).set(as(vendor))).status).toBe(200);
    expect((await request(app).get(`/api/services/${rejected._id}`).set(as(admin))).status).toBe(200);
    expect((await request(app).get(`/api/services/${rejected._id}`).set(as(otherVendor))).status).toBe(404);
  });

  it.each(["not-an-id", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", "aaaaaaaaaaaaaaaaaaaaaaaa"])(
    "returns 404 for invalid or unknown id %s",
    async (id) => {
      const { app, customer, as } = setup();
      const response = await request(app).get(`/api/services/${id}`).set(as(customer));
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("SERVICE_NOT_FOUND");
    },
  );
});

describe("vendor services", () => {
  it("creates services as pending and ignores client-sent status", async () => {
    const { app, vendor, as } = setup();
    const created = await request(app).post("/api/vendor/services").set(as(vendor)).send(validInput);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: "pending", isAvailable: true, vendorId: vendor._id.toHexString() });

    const sneaky = await request(app).post("/api/vendor/services").set(as(vendor)).send({ ...validInput, status: "approved" });
    expect(sneaky.status).toBe(400);
  });

  it("only vendors may manage services (403 for customer/admin, 401 anonymous)", async () => {
    const { app, customer, admin, as } = setup();
    expect((await request(app).post("/api/vendor/services").send(validInput)).status).toBe(401);
    expect((await request(app).post("/api/vendor/services").set(as(customer)).send(validInput)).status).toBe(403);
    expect((await request(app).get("/api/vendor/services").set(as(admin))).status).toBe(403);
  });

  it("enforces the free plan limit of 3 active services (BR-06)", async () => {
    const { app, seed, vendor, as } = setup();
    seed(vendor._id, { status: "approved" });
    seed(vendor._id, { status: "pending" });
    seed(vendor._id, { status: "rejected" }); // doesn't count
    seed(vendor._id, { status: "approved", isAvailable: false }); // paused, doesn't count
    expect((await request(app).post("/api/vendor/services").set(as(vendor)).send(validInput)).status).toBe(201);

    const fourth = await request(app).post("/api/vendor/services").set(as(vendor)).send(validInput);
    expect(fourth.status).toBe(403);
    expect(fourth.body.error.code).toBe("PLAN_LIMIT_REACHED");

    const mine = await request(app).get("/api/vendor/services").set(as(vendor));
    expect(mine.body.meta).toEqual({ activeCount: 3, activeLimit: 3, isPremium: false });
  });

  it("blocks resuming a paused service beyond the limit, allows pausing", async () => {
    const { app, seed, vendor, as } = setup();
    seed(vendor._id);
    seed(vendor._id);
    const third = seed(vendor._id);
    const paused = seed(vendor._id, { isAvailable: false });

    const resume = await request(app).patch(`/api/vendor/services/${paused._id}/availability`).set(as(vendor)).send({ isAvailable: true });
    expect(resume.status).toBe(403);
    const pause = await request(app).patch(`/api/vendor/services/${third._id}/availability`).set(as(vendor)).send({ isAvailable: false });
    expect(pause.status).toBe(200);
    const resumeNow = await request(app).patch(`/api/vendor/services/${paused._id}/availability`).set(as(vendor)).send({ isAvailable: true });
    expect(resumeNow.status).toBe(200);
  });

  it("gives premium vendors unlimited active services", async () => {
    const { app, seed, premiumVendor, as } = setup();
    for (let i = 0; i < 5; i += 1) seed(premiumVendor._id);
    expect((await request(app).post("/api/vendor/services").set(as(premiumVendor)).send(validInput)).status).toBe(201);
    const mine = await request(app).get("/api/vendor/services").set(as(premiumVendor));
    expect(mine.body.meta).toMatchObject({ activeLimit: null, isPremium: true });
  });

  it("sends edited approved services back to review (BR-07), availability alone does not", async () => {
    const { app, seed, vendor, as } = setup();
    const doc = seed(vendor._id, { status: "approved" });
    const edit = await request(app).patch(`/api/vendor/services/${doc._id}`).set(as(vendor)).send({ price: 5500 });
    expect(edit.body.data.status).toBe("pending");

    const other = seed(vendor._id, { status: "approved" });
    const same = await request(app).patch(`/api/vendor/services/${other._id}`).set(as(vendor)).send({ price: other.price });
    expect(same.body.data.status).toBe("approved");
  });

  it("prevents vendors from touching other vendors' services (404)", async () => {
    const { app, seed, vendor, otherVendor, as } = setup();
    const doc = seed(otherVendor._id);
    expect((await request(app).patch(`/api/vendor/services/${doc._id}`).set(as(vendor)).send({ price: 1000 })).status).toBe(404);
    expect((await request(app).delete(`/api/vendor/services/${doc._id}`).set(as(vendor))).status).toBe(404);
    expect((await request(app).patch(`/api/vendor/services/${doc._id}/availability`).set(as(vendor)).send({ isAvailable: false })).status).toBe(404);
  });

  it("deletes own services", async () => {
    const { app, seed, docs, vendor, as } = setup();
    const doc = seed(vendor._id);
    expect((await request(app).delete(`/api/vendor/services/${doc._id}`).set(as(vendor))).status).toBe(200);
    expect(docs.has(doc._id.toHexString())).toBe(false);
  });
});

describe("admin services", () => {
  it("approves, rejects with a reason, and deletes", async () => {
    const { app, seed, vendor, admin, as } = setup();
    const doc = seed(vendor._id, { status: "pending" });

    const approve = await request(app).patch(`/api/admin/services/${doc._id}/status`).set(as(admin)).send({ status: "approved" });
    expect(approve.body.data).toMatchObject({ status: "approved", isPublic: true });

    const noReason = await request(app).patch(`/api/admin/services/${doc._id}/status`).set(as(admin)).send({ status: "rejected" });
    expect(noReason.status).toBe(400);

    const reject = await request(app)
      .patch(`/api/admin/services/${doc._id}/status`)
      .set(as(admin))
      .send({ status: "rejected", rejectionReason: "Please add real photos" });
    expect(reject.body.data).toMatchObject({ status: "rejected", rejectionReason: "Please add real photos", isPublic: false });

    expect((await request(app).delete(`/api/admin/services/${doc._id}`).set(as(admin))).status).toBe(200);
  });

  it("is admin-only (403 for vendors and customers)", async () => {
    const { app, seed, vendor, customer, as } = setup();
    const doc = seed(vendor._id, { status: "pending" });
    expect((await request(app).get("/api/admin/services").set(as(vendor))).status).toBe(403);
    expect((await request(app).patch(`/api/admin/services/${doc._id}/status`).set(as(vendor)).send({ status: "approved" })).status).toBe(403);
    expect((await request(app).delete(`/api/admin/services/${doc._id}`).set(as(customer))).status).toBe(403);
  });
});
