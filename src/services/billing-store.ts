import { MongoServerError, type Db, type Document, type Filter, type ObjectId } from "mongodb";
import { AUTH_COLLECTIONS } from "../config/database.js";
import type { Paged } from "../types/service.js";
import {
  PREMIUM_PLAN,
  TRANSACTIONS_COLLECTION,
  serializeTransaction,
  type TransactionDocument,
  type TransactionStatus,
  type TransactionView,
} from "../types/transaction.js";
import type { UserDocument } from "../types/user.js";
import type { AdminTransactionQuery } from "../validators/billing.js";
import { escapeRegex } from "../validators/service.js";

export type BillingAccount = {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
};

export type PremiumGrant = {
  subscriptionId: string;
  customerId: string;
  expiresAt: Date;
  cancelAtPeriodEnd: boolean;
};

export type CompletedCheckout = {
  sessionId: string;
  vendorId: ObjectId;
  amount: number;
  currency: string;
  subscriptionId: string;
  invoiceId: string | null;
  paidAt: Date;
};

export type InvoiceRecord = {
  invoiceId: string;
  vendorId: ObjectId;
  subscriptionId: string;
  amount: number;
  currency: string;
  status: Extract<TransactionStatus, "paid" | "failed">;
  at: Date;
};

export type AdminTransactionView = TransactionView & {
  vendor: { id: string; name: string; email: string; businessName: string | null } | null;
};

export type TransactionSummary = {
  /** Sum of paid transactions, in cents. */
  revenue: number;
  currency: string;
  paid: number;
  pending: number;
  failed: number;
  expired: number;
};

export type AdminTransactionPage = Paged<AdminTransactionView> & { summary: TransactionSummary };

/**
 * Persistence for subscriptions (fields on the Better Auth `user` document)
 * and the `transactions` collection. Every write is a single atomic,
 * idempotent operation so Stripe can safely redeliver webhooks.
 */
export type BillingStore = {
  getAccount(vendorId: ObjectId): Promise<BillingAccount | null>;
  /** Saves the customer id only if none is set yet; returns the id that is stored. */
  saveCustomerId(vendorId: ObjectId, customerId: string): Promise<string | null>;
  findVendorByCustomer(customerId: string): Promise<ObjectId | null>;
  /** Premium on; the paid-through date only ever moves forward. */
  grantPremium(vendorId: ObjectId, grant: PremiumGrant): Promise<void>;
  /** Back to Free — only if this is still the vendor's current subscription. */
  endPremium(vendorId: ObjectId, subscriptionId: string, endedAt: Date): Promise<void>;
  setCancelAtPeriodEnd(vendorId: ObjectId, subscriptionId: string, cancel: boolean): Promise<void>;

  /** An open checkout (still valid for a while) that a retry can reuse. */
  findOpenCheckout(vendorId: ObjectId, validUntil: Date): Promise<TransactionDocument | null>;
  insertCheckout(doc: TransactionDocument): Promise<void>;
  /** Owner-scoped: another vendor's session id finds nothing. */
  findCheckout(vendorId: ObjectId, sessionId: string): Promise<TransactionDocument | null>;
  completeCheckout(input: CompletedCheckout): Promise<void>;
  /** pending → expired | failed (no-op once paid). */
  closeCheckout(sessionId: string, status: Extract<TransactionStatus, "expired" | "failed">): Promise<void>;
  /** Renewal payments, keyed by invoice id. A failure never overwrites a payment. */
  recordInvoice(input: InvoiceRecord): Promise<void>;
  listForVendor(vendorId: ObjectId, limit: number): Promise<TransactionDocument[]>;
  listForAdmin(query: AdminTransactionQuery): Promise<AdminTransactionPage>;
};

const isDuplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000;

export function createBillingStore(getDb: () => Db): BillingStore {
  const users = () => getDb().collection<UserDocument>(AUTH_COLLECTIONS.user);
  const transactions = () => getDb().collection<TransactionDocument>(TRANSACTIONS_COLLECTION);

  async function getAccount(vendorId: ObjectId): Promise<BillingAccount | null> {
    const doc = await users().findOne(
      { _id: vendorId },
      { projection: { stripeCustomerId: 1, stripeSubscriptionId: 1 } },
    );
    return doc
      ? { stripeCustomerId: doc.stripeCustomerId ?? null, stripeSubscriptionId: doc.stripeSubscriptionId ?? null }
      : null;
  }

  return {
    getAccount,

    async saveCustomerId(vendorId, customerId) {
      await users().updateOne(
        { _id: vendorId, $or: [{ stripeCustomerId: null }, { stripeCustomerId: { $exists: false } }] },
        { $set: { stripeCustomerId: customerId, updatedAt: new Date() } },
      );
      return (await getAccount(vendorId))?.stripeCustomerId ?? null;
    },

    async findVendorByCustomer(customerId) {
      const doc = await users().findOne({ stripeCustomerId: customerId, role: "vendor" }, { projection: { _id: 1 } });
      return doc?._id ?? null;
    },

    async grantPremium(vendorId, grant) {
      await users().updateOne(
        { _id: vendorId, role: "vendor" },
        {
          $set: {
            subscriptionPlan: "premium",
            stripeSubscriptionId: grant.subscriptionId,
            stripeCustomerId: grant.customerId,
            subscriptionCancelAtPeriodEnd: grant.cancelAtPeriodEnd,
            updatedAt: new Date(),
          },
          // Out-of-order webhooks can't shorten a period that was already paid for.
          $max: { subscriptionExpiresAt: grant.expiresAt },
        },
      );
    },

    async endPremium(vendorId, subscriptionId, endedAt) {
      await users().updateOne(
        { _id: vendorId, stripeSubscriptionId: subscriptionId },
        {
          $set: {
            subscriptionPlan: "free",
            subscriptionExpiresAt: endedAt,
            subscriptionCancelAtPeriodEnd: false,
            stripeSubscriptionId: null,
            updatedAt: new Date(),
          },
        },
      );
    },

    async setCancelAtPeriodEnd(vendorId, subscriptionId, cancel) {
      await users().updateOne(
        { _id: vendorId, stripeSubscriptionId: subscriptionId },
        { $set: { subscriptionCancelAtPeriodEnd: cancel, updatedAt: new Date() } },
      );
    },

    async findOpenCheckout(vendorId, validUntil) {
      return transactions().findOne(
        {
          vendorId,
          kind: "subscription",
          status: "pending",
          checkoutUrl: { $type: "string" },
          checkoutExpiresAt: { $gt: validUntil },
        },
        { sort: { createdAt: -1 } },
      );
    },

    async insertCheckout(doc) {
      await transactions().insertOne(doc);
    },

    async findCheckout(vendorId, sessionId) {
      return transactions().findOne({ stripeSessionId: sessionId, vendorId });
    },

    async completeCheckout(input) {
      const now = new Date();
      const update = {
        $set: {
          status: "paid" as const,
          stripeSubscriptionId: input.subscriptionId,
          ...(input.invoiceId ? { stripeInvoiceId: input.invoiceId } : {}),
          paidAt: input.paidAt,
          updatedAt: now,
        },
        $unset: { checkoutUrl: "" as const },
        $setOnInsert: {
          vendorId: input.vendorId,
          kind: "subscription" as const,
          plan: "premium" as const,
          amount: input.amount,
          currency: input.currency,
          createdAt: now,
        },
      };
      try {
        await transactions().updateOne({ stripeSessionId: input.sessionId }, update, { upsert: true });
      } catch (error) {
        // Two deliveries raced on the upsert; the other one inserted it — update in place.
        if (!isDuplicateKey(error)) throw error;
        await transactions().updateOne(
          { stripeSessionId: input.sessionId },
          { $set: update.$set, $unset: update.$unset },
        );
      }
    },

    async closeCheckout(sessionId, status) {
      await transactions().updateOne(
        { stripeSessionId: sessionId, status: "pending" },
        { $set: { status, updatedAt: new Date() }, $unset: { checkoutUrl: "" } },
      );
    },

    async recordInvoice(input) {
      const filter: Filter<TransactionDocument> =
        input.status === "paid"
          ? { stripeInvoiceId: input.invoiceId }
          : { stripeInvoiceId: input.invoiceId, status: { $ne: "paid" } };
      try {
        await transactions().updateOne(
          filter,
          {
            $set: {
              status: input.status,
              amount: input.amount,
              updatedAt: input.at,
              ...(input.status === "paid" ? { paidAt: input.at } : {}),
            },
            $setOnInsert: {
              vendorId: input.vendorId,
              kind: "renewal",
              plan: "premium",
              currency: input.currency,
              stripeSubscriptionId: input.subscriptionId,
              createdAt: input.at,
            },
          },
          { upsert: true },
        );
      } catch (error) {
        // Duplicate key = the invoice is already recorded (and, for a failure, already paid).
        if (!isDuplicateKey(error)) throw error;
        if (input.status === "paid") {
          await transactions().updateOne(
            { stripeInvoiceId: input.invoiceId },
            { $set: { status: "paid", amount: input.amount, paidAt: input.at, updatedAt: input.at } },
          );
        }
      }
    },

    async listForVendor(vendorId, limit) {
      return transactions()
        .find({ vendorId }, { projection: { checkoutUrl: 0 } })
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .toArray();
    },

    async listForAdmin(query) {
      const lookupVendor: Document[] = [
        {
          $lookup: {
            from: AUTH_COLLECTIONS.user,
            localField: "vendorId",
            foreignField: "_id",
            as: "vendor",
            pipeline: [{ $project: { name: 1, email: 1, businessName: 1 } }],
          },
        },
        { $set: { vendor: { $first: "$vendor" } } },
      ];
      const page: Document[] = [
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: (query.page - 1) * query.limit },
        { $limit: query.limit },
      ];

      const pipeline: Document[] = [{ $match: query.status ? { status: query.status } : {} }];
      if (query.q) {
        // Searching by vendor needs the join first; otherwise join only the visible page.
        const pattern = { $regex: escapeRegex(query.q), $options: "i" };
        pipeline.push(...lookupVendor, {
          $match: { $or: [{ "vendor.name": pattern }, { "vendor.email": pattern }, { "vendor.businessName": pattern }] },
        });
        pipeline.push({ $facet: { items: page, total: [{ $count: "count" }] } });
      } else {
        pipeline.push({ $facet: { items: [...page, ...lookupVendor], total: [{ $count: "count" }] } });
      }

      type Row = TransactionDocument & { vendor?: Pick<UserDocument, "_id" | "name" | "email" | "businessName"> };
      const [facet, statusRows] = await Promise.all([
        transactions()
          .aggregate<{ items: Row[]; total: { count: number }[] }>(pipeline)
          .next(),
        transactions()
          .aggregate<{ _id: TransactionStatus; count: number; amount: number }>([
            { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
          ])
          .toArray(),
      ]);

      const total = facet?.total[0]?.count ?? 0;
      const byStatus = new Map(statusRows.map((row) => [row._id, row]));
      return {
        items: (facet?.items ?? []).map(({ vendor, ...doc }) => ({
          ...serializeTransaction(doc),
          vendor: vendor
            ? {
                id: vendor._id.toHexString(),
                name: vendor.name,
                email: vendor.email,
                businessName: vendor.businessName ?? null,
              }
            : null,
        })),
        meta: { page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
        summary: {
          revenue: byStatus.get("paid")?.amount ?? 0,
          currency: PREMIUM_PLAN.currency,
          paid: byStatus.get("paid")?.count ?? 0,
          pending: byStatus.get("pending")?.count ?? 0,
          failed: byStatus.get("failed")?.count ?? 0,
          expired: byStatus.get("expired")?.count ?? 0,
        },
      };
    },
  };
}
