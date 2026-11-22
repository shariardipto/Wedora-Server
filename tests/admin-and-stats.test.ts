import { ObjectId } from "mongodb";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/create-app.js";
import type { AdminUserStore } from "../src/services/admin-users.js";
import type { StatsStore } from "../src/services/stats.js";
import { serializeUser, toAppUser, type UserDocument } from "../src/types/user.js";
import { adminUserListQuerySchema } from "../src/validators/admin-user.js";
import { createFakeBookingStore } from "./fake-booking-store.js";
import { createFakeServiceStore } from "./fake-service-store.js";
import { bearerFor, createFakeUserService, jwtShapedVerifier, makeUser, TEST_CONFIG } from "./helpers.js";

const fakeStats: StatsStore = {
  vendor: async () => ({ totalServices: 4, activeServices: 3, liveServices: 2, pendingReviewServices: 1, pendingBookings: 5, acceptedBookings: 2 }),
  customer: async () => ({ totalBookings: 6, pendingBookings: 2, acceptedBookings: 2, rejectedBookings: 1, cancelledBookings: 1 }),
  admin: async () => ({ totalUsers: 10, totalVendors: 3, totalCustomers: 6, blockedUsers: 1, totalServices: 8, pendingServices: 2, totalTransactions: 0 }),
};

/** Admin-user store over the same in-memory user docs the authenticator reads. */
function createFakeAdminUsers(docs: Map<string, UserDocument>) {
  const revokeSessions = vi.fn(async () => 2);
  const store: AdminUserStore = {
    async list(query) {
      let items = [...docs.values()];
      if (query.role) items = items.filter((d) => d.role === query.role);
      if (query.status) items = items.filter((d) => (query.status === "blocked") === (d.isBlocked === true));
      if (query.q) items = items.filter((d) => `${d.name} ${d.email}`.toLowerCase().includes(query.q!.toLowerCase()));
      return { items: items.map((d) => serializeUser(toAppUser(d))), meta: { page: 1, limit: 20, total: items.length, totalPages: 1 } };
    },
    async details(id) {
      const doc = docs.get(id.toHexString());
      return doc ? { ...serializeUser(toAppUser(doc)), activity: { services: 0, liveServices: 0, bookingRequestsReceived: 0, bookingRequestsSent: 0 } } : null;
    },
    async setBlocked(id, isBlocked) {
      const doc = docs.get(id.toHexString());
      if (!doc || doc.role === "admin") return null;
      doc.isBlocked = isBlocked;
      return serializeUser(toAppUser(doc));
    },
    revokeSessions,
  };
  return { store, revokeSessions };
}

function setup() {
  const admin = makeUser({ role: "admin", name: "Ada Admin" });
  const otherAdmin = makeUser({ role: "admin" });
  const vendor = makeUser({ role: "vendor", name: "Vera Vendor", email: "vera@vendors.test" });
  const customer = makeUser({ role: "customer", name: "Cara Customer", email: "cara@example.test" });
  const { service: users, store } = createFakeUserService([admin, otherAdmin, vendor, customer]);
  const adminUsers = createFakeAdminUsers(store);
  const app = createApp(TEST_CONFIG, {
    verifyToken: jwtShapedVerifier,
    users,
    services: createFakeServiceStore().store,
    bookings: createFakeBookingStore().store,
    stats: fakeStats,
    adminUsers: adminUsers.store,
  });
  const as = (u: { _id: ObjectId }) => ({ Authorization: bearerFor(u._id.toHexString()) });
  return { app, as, admin, otherAdmin, vendor, customer, revokeSessions: adminUsers.revokeSessions };
}

describe("overview statistics", () => {
  it("serves each role only its own stats", async () => {
    const { app, as, vendor, customer, admin } = setup();
    const v = await request(app).get("/api/vendor/stats").set(as(vendor));
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ totalServices: 4, activeServices: 3, pendingBookings: 5, acceptedBookings: 2, plan: { name: "free", activeLimit: 3 } });
    expect((await request(app).get("/api/customer/stats").set(as(customer))).body.data.totalBookings).toBe(6);
    expect((await request(app).get("/api/admin/stats").set(as(admin))).body.data).toMatchObject({ totalUsers: 10, pendingServices: 2, totalTransactions: 0 });

    expect((await request(app).get("/api/vendor/stats").set(as(customer))).status).toBe(403);
    expect((await request(app).get("/api/customer/stats").set(as(vendor))).status).toBe(403);
    expect((await request(app).get("/api/admin/stats").set(as(vendor))).status).toBe(403);
    expect((await request(app).get("/api/admin/stats")).status).toBe(401);
  });
});

describe("admin: manage users", () => {
  it("lists, searches and filters users (admin only)", async () => {
    const { app, as, admin, vendor } = setup();
    expect((await request(app).get("/api/admin/users").set(as(admin))).body.data).toHaveLength(4);
    expect((await request(app).get("/api/admin/users?role=vendor").set(as(admin))).body.data).toHaveLength(1);
    expect((await request(app).get("/api/admin/users?q=CARA").set(as(admin))).body.data[0].name).toBe("Cara Customer");
    expect((await request(app).get("/api/admin/users?role=superuser").set(as(admin))).status).toBe(400);
    expect((await request(app).get("/api/admin/users").set(as(vendor))).status).toBe(403);
  });

  it("shows user details and 404 for unknown ids", async () => {
    const { app, as, admin, customer } = setup();
    const res = await request(app).get(`/api/admin/users/${customer._id}`).set(as(admin));
    expect(res.body.data).toMatchObject({ email: "cara@example.test", role: "customer", activity: { bookingRequestsSent: 0 } });
    expect(JSON.stringify(res.body)).not.toContain("cus_secret");
    expect((await request(app).get(`/api/admin/users/${new ObjectId()}`).set(as(admin))).status).toBe(404);
    expect((await request(app).get("/api/admin/users/not-an-id").set(as(admin))).status).toBe(404);
  });

  it("blocks a user, signs them out, and the API rejects them immediately", async () => {
    const { app, as, admin, customer, revokeSessions } = setup();
    expect((await request(app).get("/api/customer/stats").set(as(customer))).status).toBe(200);

    const block = await request(app).patch(`/api/admin/users/${customer._id}/block`).set(as(admin)).send({ isBlocked: true });
    expect(block.status).toBe(200);
    expect(block.body.data).toMatchObject({ isBlocked: true, revokedSessions: 2 });
    expect(revokeSessions).toHaveBeenCalledTimes(1);

    const after = await request(app).get("/api/customer/stats").set(as(customer));
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe("ACCOUNT_BLOCKED");

    const unblock = await request(app).patch(`/api/admin/users/${customer._id}/block`).set(as(admin)).send({ isBlocked: false });
    expect(unblock.body.data.isBlocked).toBe(false);
    expect(revokeSessions).toHaveBeenCalledTimes(1); // unblocking doesn't sign anyone out
    expect((await request(app).get("/api/customer/stats").set(as(customer))).status).toBe(200);
  });

  it("refuses to block yourself or another admin, and validates input", async () => {
    const { app, as, admin, otherAdmin, customer, vendor } = setup();
    const self = await request(app).patch(`/api/admin/users/${admin._id}/block`).set(as(admin)).send({ isBlocked: true });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("CANNOT_BLOCK_SELF");
    const other = await request(app).patch(`/api/admin/users/${otherAdmin._id}/block`).set(as(admin)).send({ isBlocked: true });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("CANNOT_BLOCK_ADMIN");
    expect((await request(app).patch(`/api/admin/users/${customer._id}/block`).set(as(admin)).send({ isBlocked: "yes" })).status).toBe(400);
    expect((await request(app).patch(`/api/admin/users/${customer._id}/block`).set(as(admin)).send({ isBlocked: true, role: "admin" })).status).toBe(400);
    expect((await request(app).patch(`/api/admin/users/${customer._id}/block`).set(as(vendor)).send({ isBlocked: true })).status).toBe(403);
    expect((await request(app).patch(`/api/admin/users/${new ObjectId()}/block`).set(as(admin)).send({ isBlocked: true })).status).toBe(404);
  });
});

describe("adminUserListQuerySchema", () => {
  it("normalizes empty search and bounds paging", () => {
    expect(adminUserListQuerySchema.parse({ q: "  " })).toMatchObject({ q: undefined, page: 1, limit: 20 });
    expect(adminUserListQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(adminUserListQuerySchema.safeParse({ status: "banned" }).success).toBe(false);
  });
});
