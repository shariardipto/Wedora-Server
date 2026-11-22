import { ObjectId, type Db } from "mongodb";
import { AUTH_COLLECTIONS } from "../config/database.js";
import type { BookingDocument, BookingStatus } from "../types/booking.js";
import type { ServiceDocument } from "../types/service.js";
import { TRANSACTIONS_COLLECTION } from "../types/transaction.js";
import { BOOKINGS_COLLECTION } from "./bookings.js";
import { ACTIVE_STATUSES, SERVICES_COLLECTION } from "./services.js";

export type VendorStats = {
  totalServices: number;
  /** Pending or approved AND available — the number the Free plan limit counts. */
  activeServices: number;
  /** Approved and available — what customers can see right now. */
  liveServices: number;
  pendingReviewServices: number;
  pendingBookings: number;
  acceptedBookings: number;
};

export type CustomerStats = {
  totalBookings: number;
  pendingBookings: number;
  acceptedBookings: number;
  rejectedBookings: number;
  cancelledBookings: number;
};

export type AdminStats = {
  totalUsers: number;
  totalVendors: number;
  totalCustomers: number;
  blockedUsers: number;
  totalServices: number;
  pendingServices: number;
  totalTransactions: number;
};

export type StatsStore = {
  vendor(vendorId: string): Promise<VendorStats>;
  customer(customerId: string): Promise<CustomerStats>;
  admin(): Promise<AdminStats>;
};

/** Turns `[{ _id: status, count }]` into `{ status: count }`. */
function tally<K extends string>(rows: { _id: K; count: number }[]): Partial<Record<K, number>> {
  return Object.fromEntries(rows.map((row) => [row._id, row.count])) as Partial<Record<K, number>>;
}

export function createStatsStore(getDb: () => Db): StatsStore {
  const services = () => getDb().collection<ServiceDocument>(SERVICES_COLLECTION);
  const bookings = () => getDb().collection<BookingDocument>(BOOKINGS_COLLECTION);
  const users = () => getDb().collection(AUTH_COLLECTIONS.user);

  const bookingCounts = async (match: Record<string, unknown>) =>
    tally<BookingStatus>(
      await bookings()
        .aggregate<{ _id: BookingStatus; count: number }>([
          { $match: match },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ])
        .toArray(),
    );

  return {
    async vendor(vendorId) {
      const vendor = new ObjectId(vendorId);
      const [serviceRows, byStatus] = await Promise.all([
        services()
          .aggregate<{ total: number; active: number; live: number; pendingReview: number }>([
            { $match: { vendorId: vendor } },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                active: {
                  $sum: { $cond: [{ $and: [{ $in: ["$status", ACTIVE_STATUSES] }, "$isAvailable"] }, 1, 0] },
                },
                live: {
                  $sum: { $cond: [{ $and: [{ $eq: ["$status", "approved"] }, "$isAvailable"] }, 1, 0] },
                },
                pendingReview: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
              },
            },
          ])
          .toArray(),
        bookingCounts({ vendorId: vendor }),
      ]);
      const row = serviceRows[0];
      return {
        totalServices: row?.total ?? 0,
        activeServices: row?.active ?? 0,
        liveServices: row?.live ?? 0,
        pendingReviewServices: row?.pendingReview ?? 0,
        pendingBookings: byStatus.pending ?? 0,
        acceptedBookings: byStatus.accepted ?? 0,
      };
    },

    async customer(customerId) {
      const byStatus = await bookingCounts({ customerId: new ObjectId(customerId) });
      const pending = byStatus.pending ?? 0;
      const accepted = byStatus.accepted ?? 0;
      const rejected = byStatus.rejected ?? 0;
      const cancelled = byStatus.cancelled ?? 0;
      return {
        totalBookings: pending + accepted + rejected + cancelled,
        pendingBookings: pending,
        acceptedBookings: accepted,
        rejectedBookings: rejected,
        cancelledBookings: cancelled,
      };
    },

    async admin() {
      const [roleRows, blockedUsers, totalServices, pendingServices, totalTransactions] = await Promise.all([
        users()
          .aggregate<{ _id: string | null; count: number }>([{ $group: { _id: "$role", count: { $sum: 1 } } }])
          .toArray(),
        users().countDocuments({ isBlocked: true }),
        services().countDocuments({}),
        services().countDocuments({ status: "pending" }),
        getDb().collection(TRANSACTIONS_COLLECTION).countDocuments({}),
      ]);
      const roles = new Map(roleRows.map((row) => [row._id, row.count]));
      return {
        totalUsers: roleRows.reduce((sum, row) => sum + row.count, 0),
        totalVendors: roles.get("vendor") ?? 0,
        totalCustomers: roles.get("customer") ?? 0,
        blockedUsers,
        totalServices,
        pendingServices,
        totalTransactions,
      };
    },
  };
}
