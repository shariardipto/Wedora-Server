import type { ObjectId } from "mongodb";

export const TRANSACTIONS_COLLECTION = "transactions";

/** The only paid plan. The price is defined here, never by the client (BR-13). */
export const PREMIUM_PLAN = {
  name: "Wedora Premium",
  description: "Unlimited active services and a Premium badge on your listings.",
  /** In cents: $29.00 */
  amount: 2900,
  currency: "usd",
  interval: "month",
} as const;

export const TRANSACTION_STATUSES = ["pending", "paid", "failed", "expired"] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/** `subscription` = the first payment through Checkout; `renewal` = each later invoice. */
export type TransactionKind = "subscription" | "renewal";

export type TransactionDocument = {
  _id: ObjectId;
  vendorId: ObjectId;
  kind: TransactionKind;
  plan: "premium";
  /** Smallest currency unit (cents). */
  amount: number;
  currency: string;
  status: TransactionStatus;
  /** Checkout transactions only (unique). */
  stripeSessionId?: string;
  stripeSubscriptionId?: string | null;
  /** Unique when present; set on renewals and on the paid checkout's first invoice. */
  stripeInvoiceId?: string;
  /** Hosted Checkout link, kept only while the session is open so a retry can reuse it. */
  checkoutUrl?: string;
  checkoutExpiresAt?: Date;
  paidAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TransactionView = ReturnType<typeof serializeTransaction>;

/** Public JSON shape. The Checkout link is never exposed. */
export function serializeTransaction(doc: TransactionDocument) {
  return {
    id: doc._id.toHexString(),
    kind: doc.kind,
    plan: doc.plan,
    amount: doc.amount,
    currency: doc.currency,
    status: doc.status,
    /** Stripe reference for support/reconciliation (invoice id, else session id). */
    reference: doc.stripeInvoiceId ?? doc.stripeSessionId ?? null,
    paidAt: doc.paidAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
