import Stripe from "stripe";
import { parseStripeEnv, type StripeEnv } from "../config/env.js";
import { PREMIUM_PLAN } from "../types/transaction.js";
import { ApiError } from "./api-error.js";

export type StripeEvent = Stripe.Event;

/** The subscription fields Wedora cares about, flattened from Stripe's object. */
export type SubscriptionSnapshot = {
  id: string;
  customerId: string;
  /** Set by us in `subscription_data.metadata` at checkout. */
  vendorId: string | null;
  status: Stripe.Subscription.Status;
  /** Paid-through date. Never later than a scheduled `cancel_at`. */
  currentPeriodEnd: Date | null;
  /** True when the subscription is scheduled to end (period end or a cancel date). */
  cancelAtPeriodEnd: boolean;
  endedAt: Date | null;
};

export type CheckoutRequest = {
  vendorId: string;
  customerId: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  /** Makes a retried request return the same session instead of a second one. */
  idempotencyKey: string;
};

/** Everything the API needs from Stripe, behind one seam that tests replace. */
export type PaymentGateway = {
  createCustomer(input: { vendorId: string; email: string; name: string }): Promise<string>;
  createCheckoutSession(input: CheckoutRequest): Promise<{ id: string; url: string }>;
  retrieveSubscription(id: string): Promise<SubscriptionSnapshot>;
  setCancelAtPeriodEnd(id: string, cancel: boolean): Promise<SubscriptionSnapshot>;
  cancelNow(id: string): Promise<SubscriptionSnapshot>;
  /** Verifies the `Stripe-Signature` header against the RAW body; throws if invalid. */
  verifyWebhook(rawBody: Buffer, signature: string): StripeEvent;
  /** "test" or "live" from the key; null when Stripe isn't configured. */
  mode(): "test" | "live" | null;
};

const toDate = (seconds: number | null | undefined) =>
  typeof seconds === "number" ? new Date(seconds * 1000) : null;

export function toSubscriptionSnapshot(subscription: Stripe.Subscription): SubscriptionSnapshot {
  // Since API 2025-03-31 the billing period lives on each subscription item.
  const itemEnds = subscription.items.data
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === "number");
  const periodEnd = itemEnds.length > 0 ? Math.min(...itemEnds) : null;
  const cancelAt = subscription.cancel_at;
  const paidThrough =
    periodEnd !== null && cancelAt !== null ? Math.min(periodEnd, cancelAt) : periodEnd;

  return {
    id: subscription.id,
    customerId:
      typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    vendorId: subscription.metadata?.vendorId ?? null,
    status: subscription.status,
    currentPeriodEnd: toDate(paidThrough),
    cancelAtPeriodEnd: subscription.cancel_at_period_end || cancelAt !== null,
    endedAt: toDate(subscription.ended_at),
  };
}

const unavailable = () =>
  new ApiError(503, "PAYMENTS_UNAVAILABLE", "Payments are temporarily unavailable. Please try again later.");

/**
 * The real gateway. Keys are read on first use, so the rest of the API works
 * even where Stripe isn't configured; payment routes then answer 503.
 */
export function createStripeGateway(
  loadEnv: () => StripeEnv = () => parseStripeEnv(process.env),
): PaymentGateway {
  let cached: { stripe: Stripe; env: StripeEnv } | undefined;

  const connect = () => {
    if (!cached) {
      let env: StripeEnv;
      try {
        env = loadEnv();
      } catch (error) {
        // The message lists variable names only, never values.
        console.error(error instanceof Error ? error.message : "Invalid Stripe configuration.");
        throw unavailable();
      }
      cached = {
        env,
        stripe: new Stripe(env.STRIPE_SECRET_KEY, {
          maxNetworkRetries: 2,
          timeout: 20_000,
          appInfo: { name: "Wedora API" },
        }),
      };
    }
    return cached;
  };

  return {
    async createCustomer({ vendorId, email, name }) {
      const customer = await connect().stripe.customers.create({
        email,
        name,
        metadata: { vendorId },
      });
      return customer.id;
    },

    async createCheckoutSession(input) {
      const session = await connect().stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer: input.customerId,
          client_reference_id: input.vendorId,
          metadata: { vendorId: input.vendorId },
          subscription_data: { metadata: { vendorId: input.vendorId } },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: PREMIUM_PLAN.currency,
                unit_amount: PREMIUM_PLAN.amount,
                recurring: { interval: PREMIUM_PLAN.interval },
                product_data: {
                  name: PREMIUM_PLAN.name,
                  description: PREMIUM_PLAN.description,
                },
              },
            },
          ],
          allowed_payment_method_types: ["card"],
          // Always charge the advertised $29 USD — no automatic local-currency conversion.
          adaptive_pricing: { enabled: false },
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (!session.url) throw new Error("Stripe returned a Checkout session without a URL.");
      return { id: session.id, url: session.url };
    },

    async retrieveSubscription(id) {
      return toSubscriptionSnapshot(await connect().stripe.subscriptions.retrieve(id));
    },

    async setCancelAtPeriodEnd(id, cancel) {
      return toSubscriptionSnapshot(
        await connect().stripe.subscriptions.update(id, { cancel_at_period_end: cancel }),
      );
    },

    async cancelNow(id) {
      return toSubscriptionSnapshot(await connect().stripe.subscriptions.cancel(id));
    },

    verifyWebhook(rawBody, signature) {
      const { stripe, env } = connect();
      return stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    },

    mode() {
      try {
        return connect().env.STRIPE_SECRET_KEY.includes("_test_") ? "test" : "live";
      } catch {
        return null;
      }
    },
  };
}
