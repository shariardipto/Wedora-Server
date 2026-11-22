/**
 * Creates the MongoDB indexes Wedora relies on. Safe to run repeatedly.
 *
 *   npm run db:setup
 *
 * Better Auth's adapter already creates some auth indexes (e.g. unique email,
 * unique session token) under its own names; any index whose key already
 * exists is left untouched. Business collections are added in later phases.
 */
import dotenv from "dotenv";
import { closeDatabase, getDatabase } from "../config/database.js";

dotenv.config({ quiet: true });

type IndexSpec = {
  collection: string;
  key: Record<string, 1 | -1>;
  options?: {
    name: string;
    unique?: boolean;
    expireAfterSeconds?: number;
    partialFilterExpression?: Record<string, unknown>;
  };
};

export const INDEXES: IndexSpec[] = [
  // Better Auth
  { collection: "user", key: { email: 1 }, options: { name: "email_unique", unique: true } },
  { collection: "user", key: { role: 1, createdAt: -1 }, options: { name: "role_createdAt" } },
  { collection: "session", key: { token: 1 }, options: { name: "token_unique", unique: true } },
  { collection: "session", key: { userId: 1 }, options: { name: "userId" } },
  // Expired sessions are removed automatically by MongoDB.
  { collection: "session", key: { expiresAt: 1 }, options: { name: "expiresAt_ttl", expireAfterSeconds: 0 } },
  { collection: "account", key: { userId: 1 }, options: { name: "userId" } },
  { collection: "account", key: { providerId: 1, accountId: 1 }, options: { name: "provider_account" } },
  { collection: "verification", key: { identifier: 1 }, options: { name: "identifier" } },
  // Services: public browse (status+availability+category, price sort), vendor lists, newest
  { collection: "services", key: { status: 1, isAvailable: 1, category: 1, price: 1 }, options: { name: "public_browse" } },
  { collection: "services", key: { status: 1, isAvailable: 1, createdAt: -1 }, options: { name: "public_newest" } },
  { collection: "services", key: { vendorId: 1, createdAt: -1 }, options: { name: "vendor_services" } },
  // Bookings: customer and vendor lists, plus BR-09's duplicate guard enforced by the database
  { collection: "bookings", key: { customerId: 1, createdAt: -1 }, options: { name: "customer_bookings" } },
  { collection: "bookings", key: { vendorId: 1, status: 1, createdAt: -1 }, options: { name: "vendor_bookings" } },
  { collection: "bookings", key: { serviceId: 1, status: 1 }, options: { name: "service_status" } },
  {
    collection: "bookings",
    key: { customerId: 1, serviceId: 1, eventDate: 1 },
    options: {
      name: "active_booking_unique",
      unique: true,
      partialFilterExpression: { status: { $in: ["pending", "accepted"] } },
    },
  },
  // Billing: webhook idempotency (one row per Checkout session / invoice), vendor + admin history
  {
    collection: "transactions",
    key: { stripeSessionId: 1 },
    options: { name: "stripe_session_unique", unique: true, partialFilterExpression: { stripeSessionId: { $type: "string" } } },
  },
  {
    collection: "transactions",
    key: { stripeInvoiceId: 1 },
    options: { name: "stripe_invoice_unique", unique: true, partialFilterExpression: { stripeInvoiceId: { $type: "string" } } },
  },
  { collection: "transactions", key: { vendorId: 1, createdAt: -1 }, options: { name: "vendor_transactions" } },
  { collection: "transactions", key: { status: 1, createdAt: -1 }, options: { name: "status_createdAt" } },
  { collection: "transactions", key: { createdAt: -1 }, options: { name: "createdAt" } },
  // Webhook fallback lookup (invoice → vendor) when metadata is missing
  {
    collection: "user",
    key: { stripeCustomerId: 1 },
    options: { name: "stripe_customer", partialFilterExpression: { stripeCustomerId: { $type: "string" } } },
  },
];

const sameKey = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));

async function main() {
  const db = getDatabase();
  for (const spec of INDEXES) {
    const collection = db.collection(spec.collection);
    const existing = await collection.indexes().catch(() => []);
    const match = existing.find((index) => sameKey(index.key, spec.key));
    if (match) {
      console.info(`• ${spec.collection}.${match.name} (already present)`);
      continue;
    }
    const name = await collection.createIndex(spec.key, spec.options);
    console.info(`✓ ${spec.collection}.${name}`);
  }
  console.info(`Indexes ready in database "${db.databaseName}".`);
}

main()
  .catch((error) => {
    console.error("Database setup failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
