import type { ObjectId } from "mongodb";
import type Stripe from "stripe";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { parseStripeEnv } from "../src/config/env.js";
import { createApp } from "../src/create-app.js";
import { createStripeGateway, toSubscriptionSnapshot, type SubscriptionSnapshot } from "../src/lib/stripe.js";
import { createFakeBillingStore, createFakeGateway, signedEvent } from "./fake-billing.js";
import { createFakeBookingStore } from "./fake-booking-store.js";
import { createFakeServiceStore } from "./fake-service-store.js";
import { bearerFor, createFakeUserService, jwtShapedVerifier, makeUser, TEST_CONFIG } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY);
const unix = (date: Date) => Math.floor(date.getTime() / 1000);

function setup() {
  const vendor = makeUser({ role: "vendor", name: "Vera Vendor", businessName: "Vera Photo", stripeCustomerId: null });
  const otherVendor = makeUser({ role: "vendor", stripeCustomerId: null });
  const customer = makeUser({ role: "customer" });
  const admin = makeUser({ role: "admin" });
  const { service: users, store: docs } = createFakeUserService([vendor, otherVendor, customer, admin]);
  const billing = createFakeBillingStore(docs);
  const stripe = createFakeGateway();
  const app = createApp(TEST_CONFIG, {
    verifyToken: jwtShapedVerifier,
    users,
    services: createFakeServiceStore().store,
    bookings: createFakeBookingStore().store,
    billingStore: billing.store,
    paymentGateway: stripe.gateway,
  });
  const as = (u: { _id: ObjectId }) => ({ Authorization: bearerFor(u._id.toHexString()) });
  const deliver = (type: string, object: Record<string, unknown>, created?: number) => {
    const { payload, signature } = signedEvent(type, object, created);
    return request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", signature)
      .send(payload);
  };
  /** A subscription as Stripe would hold it after a successful checkout. */
  const subscribe = (owner = vendor, overrides: Partial<SubscriptionSnapshot> = {}) => {
    const snapshot: SubscriptionSnapshot = {
      id: `sub_${owner._id.toHexString().slice(-8)}${stripe.subscriptions.size}`,
      customerId: owner.stripeCustomerId ?? "cus_test_1",
      vendorId: owner._id.toHexString(),
      status: "active",
      currentPeriodEnd: inDays(30),
      cancelAtPeriodEnd: false,
      endedAt: null,
      ...overrides,
    };
    stripe.subscriptions.set(snapshot.id, snapshot);
    return snapshot;
  };
  const sessionObject = (sessionId: string, sub: SubscriptionSnapshot, owner = vendor) => ({
    id: sessionId,
    object: "checkout.session",
    mode: "subscription",
    payment_status: "paid",
    status: "complete",
    client_reference_id: owner._id.toHexString(),
    metadata: { vendorId: owner._id.toHexString() },
    customer: sub.customerId,
    subscription: sub.id,
    invoice: `in_first_${sub.id}`,
    amount_total: 2900,
    currency: "usd",
  });
  const invoiceObject = (id: string, sub: SubscriptionSnapshot, extra: Record<string, unknown> = {}) => ({
    id,
    object: "invoice",
    billing_reason: "subscription_cycle",
    amount_paid: 2900,
    amount_due: 2900,
    currency: "usd",
    customer: sub.customerId,
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: sub.id, metadata: { vendorId: sub.vendorId } },
    },
    ...extra,
  });
  return { app, as, deliver, subscribe, sessionObject, invoiceObject, vendor, otherVendor, customer, admin, docs, billing, stripe };
}

/** Starts a checkout for `vendor` and returns the session id Stripe would send back. */
async function startCheckout(ctx: ReturnType<typeof setup>, owner = ctx.vendor) {
  const res = await request(ctx.app).post("/api/billing/checkout").set(ctx.as(owner));
  expect(res.status).toBe(201);
  return String(res.body.data.url).split("/").pop()!;
}

describe("POST /api/billing/checkout (BR-13)", () => {
  it("creates a server-priced session for the token's vendor and a pending transaction", async () => {
    const ctx = setup();
    const res = await request(ctx.app)
      .post("/api/billing/checkout")
      .set(ctx.as(ctx.vendor))
      // Client-supplied price/vendor are ignored.
      .send({ vendorId: ctx.otherVendor._id.toHexString(), amount: 1 });

    expect(res.status).toBe(201);
    expect(res.body.data.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    const vendorId = ctx.vendor._id.toHexString();
    expect(ctx.stripe.gateway.createCustomer).toHaveBeenCalledWith({ vendorId, email: ctx.vendor.email, name: "Vera Photo" });
    expect(ctx.docs.get(vendorId)?.stripeCustomerId).toBe("cus_test_1");
    expect(ctx.stripe.gateway.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      vendorId,
      customerId: "cus_test_1",
      successUrl: "http://localhost:3000/payment/success?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "http://localhost:3000/payment/cancel",
    }));

    expect(ctx.billing.transactions).toHaveLength(1);
    expect(ctx.billing.transactions[0]).toMatchObject({ status: "pending", amount: 2900, currency: "usd", kind: "subscription" });
    expect(ctx.billing.transactions[0]!.vendorId.toHexString()).toBe(vendorId);
  });

  it("reuses the open session on a second click and reuses the Stripe customer", async () => {
    const ctx = setup();
    const first = await request(ctx.app).post("/api/billing/checkout").set(ctx.as(ctx.vendor));
    const second = await request(ctx.app).post("/api/billing/checkout").set(ctx.as(ctx.vendor));
    expect(second.body.data.url).toBe(first.body.data.url);
    expect(ctx.stripe.gateway.createCheckoutSession).toHaveBeenCalledTimes(1);

    // Once that session is closed, a new one is created for the SAME customer.
    ctx.billing.transactions[0]!.status = "expired";
    await request(ctx.app).post("/api/billing/checkout").set(ctx.as(ctx.vendor));
    expect(ctx.stripe.gateway.createCheckoutSession).toHaveBeenCalledTimes(2);
    expect(ctx.stripe.gateway.createCustomer).toHaveBeenCalledTimes(1);
  });

  it("is vendor-only and refuses vendors who are already Premium", async () => {
    const ctx = setup();
    expect((await request(ctx.app).post("/api/billing/checkout")).status).toBe(401);
    expect((await request(ctx.app).post("/api/billing/checkout").set(ctx.as(ctx.customer))).status).toBe(403);
    expect((await request(ctx.app).post("/api/billing/checkout").set(ctx.as(ctx.admin))).status).toBe(403);

    Object.assign(ctx.vendor, { subscriptionPlan: "premium", subscriptionExpiresAt: inDays(10) });
    const res = await request(ctx.app).post("/api/billing/checkout").set(ctx.as(ctx.vendor));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_PREMIUM");
    expect(ctx.stripe.gateway.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("won't charge twice while a paid subscription is still syncing, and replaces a lapsed one", async () => {
    const ctx = setup();
    const active = ctx.subscribe();
    ctx.vendor.stripeSubscriptionId = active.id;
    const blocked = await request(ctx.app).post("/api/billing/checkout").set(ctx.as(ctx.vendor));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("SUBSCRIPTION_ACTIVE");

    ctx.stripe.subscriptions.set(active.id, { ...active, status: "past_due" });
    await startCheckout(ctx);
    expect(ctx.stripe.gateway.cancelNow).toHaveBeenCalledWith(active.id);
  });

  it("answers 503 when Stripe is not configured", async () => {
    const ctx = setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = createApp(TEST_CONFIG, {
      verifyToken: jwtShapedVerifier,
      users: createFakeUserService([ctx.vendor]).service,
      billingStore: ctx.billing.store,
      paymentGateway: createStripeGateway(() => parseStripeEnv({})),
    });
    const res = await request(app).post("/api/billing/checkout").set(ctx.as(ctx.vendor));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PAYMENTS_UNAVAILABLE");
    errors.mockRestore();
  });
});

describe("POST /api/webhooks/stripe (BR-14)", () => {
  it("rejects missing or forged signatures without touching any data", async () => {
    const ctx = setup();
    const sessionId = await startCheckout(ctx);
    const sub = ctx.subscribe();
    const { payload } = signedEvent("checkout.session.completed", ctx.sessionObject(sessionId, sub));

    const unsigned = await request(ctx.app).post("/api/webhooks/stripe").set("Content-Type", "application/json").send(payload);
    expect(unsigned.status).toBe(400);

    const forged = await request(ctx.app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`)
      .send(payload);
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("INVALID_SIGNATURE");

    // A body re-serialized by a JSON parser no longer matches its signature.
    const { signature } = signedEvent("checkout.session.completed", ctx.sessionObject(sessionId, sub));
    const tampered = await request(ctx.app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", signature)
      .send(JSON.stringify(JSON.parse(payload), null, 2));
    expect(tampered.status).toBe(400);

    expect(ctx.vendor.subscriptionPlan).toBe("free");
    expect(ctx.billing.transactions[0]!.status).toBe("pending");
  });

  it("activates Premium only from a verified checkout.session.completed, idempotently", async () => {
    const ctx = setup();
    const sessionId = await startCheckout(ctx);

    // Before the webhook: the success page sees "pending" and the plan is still Free.
    const before = await request(ctx.app).get(`/api/billing/status?session_id=${sessionId}`).set(ctx.as(ctx.vendor));
    expect(before.body.data.checkout.status).toBe("pending");
    expect(before.body.data.plan.isPremium).toBe(false);

    const sub = ctx.subscribe(ctx.vendor, { customerId: "cus_test_1" });
    for (let i = 0; i < 2; i++) {
      const res = await ctx.deliver("checkout.session.completed", ctx.sessionObject(sessionId, sub));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: true, outcome: "processed" });
    }

    expect(ctx.vendor).toMatchObject({ subscriptionPlan: "premium", stripeSubscriptionId: sub.id, subscriptionCancelAtPeriodEnd: false });
    expect(ctx.vendor.subscriptionExpiresAt?.getTime()).toBe(sub.currentPeriodEnd!.getTime());
    expect(ctx.billing.transactions).toHaveLength(1);
    expect(ctx.billing.transactions[0]).toMatchObject({ status: "paid", stripeInvoiceId: `in_first_${sub.id}` });
    expect(ctx.billing.transactions[0]!.checkoutUrl).toBeUndefined();

    const after = await request(ctx.app).get(`/api/billing/status?session_id=${sessionId}`).set(ctx.as(ctx.vendor));
    expect(after.body.data.checkout.status).toBe("paid");
    expect(after.body.data.plan).toMatchObject({ name: "premium", isPremium: true, activeLimit: null });
    expect(after.body.data).toMatchObject({ mode: "test", price: { amount: 2900, currency: "usd", interval: "month" } });
    expect(after.body.data.transactions).toHaveLength(1);
    expect(JSON.stringify(after.body)).not.toContain("checkout.stripe.com");

    // The first invoice belongs to the checkout row — no duplicate renewal row.
    await ctx.deliver("invoice.paid", ctx.invoiceObject(`in_first_${sub.id}`, sub, { billing_reason: "subscription_create" }));
    expect(ctx.billing.transactions).toHaveLength(1);
  });

  it("keeps session status owner-scoped and validates the session id", async () => {
    const ctx = setup();
    const sessionId = await startCheckout(ctx);
    const other = await request(ctx.app).get(`/api/billing/status?session_id=${sessionId}`).set(ctx.as(ctx.otherVendor));
    expect(other.status).toBe(200);
    expect(other.body.data.checkout).toBeNull();
    expect(other.body.data.transactions).toHaveLength(0);

    const bad = await request(ctx.app).get("/api/billing/status?session_id=nope").set(ctx.as(ctx.vendor));
    expect(bad.status).toBe(400);
    expect((await request(ctx.app).get("/api/billing/status").set(ctx.as(ctx.customer))).status).toBe(403);
  });

  it("marks expired and failed checkouts, but never downgrades a paid one", async () => {
    const ctx = setup();
    const sessionId = await startCheckout(ctx);
    await ctx.deliver("checkout.session.expired", { id: sessionId, object: "checkout.session" });
    expect(ctx.billing.transactions[0]!.status).toBe("expired");

    const second = await startCheckout(ctx);
    const sub = ctx.subscribe();
    await ctx.deliver("checkout.session.completed", ctx.sessionObject(second, sub));
    await ctx.deliver("checkout.session.async_payment_failed", { id: second, object: "checkout.session" });
    expect(ctx.billing.transactions.find((t) => t.stripeSessionId === second)!.status).toBe("paid");
  });

  it("records each renewal once and extends the paid-through date", async () => {
    const ctx = setup();
    const sessionId = await startCheckout(ctx);
    const sub = ctx.subscribe();
    await ctx.deliver("checkout.session.completed", ctx.sessionObject(sessionId, sub));

    const renewedEnd = inDays(60);
    ctx.stripe.subscriptions.set(sub.id, { ...sub, currentPeriodEnd: renewedEnd });
    await ctx.deliver("invoice.payment_failed", ctx.invoiceObject("in_renewal_1", sub));
    expect(ctx.billing.transactions.find((t) => t.stripeInvoiceId === "in_renewal_1")!.status).toBe("failed");

    await ctx.deliver("invoice.paid", ctx.invoiceObject("in_renewal_1", sub));
    await ctx.deliver("invoice.paid", ctx.invoiceObject("in_renewal_1", sub));
    // A late failure notice can't undo the payment.
    await ctx.deliver("invoice.payment_failed", ctx.invoiceObject("in_renewal_1", sub));

    const renewals = ctx.billing.transactions.filter((t) => t.kind === "renewal");
    expect(renewals).toHaveLength(1);
    expect(renewals[0]).toMatchObject({ status: "paid", amount: 2900 });
    expect(ctx.vendor.subscriptionExpiresAt?.getTime()).toBe(renewedEnd.getTime());

    // Endpoints on API versions before 2025-03-31 send the subscription at the top level.
    const legacyEnd = inDays(90);
    ctx.stripe.subscriptions.set(sub.id, { ...sub, currentPeriodEnd: legacyEnd });
    const legacyInvoice: Record<string, unknown> = {
      ...ctx.invoiceObject("in_renewal_2", sub),
      subscription: sub.id,
      subscription_details: { metadata: { vendorId: sub.vendorId } },
    };
    delete legacyInvoice.parent;
    const legacy = await ctx.deliver("invoice.paid", legacyInvoice);
    expect(legacy.body.outcome).toBe("processed");
    expect(ctx.billing.transactions.filter((t) => t.kind === "renewal")).toHaveLength(2);
    expect(ctx.vendor.subscriptionExpiresAt?.getTime()).toBe(legacyEnd.getTime());

    // An out-of-order, older snapshot can't shorten the paid period.
    ctx.stripe.subscriptions.set(sub.id, { ...sub, currentPeriodEnd: inDays(30) });
    await ctx.deliver("customer.subscription.updated", { id: sub.id, object: "subscription" });
    expect(ctx.vendor.subscriptionExpiresAt?.getTime()).toBe(legacyEnd.getTime());
  });

  it("syncs cancellation and ends Premium only for the current subscription", async () => {
    const ctx = setup();
    const sessionId = await startCheckout(ctx);
    const old = ctx.subscribe();
    await ctx.deliver("checkout.session.completed", ctx.sessionObject(sessionId, old));

    ctx.stripe.subscriptions.set(old.id, { ...old, cancelAtPeriodEnd: true });
    await ctx.deliver("customer.subscription.updated", { id: old.id, object: "subscription" });
    expect(ctx.vendor.subscriptionCancelAtPeriodEnd).toBe(true);

    ctx.stripe.subscriptions.set(old.id, { ...old, status: "canceled", endedAt: new Date() });
    await ctx.deliver("customer.subscription.deleted", { id: old.id, object: "subscription" });
    expect(ctx.vendor).toMatchObject({ subscriptionPlan: "free", stripeSubscriptionId: null, subscriptionCancelAtPeriodEnd: false });

    // Re-subscribe; a late deletion of the OLD subscription must not downgrade the new one.
    const next = ctx.subscribe();
    const second = await startCheckout(ctx);
    await ctx.deliver("checkout.session.completed", ctx.sessionObject(second, next));
    expect(ctx.vendor.subscriptionPlan).toBe("premium");
    await ctx.deliver("customer.subscription.deleted", { id: old.id, object: "subscription" });
    expect(ctx.vendor).toMatchObject({ subscriptionPlan: "premium", stripeSubscriptionId: next.id });
  });

  it("returns 500 when processing fails so Stripe retries, and ignores unrelated events", async () => {
    const ctx = setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await ctx.deliver("customer.subscription.updated", { id: "sub_missing", object: "subscription" });
    expect(res.status).toBe(500);
    errors.mockRestore();

    const ignored = await ctx.deliver("charge.succeeded", { id: "ch_1", object: "charge" });
    expect(ignored.status).toBe(200);
    expect(ignored.body.outcome).toBe("ignored");
  });
});

describe("cancel / resume (BR-16)", () => {
  async function premiumVendor() {
    const ctx = setup();
    const sessionId = await startCheckout(ctx);
    const sub = ctx.subscribe();
    await ctx.deliver("checkout.session.completed", ctx.sessionObject(sessionId, sub));
    return { ...ctx, sub };
  }

  it("schedules cancellation at period end and keeps Premium until then", async () => {
    const ctx = await premiumVendor();
    const res = await request(ctx.app).post("/api/billing/cancel").set(ctx.as(ctx.vendor));
    expect(res.status).toBe(200);
    expect(res.body.data.cancelAtPeriodEnd).toBe(true);
    expect(ctx.stripe.gateway.setCancelAtPeriodEnd).toHaveBeenCalledWith(ctx.sub.id, true);
    expect(ctx.vendor).toMatchObject({ subscriptionPlan: "premium", subscriptionCancelAtPeriodEnd: true });

    const again = await request(ctx.app).post("/api/billing/cancel").set(ctx.as(ctx.vendor));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_CANCELLING");

    const resumed = await request(ctx.app).post("/api/billing/resume").set(ctx.as(ctx.vendor));
    expect(resumed.status).toBe(200);
    expect(ctx.vendor.subscriptionCancelAtPeriodEnd).toBe(false);
    expect((await request(ctx.app).post("/api/billing/resume").set(ctx.as(ctx.vendor))).status).toBe(409);
  });

  it("refuses Free vendors and other roles", async () => {
    const ctx = setup();
    const free = await request(ctx.app).post("/api/billing/cancel").set(ctx.as(ctx.vendor));
    expect(free.status).toBe(409);
    expect(free.body.error.code).toBe("NOT_PREMIUM");
    expect((await request(ctx.app).post("/api/billing/cancel").set(ctx.as(ctx.customer))).status).toBe(403);
    expect(ctx.stripe.gateway.setCancelAtPeriodEnd).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/transactions", () => {
  it("is admin-only, read-only, and includes vendor info and totals", async () => {
    const ctx = setup();
    const sessionId = await startCheckout(ctx);
    await ctx.deliver("checkout.session.completed", ctx.sessionObject(sessionId, ctx.subscribe()));
    await startCheckout(ctx, ctx.otherVendor);

    const res = await request(ctx.app).get("/api/admin/transactions").set(ctx.as(ctx.admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].vendor).toMatchObject({ name: "Vera Vendor", businessName: "Vera Photo" });
    expect(res.body.meta.summary).toMatchObject({ revenue: 2900, paid: 1, pending: 1 });
    expect(JSON.stringify(res.body)).not.toContain("checkout.stripe.com");

    const paidOnly = await request(ctx.app).get("/api/admin/transactions?status=paid").set(ctx.as(ctx.admin));
    expect(paidOnly.body.data).toHaveLength(1);
    expect((await request(ctx.app).get("/api/admin/transactions?status=bogus").set(ctx.as(ctx.admin))).status).toBe(400);

    expect((await request(ctx.app).get("/api/admin/transactions").set(ctx.as(ctx.vendor))).status).toBe(403);
    for (const method of ["post", "patch", "delete"] as const) {
      expect((await request(ctx.app)[method]("/api/admin/transactions").set(ctx.as(ctx.admin))).status).toBe(404);
    }
  });
});

describe("Stripe helpers", () => {
  it("parses Stripe env without echoing values", () => {
    // Built at runtime so secret scanners don't mistake fixtures for real keys.
    const fakeKey = ["sk", "test", "x".repeat(16)].join("_");
    const fakeWebhookSecret = ["whsec", "x".repeat(16)].join("_");
    expect(parseStripeEnv({ STRIPE_SECRET_KEY: fakeKey, STRIPE_WEBHOOK_SECRET: fakeWebhookSecret })).toBeTruthy();
    expect(() => parseStripeEnv({ STRIPE_SECRET_KEY: "pk_test_leakme123456", STRIPE_WEBHOOK_SECRET: "nope" })).toThrow(
      /^Invalid Stripe configuration\. Check: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET\.$/,
    );
  });

  it("reads the paid-through date from subscription items and honours cancel_at", () => {
    const end = unix(inDays(30));
    const base = {
      id: "sub_1",
      customer: "cus_1",
      metadata: { vendorId: "a".repeat(24) },
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      ended_at: null,
      items: { data: [{ current_period_end: end }] },
    } as unknown as Stripe.Subscription;
    expect(toSubscriptionSnapshot(base)).toMatchObject({
      vendorId: "a".repeat(24),
      currentPeriodEnd: new Date(end * 1000),
      cancelAtPeriodEnd: false,
    });
    const cancelAt = unix(inDays(5));
    expect(toSubscriptionSnapshot({ ...base, cancel_at: cancelAt } as Stripe.Subscription)).toMatchObject({
      currentPeriodEnd: new Date(cancelAt * 1000),
      cancelAtPeriodEnd: true,
    });
  });
});
