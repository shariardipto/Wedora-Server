import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { createBookingSchema, eventDateProblem, parseDateOnly } from "../src/validators/booking.js";
import { createFakeBookingStore } from "./fake-booking-store.js";
import { createFakeServiceStore } from "./fake-service-store.js";
import { bearerFor, createFakeUserService, jwtShapedVerifier, makeUser, TEST_CONFIG } from "./helpers.js";

/** A date `days` from today as YYYY-MM-DD (UTC). */
function daysFromNow(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("event date validation", () => {
  const now = new Date("2026-11-22T15:00:00Z");

  it("parses real calendar dates only", () => {
    expect(parseDateOnly("2027-02-28")?.toISOString()).toBe("2027-02-28T00:00:00.000Z");
    expect(parseDateOnly("2027-02-30")).toBeNull();
    expect(parseDateOnly("27-2-1")).toBeNull();
    expect(parseDateOnly("2027-02-28T10:00")).toBeNull();
  });

  it("accepts today (UTC) through two years ahead", () => {
    expect(eventDateProblem("2026-11-22", now)).toBeNull();
    expect(eventDateProblem("2028-11-22", now)).toBeNull();
    expect(eventDateProblem("2026-11-21", now)).toMatch(/future/);
    expect(eventDateProblem("2028-11-23", now)).toMatch(/2 years/);
  });

  it("rejects unknown fields and long messages", () => {
    const base = { serviceId: "a".repeat(24), eventDate: daysFromNow(30), eventLocation: "Napa, CA" };
    expect(createBookingSchema.safeParse(base).success).toBe(true);
    expect(createBookingSchema.safeParse({ ...base, vendorId: "b".repeat(24) }).success).toBe(false);
    expect(createBookingSchema.safeParse({ ...base, status: "accepted" }).success).toBe(false);
    expect(createBookingSchema.safeParse({ ...base, message: "x".repeat(1001) }).success).toBe(false);
    expect(createBookingSchema.safeParse({ ...base, eventLocation: "NY" }).success).toBe(false);
  });
});

function setup() {
  const customer = makeUser({ role: "customer", name: "Cara Customer", phone: "+1 (512) 555-0101" });
  const otherCustomer = makeUser({ role: "customer" });
  const vendor = makeUser({ role: "vendor", businessName: "Bloom & Co" });
  const otherVendor = makeUser({ role: "vendor" });
  const admin = makeUser({ role: "admin" });
  const all = [customer, otherCustomer, vendor, otherVendor, admin];
  const users = createFakeUserService(all).service;
  const services = createFakeServiceStore(all);
  const bookings = createFakeBookingStore();
  const app = createApp(TEST_CONFIG, {
    verifyToken: jwtShapedVerifier,
    users,
    services: services.store,
    bookings: bookings.store,
  });
  const as = (u: { _id: { toHexString(): string } }) => ({ Authorization: bearerFor(u._id.toHexString()) });
  const service = services.seed(vendor._id, { serviceName: "Garden Venue" });
  const body = (overrides: Record<string, unknown> = {}) => ({
    serviceId: service._id.toHexString(),
    eventDate: daysFromNow(60),
    eventLocation: "Napa, CA",
    message: "Around 120 guests.",
    ...overrides,
  });
  return { app, as, body, customer, otherCustomer, vendor, otherVendor, admin, service, services, bookings };
}

describe("POST /api/bookings (BR-09)", () => {
  it("creates a pending request with vendor and customer taken from the server", async () => {
    const { app, as, body, customer, vendor } = setup();
    const response = await request(app).post("/api/bookings").set(as(customer)).send(body());
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      status: "pending",
      vendorId: vendor._id.toHexString(),
      customerId: customer._id.toHexString(),
      eventLocation: "Napa, CA",
    });
  });

  it("only customers can book: vendors, admins → 403; anonymous → 401", async () => {
    const { app, as, body, vendor, otherVendor, admin } = setup();
    expect((await request(app).post("/api/bookings").send(body())).status).toBe(401);
    expect((await request(app).post("/api/bookings").set(as(vendor)).send(body())).status).toBe(403);
    expect((await request(app).post("/api/bookings").set(as(otherVendor)).send(body())).status).toBe(403);
    expect((await request(app).post("/api/bookings").set(as(admin)).send(body())).status).toBe(403);
  });

  it("refuses services that aren't approved and available (404)", async () => {
    const { app, as, body, customer, services, vendor } = setup();
    const pending = services.seed(vendor._id, { status: "pending" });
    const paused = services.seed(vendor._id, { isAvailable: false });
    for (const doc of [pending, paused]) {
      const response = await request(app).post("/api/bookings").set(as(customer)).send(body({ serviceId: doc._id.toHexString() }));
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
    }
    expect((await request(app).post("/api/bookings").set(as(customer)).send(body({ serviceId: "f".repeat(24) }))).status).toBe(404);
  });

  it("blocks duplicate active requests for the same service and date (409)", async () => {
    const { app, as, body, customer, otherCustomer } = setup();
    expect((await request(app).post("/api/bookings").set(as(customer)).send(body())).status).toBe(201);
    const again = await request(app).post("/api/bookings").set(as(customer)).send(body());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("DUPLICATE_BOOKING");
    // A different date, or a different customer, is fine.
    expect((await request(app).post("/api/bookings").set(as(customer)).send(body({ eventDate: daysFromNow(61) }))).status).toBe(201);
    expect((await request(app).post("/api/bookings").set(as(otherCustomer)).send(body())).status).toBe(201);
  });

  it("lets only one of two simultaneous identical requests through", async () => {
    const { app, as, body, customer } = setup();
    const [a, b] = await Promise.all([
      request(app).post("/api/bookings").set(as(customer)).send(body()),
      request(app).post("/api/bookings").set(as(customer)).send(body()),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it("allows re-requesting a date after the earlier request was cancelled", async () => {
    const { app, as, body, customer } = setup();
    const first = await request(app).post("/api/bookings").set(as(customer)).send(body());
    await request(app).patch(`/api/customer/bookings/${first.body.data.id}/cancel`).set(as(customer));
    expect((await request(app).post("/api/bookings").set(as(customer)).send(body())).status).toBe(201);
  });

  it("validates input (400)", async () => {
    const { app, as, body, customer } = setup();
    expect((await request(app).post("/api/bookings").set(as(customer)).send(body({ eventDate: daysFromNow(-3) }))).status).toBe(400);
    expect((await request(app).post("/api/bookings").set(as(customer)).send(body({ eventLocation: "" }))).status).toBe(400);
    expect((await request(app).post("/api/bookings").set(as(customer)).send(body({ vendorId: "x" }))).status).toBe(400);
  });
});

describe("vendor decisions (BR-10)", () => {
  it("accepts or rejects a pending request exactly once", async () => {
    const { app, as, body, customer, vendor } = setup();
    const created = await request(app).post("/api/bookings").set(as(customer)).send(body());
    const id = created.body.data.id;

    const accept = await request(app).patch(`/api/vendor/bookings/${id}`).set(as(vendor)).send({ status: "accepted" });
    expect(accept.status).toBe(200);
    expect(accept.body.data.status).toBe("accepted");

    const again = await request(app).patch(`/api/vendor/bookings/${id}`).set(as(vendor)).send({ status: "rejected" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("BOOKING_ALREADY_PROCESSED");
  });

  it("hides other vendors' requests (404) and validates the decision (400)", async () => {
    const { app, as, body, customer, vendor, otherVendor } = setup();
    const created = await request(app).post("/api/bookings").set(as(customer)).send(body());
    const id = created.body.data.id;
    expect((await request(app).patch(`/api/vendor/bookings/${id}`).set(as(otherVendor)).send({ status: "accepted" })).status).toBe(404);
    expect((await request(app).patch(`/api/vendor/bookings/${id}`).set(as(vendor)).send({ status: "cancelled" })).status).toBe(400);
    expect((await request(app).patch(`/api/vendor/bookings/${id}`).set(as(customer)).send({ status: "accepted" })).status).toBe(403);
  });

  it("lists only the vendor's own requests, with customer contact details", async () => {
    const { app, as, body, customer, vendor, otherVendor } = setup();
    await request(app).post("/api/bookings").set(as(customer)).send(body());
    const mine = await request(app).get("/api/vendor/bookings").set(as(vendor));
    expect(mine.body.data).toHaveLength(1);
    expect((await request(app).get("/api/vendor/bookings").set(as(otherVendor))).body.data).toHaveLength(0);
    expect((await request(app).get("/api/vendor/bookings?status=accepted").set(as(vendor))).body.data).toHaveLength(0);
  });
});

describe("customer bookings (BR-11)", () => {
  it("cancels only own pending requests", async () => {
    const { app, as, body, customer, otherCustomer, vendor } = setup();
    const created = await request(app).post("/api/bookings").set(as(customer)).send(body());
    const id = created.body.data.id;

    expect((await request(app).patch(`/api/customer/bookings/${id}/cancel`).set(as(otherCustomer))).status).toBe(404);
    const cancel = await request(app).patch(`/api/customer/bookings/${id}/cancel`).set(as(customer));
    expect(cancel.body.data.status).toBe("cancelled");
    expect((await request(app).patch(`/api/customer/bookings/${id}/cancel`).set(as(customer))).status).toBe(409);

    const second = await request(app).post("/api/bookings").set(as(customer)).send(body({ eventDate: daysFromNow(90) }));
    await request(app).patch(`/api/vendor/bookings/${second.body.data.id}`).set(as(vendor)).send({ status: "accepted" });
    const cannot = await request(app).patch(`/api/customer/bookings/${second.body.data.id}/cancel`).set(as(customer));
    expect(cannot.status).toBe(409);
  });

  it("shows details only to the owner and lists own requests", async () => {
    const { app, as, body, customer, otherCustomer } = setup();
    const created = await request(app).post("/api/bookings").set(as(customer)).send(body());
    const id = created.body.data.id;
    expect((await request(app).get(`/api/customer/bookings/${id}`).set(as(customer))).status).toBe(200);
    expect((await request(app).get(`/api/customer/bookings/${id}`).set(as(otherCustomer))).status).toBe(404);
    expect((await request(app).get("/api/customer/bookings/not-an-id").set(as(customer))).status).toBe(404);
    expect((await request(app).get("/api/customer/bookings").set(as(customer))).body.data).toHaveLength(1);
    expect((await request(app).get("/api/customer/bookings").set(as(otherCustomer))).body.data).toHaveLength(0);
  });
});

describe("service deletion cascade (BR-08)", () => {
  it("cancels pending requests but keeps accepted ones", async () => {
    const { app, as, body, customer, vendor, service, bookings } = setup();
    const pending = await request(app).post("/api/bookings").set(as(customer)).send(body());
    const accepted = await request(app).post("/api/bookings").set(as(customer)).send(body({ eventDate: daysFromNow(70) }));
    await request(app).patch(`/api/vendor/bookings/${accepted.body.data.id}`).set(as(vendor)).send({ status: "accepted" });

    const del = await request(app).delete(`/api/vendor/services/${service._id}`).set(as(vendor));
    expect(del.body.data.cancelledRequests).toBe(1);
    expect(bookings.docs.get(pending.body.data.id)?.status).toBe("cancelled");
    expect(bookings.docs.get(accepted.body.data.id)?.status).toBe("accepted");
  });
});
