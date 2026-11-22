import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { vi } from "vitest";
import type { PaymentGateway, SubscriptionSnapshot } from "../src/lib/stripe.js";
import type { AdminTransactionView, BillingStore } from "../src/services/billing-store.js";
import { serializeTransaction, type TransactionDocument } from "../src/types/transaction.js";
import type { UserDocument } from "../src/types/user.js";

export const WEBHOOK_SECRET = "whsec_test_secret_for_unit_tests_only";

/** In-memory BillingStore over the same user docs the fake authenticator reads. */
export function createFakeBillingStore(users: Map<string, UserDocument>) {
  const transactions: TransactionDocument[] = [];
  const user = (id: ObjectId) => users.get(id.toHexString());

  const store: BillingStore = {
    async getAccount(vendorId) {
      const doc = user(vendorId);
      return doc ? { stripeCustomerId: doc.stripeCustomerId ?? null, stripeSubscriptionId: doc.stripeSubscriptionId ?? null } : null;
    },
    async saveCustomerId(vendorId, customerId) {
      const doc = user(vendorId);
      if (!doc) return null;
      doc.stripeCustomerId ??= customerId;
      return doc.stripeCustomerId;
    },
    async findVendorByCustomer(customerId) {
      return [...users.values()].find((doc) => doc.stripeCustomerId === customerId && doc.role === "vendor")?._id ?? null;
    },
    async grantPremium(vendorId, grant) {
      const doc = user(vendorId);
      if (!doc || doc.role !== "vendor") return;
      doc.subscriptionPlan = "premium";
      doc.stripeSubscriptionId = grant.subscriptionId;
      doc.stripeCustomerId = grant.customerId;
      doc.subscriptionCancelAtPeriodEnd = grant.cancelAtPeriodEnd;
      const current = doc.subscriptionExpiresAt;
      if (!current || grant.expiresAt > current) doc.subscriptionExpiresAt = grant.expiresAt;
    },
    async endPremium(vendorId, subscriptionId, endedAt) {
      const doc = user(vendorId);
      if (!doc || doc.stripeSubscriptionId !== subscriptionId) return;
      doc.subscriptionPlan = "free";
      doc.subscriptionExpiresAt = endedAt;
      doc.subscriptionCancelAtPeriodEnd = false;
      doc.stripeSubscriptionId = null;
    },
    async setCancelAtPeriodEnd(vendorId, subscriptionId, cancel) {
      const doc = user(vendorId);
      if (doc && doc.stripeSubscriptionId === subscriptionId) doc.subscriptionCancelAtPeriodEnd = cancel;
    },
    async findOpenCheckout(vendorId, validUntil) {
      return (
        transactions.find(
          (t) =>
            t.vendorId.equals(vendorId) &&
            t.status === "pending" &&
            typeof t.checkoutUrl === "string" &&
            t.checkoutExpiresAt !== undefined &&
            t.checkoutExpiresAt > validUntil,
        ) ?? null
      );
    },
    async insertCheckout(doc) {
      transactions.push(doc);
    },
    async findCheckout(vendorId, sessionId) {
      return transactions.find((t) => t.stripeSessionId === sessionId && t.vendorId.equals(vendorId)) ?? null;
    },
    async completeCheckout(input) {
      let doc = transactions.find((t) => t.stripeSessionId === input.sessionId);
      if (!doc) {
        doc = {
          _id: new ObjectId(),
          vendorId: input.vendorId,
          kind: "subscription",
          plan: "premium",
          amount: input.amount,
          currency: input.currency,
          status: "pending",
          stripeSessionId: input.sessionId,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        transactions.push(doc);
      }
      doc.status = "paid";
      doc.stripeSubscriptionId = input.subscriptionId;
      if (input.invoiceId) doc.stripeInvoiceId = input.invoiceId;
      doc.paidAt = input.paidAt;
      delete doc.checkoutUrl;
    },
    async closeCheckout(sessionId, status) {
      const doc = transactions.find((t) => t.stripeSessionId === sessionId && t.status === "pending");
      if (doc) {
        doc.status = status;
        delete doc.checkoutUrl;
      }
    },
    async recordInvoice(input) {
      const doc = transactions.find((t) => t.stripeInvoiceId === input.invoiceId);
      if (!doc) {
        transactions.push({
          _id: new ObjectId(),
          vendorId: input.vendorId,
          kind: "renewal",
          plan: "premium",
          amount: input.amount,
          currency: input.currency,
          status: input.status,
          stripeSubscriptionId: input.subscriptionId,
          stripeInvoiceId: input.invoiceId,
          paidAt: input.status === "paid" ? input.at : null,
          createdAt: input.at,
          updatedAt: input.at,
        });
        return;
      }
      if (input.status === "failed" && doc.status === "paid") return;
      doc.status = input.status;
      doc.amount = input.amount;
      if (input.status === "paid") doc.paidAt = input.at;
    },
    async listForVendor(vendorId, limit) {
      return transactions.filter((t) => t.vendorId.equals(vendorId)).reverse().slice(0, limit);
    },
    async listForAdmin(query) {
      const items: AdminTransactionView[] = transactions
        .filter((t) => !query.status || t.status === query.status)
        .map((t) => {
          const vendor = users.get(t.vendorId.toHexString());
          return {
            ...serializeTransaction(t),
            vendor: vendor ? { id: vendor._id.toHexString(), name: vendor.name, email: vendor.email, businessName: vendor.businessName ?? null } : null,
          };
        });
      const paid = transactions.filter((t) => t.status === "paid");
      return {
        items,
        meta: { page: query.page, limit: query.limit, total: items.length, totalPages: 1 },
        summary: {
          revenue: paid.reduce((sum, t) => sum + t.amount, 0),
          currency: "usd",
          paid: paid.length,
          pending: transactions.filter((t) => t.status === "pending").length,
          failed: transactions.filter((t) => t.status === "failed").length,
          expired: transactions.filter((t) => t.status === "expired").length,
        },
      };
    },
  };
  return { store, transactions };
}

/**
 * Network calls are faked; signature verification is Stripe's real code with a
 * test secret, so the tests prove the raw body survives the middleware stack.
 */
export function createFakeGateway() {
  const subscriptions = new Map<string, SubscriptionSnapshot>();
  let sessionCount = 0;
  let customerCount = 0;

  const get = (id: string) => {
    const snapshot = subscriptions.get(id);
    if (!snapshot) throw new Error(`No such subscription: ${id}`);
    return { ...snapshot };
  };

  const gateway = {
    createCustomer: vi.fn(async () => `cus_test_${++customerCount}`),
    createCheckoutSession: vi.fn(async () => {
      const id = `cs_test_session${String(++sessionCount).padStart(4, "0")}`;
      return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
    }),
    retrieveSubscription: vi.fn(async (id: string) => get(id)),
    setCancelAtPeriodEnd: vi.fn(async (id: string, cancel: boolean) => {
      const next = { ...get(id), cancelAtPeriodEnd: cancel };
      subscriptions.set(id, next);
      return { ...next };
    }),
    cancelNow: vi.fn(async (id: string) => {
      const next = { ...get(id), status: "canceled" as const, endedAt: new Date() };
      subscriptions.set(id, next);
      return { ...next };
    }),
    verifyWebhook: (rawBody: Buffer, signature: string) =>
      Stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET),
    mode: () => "test" as const,
  } satisfies PaymentGateway;

  return { gateway, subscriptions };
}

/** Signs a JSON event body exactly like Stripe does. */
export function signedEvent(type: string, object: Record<string, unknown>, created = Math.floor(Date.now() / 1000)) {
  const payload = JSON.stringify({ id: `evt_${new ObjectId().toHexString()}`, object: "event", type, created, data: { object } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, signature };
}
