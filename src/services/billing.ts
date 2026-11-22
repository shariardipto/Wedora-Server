import { ObjectId } from "mongodb";
import { conflict } from "../lib/api-error.js";
import type { PaymentGateway, StripeEvent, SubscriptionSnapshot } from "../lib/stripe.js";
import { FREE_PLAN_ACTIVE_LIMIT } from "../types/service.js";
import { PREMIUM_PLAN, serializeTransaction } from "../types/transaction.js";
import type { AppUser } from "../types/user.js";
import type { BillingStore } from "./billing-store.js";

/** Stripe's minimum is 30 minutes; an hour leaves room to fill in card details. */
const CHECKOUT_TTL_MS = 60 * 60 * 1000;
/** Reuse an open session only if it stays valid long enough to finish paying. */
const REUSE_MARGIN_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 12;

/** Paying (or trialing) subscriptions grant Premium. */
const GRANTING = new Set(["active", "trialing"]);
/** Subscriptions that will never collect again end Premium immediately. */
const ENDED = new Set(["canceled", "incomplete_expired", "unpaid"]);
/** Unpaid-but-open subscriptions that block a fresh checkout until replaced. */
const REPLACEABLE = new Set(["past_due", "unpaid", "incomplete", "paused"]);

export type WebhookOutcome = "processed" | "ignored";

export type BillingService = {
  startCheckout(user: AppUser): Promise<{ url: string }>;
  status(user: AppUser, sessionId?: string): Promise<ReturnType<typeof buildStatus>>;
  cancel(user: AppUser): Promise<{ cancelAtPeriodEnd: boolean; expiresAt: string | null }>;
  resume(user: AppUser): Promise<{ cancelAtPeriodEnd: boolean; expiresAt: string | null }>;
  verifyWebhook(rawBody: Buffer, signature: string): StripeEvent;
  handleEvent(event: StripeEvent): Promise<WebhookOutcome>;
};

type Options = {
  gateway: PaymentGateway;
  store: BillingStore;
  clientOrigin: string;
  now?: () => Date;
};

/** Invoice fields as rendered by API versions before 2025-03-31. */
type LegacyInvoiceFields = {
  subscription?: string | { id: string } | null;
  subscription_details?: { metadata?: Record<string, string> | null } | null;
};

const asId = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : (value?.id ?? null);

const toVendorId = (value: unknown) =>
  typeof value === "string" && /^[a-f\d]{24}$/i.test(value) ? new ObjectId(value) : null;

function planView(user: AppUser) {
  return {
    name: user.isPremium ? ("premium" as const) : ("free" as const),
    isPremium: user.isPremium,
    expiresAt: user.subscriptionExpiresAt?.toISOString() ?? null,
    cancelAtPeriodEnd: user.isPremium && user.subscriptionCancelAtPeriodEnd,
    activeLimit: user.isPremium ? null : FREE_PLAN_ACTIVE_LIMIT,
  };
}

function buildStatus(
  user: AppUser,
  checkout: Parameters<typeof serializeTransaction>[0] | null,
  history: Parameters<typeof serializeTransaction>[0][],
  mode: "test" | "live" | null,
) {
  return {
    plan: planView(user),
    /** Lets the UI show test-card instructions in Stripe test mode only. */
    mode,
    price: { amount: PREMIUM_PLAN.amount, currency: PREMIUM_PLAN.currency, interval: PREMIUM_PLAN.interval },
    checkout: checkout ? serializeTransaction(checkout) : null,
    transactions: history.map(serializeTransaction),
  };
}

export function createBillingService({ gateway, store, clientOrigin, now = () => new Date() }: Options): BillingService {
  /**
   * Mirrors a subscription's current state onto the vendor. Called ONLY from
   * verified webhooks — this is the single place Premium is switched on (BR-14).
   */
  async function applySubscription(snapshot: SubscriptionSnapshot, knownVendorId?: ObjectId | null) {
    const vendorId =
      knownVendorId ?? toVendorId(snapshot.vendorId) ?? (await store.findVendorByCustomer(snapshot.customerId));
    if (!vendorId) return "ignored" as const;

    if (GRANTING.has(snapshot.status) && snapshot.currentPeriodEnd) {
      await store.grantPremium(vendorId, {
        subscriptionId: snapshot.id,
        customerId: snapshot.customerId,
        expiresAt: snapshot.currentPeriodEnd,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      });
    } else if (ENDED.has(snapshot.status)) {
      await store.endPremium(vendorId, snapshot.id, snapshot.endedAt ?? now());
    } else {
      // past_due / incomplete / paused: keep the paid-through date (Premium lapses
      // on its own when it passes) and just mirror the cancellation flag.
      await store.setCancelAtPeriodEnd(vendorId, snapshot.id, snapshot.cancelAtPeriodEnd);
    }
    return "processed" as const;
  }

  async function requireSubscription(user: AppUser) {
    if (!user.isPremium) throw conflict("You’re on the Free plan — there’s no subscription to change.", "NOT_PREMIUM");
    const account = await store.getAccount(new ObjectId(user.id));
    if (!account?.stripeSubscriptionId) {
      throw conflict("We couldn’t find an active subscription for your account.", "NO_SUBSCRIPTION");
    }
    return account.stripeSubscriptionId;
  }

  return {
    async startCheckout(user) {
      if (user.isPremium) {
        throw conflict("You’re already on Premium.", "ALREADY_PREMIUM");
      }
      const vendorId = new ObjectId(user.id);
      const current = now();

      // A second click (or tab) gets the same open session instead of a second subscription.
      const open = await store.findOpenCheckout(vendorId, new Date(current.getTime() + REUSE_MARGIN_MS));
      if (open?.checkoutUrl) return { url: open.checkoutUrl };

      const account = await store.getAccount(vendorId);

      if (account?.stripeSubscriptionId) {
        const existing = await gateway.retrieveSubscription(account.stripeSubscriptionId);
        if (GRANTING.has(existing.status)) {
          // Paid in Stripe but our webhook hasn't landed yet — don't charge twice.
          throw conflict(
            "Your Premium subscription is already active. It can take a moment to show up — please refresh shortly.",
            "SUBSCRIPTION_ACTIVE",
          );
        }
        // A lapsed, unpaid subscription is replaced by the new one.
        if (REPLACEABLE.has(existing.status)) await gateway.cancelNow(existing.id);
      }

      let customerId = account?.stripeCustomerId ?? null;
      if (!customerId) {
        const created = await gateway.createCustomer({
          vendorId: user.id,
          email: user.email,
          name: user.businessName ?? user.name,
        });
        customerId = (await store.saveCustomerId(vendorId, created)) ?? created;
      }

      const transactionId = new ObjectId();
      const expiresAt = new Date(current.getTime() + CHECKOUT_TTL_MS);
      const session = await gateway.createCheckoutSession({
        vendorId: user.id,
        customerId,
        successUrl: `${clientOrigin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${clientOrigin}/payment/cancel`,
        expiresAt,
        idempotencyKey: `wedora-checkout-${transactionId.toHexString()}`,
      });

      await store.insertCheckout({
        _id: transactionId,
        vendorId,
        kind: "subscription",
        plan: "premium",
        amount: PREMIUM_PLAN.amount,
        currency: PREMIUM_PLAN.currency,
        status: "pending",
        stripeSessionId: session.id,
        checkoutUrl: session.url,
        checkoutExpiresAt: expiresAt,
        paidAt: null,
        createdAt: current,
        updatedAt: current,
      });
      return { url: session.url };
    },

    async status(user, sessionId) {
      const vendorId = new ObjectId(user.id);
      const [checkout, history] = await Promise.all([
        sessionId ? store.findCheckout(vendorId, sessionId) : Promise.resolve(null),
        store.listForVendor(vendorId, HISTORY_LIMIT),
      ]);
      return buildStatus(user, checkout, history, gateway.mode());
    },

    async cancel(user) {
      if (user.isPremium && user.subscriptionCancelAtPeriodEnd) {
        throw conflict("Your subscription is already set to end.", "ALREADY_CANCELLING");
      }
      const subscriptionId = await requireSubscription(user);
      const snapshot = await gateway.setCancelAtPeriodEnd(subscriptionId, true);
      // Only the flag is mirrored here; plan and expiry stay webhook-driven.
      await store.setCancelAtPeriodEnd(new ObjectId(user.id), snapshot.id, snapshot.cancelAtPeriodEnd);
      return {
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        expiresAt: user.subscriptionExpiresAt?.toISOString() ?? null,
      };
    },

    async resume(user) {
      if (user.isPremium && !user.subscriptionCancelAtPeriodEnd) {
        throw conflict("Your subscription is already set to renew.", "NOT_CANCELLING");
      }
      const subscriptionId = await requireSubscription(user);
      const snapshot = await gateway.setCancelAtPeriodEnd(subscriptionId, false);
      await store.setCancelAtPeriodEnd(new ObjectId(user.id), snapshot.id, snapshot.cancelAtPeriodEnd);
      return {
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        expiresAt: user.subscriptionExpiresAt?.toISOString() ?? null,
      };
    },

    verifyWebhook(rawBody, signature) {
      return gateway.verifyWebhook(rawBody, signature);
    },

    async handleEvent(event) {
      switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded": {
          const session = event.data.object;
          if (session.mode !== "subscription" || session.payment_status === "unpaid") return "ignored";
          const vendorId = toVendorId(session.metadata?.vendorId ?? session.client_reference_id);
          const subscriptionId = asId(session.subscription);
          if (!vendorId || !subscriptionId) return "ignored";

          // Fetch the live subscription: event payloads can arrive out of order.
          const snapshot = await gateway.retrieveSubscription(subscriptionId);
          await store.completeCheckout({
            sessionId: session.id,
            vendorId,
            amount: session.amount_total ?? PREMIUM_PLAN.amount,
            currency: session.currency ?? PREMIUM_PLAN.currency,
            subscriptionId,
            invoiceId: asId(session.invoice),
            paidAt: new Date(event.created * 1000),
          });
          await applySubscription(snapshot, vendorId);
          return "processed";
        }

        case "checkout.session.expired":
          await store.closeCheckout(event.data.object.id, "expired");
          return "processed";

        case "checkout.session.async_payment_failed":
          await store.closeCheckout(event.data.object.id, "failed");
          return "processed";

        case "invoice.paid":
        case "invoice.payment_failed": {
          const invoice = event.data.object;
          // Events are rendered in the webhook endpoint's API version: since
          // 2025-03-31 the subscription sits under `parent`, before that at the top level.
          const details = invoice.parent?.subscription_details;
          const legacy = invoice as unknown as LegacyInvoiceFields;
          const subscriptionId = asId(details?.subscription) ?? asId(legacy.subscription);
          if (!subscriptionId) return "ignored";

          const snapshot = await gateway.retrieveSubscription(subscriptionId);
          const vendorId =
            toVendorId(details?.metadata?.vendorId ?? legacy.subscription_details?.metadata?.vendorId) ??
            toVendorId(snapshot.vendorId) ??
            (await store.findVendorByCustomer(snapshot.customerId));
          if (!vendorId) return "ignored";

          const paid = event.type === "invoice.paid";
          const amount = paid ? invoice.amount_paid : invoice.amount_due;
          // The first invoice belongs to the checkout transaction; record renewals only.
          if (invoice.id && invoice.billing_reason !== "subscription_create" && amount > 0) {
            await store.recordInvoice({
              invoiceId: invoice.id,
              vendorId,
              subscriptionId,
              amount,
              currency: invoice.currency,
              status: paid ? "paid" : "failed",
              at: new Date(event.created * 1000),
            });
          }
          await applySubscription(snapshot, vendorId);
          return "processed";
        }

        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const snapshot = await gateway.retrieveSubscription(event.data.object.id);
          return applySubscription(snapshot);
        }

        default:
          return "ignored";
      }
    },
  };
}
