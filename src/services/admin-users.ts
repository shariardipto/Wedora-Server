import { ObjectId, type Db, type Filter } from "mongodb";
import { AUTH_COLLECTIONS } from "../config/database.js";
import type { BookingDocument } from "../types/booking.js";
import type { Paged, ServiceDocument } from "../types/service.js";
import { serializeUser, toAppUser, type UserDocument } from "../types/user.js";
import { escapeRegex } from "../validators/service.js";
import type { AdminUserListQuery } from "../validators/admin-user.js";
import { BOOKINGS_COLLECTION } from "./bookings.js";
import { SERVICES_COLLECTION } from "./services.js";

export type AdminUserView = ReturnType<typeof serializeUser>;

export type AdminUserDetails = AdminUserView & {
  activity: {
    /** Vendors */
    services: number;
    liveServices: number;
    bookingRequestsReceived: number;
    /** Customers */
    bookingRequestsSent: number;
  };
};

export type AdminUserStore = {
  list(query: AdminUserListQuery): Promise<Paged<AdminUserView>>;
  details(id: ObjectId): Promise<AdminUserDetails | null>;
  /**
   * Blocks/unblocks a NON-admin user. Returns null when no such non-admin user
   * exists — admins can never be blocked through the API.
   */
  setBlocked(id: ObjectId, isBlocked: boolean): Promise<AdminUserView | null>;
  /** Signs the user out everywhere by deleting their sessions. */
  revokeSessions(id: ObjectId): Promise<number>;
};

export function createAdminUserStore(getDb: () => Db): AdminUserStore {
  const users = () => getDb().collection<UserDocument>(AUTH_COLLECTIONS.user);
  const services = () => getDb().collection<ServiceDocument>(SERVICES_COLLECTION);
  const bookings = () => getDb().collection<BookingDocument>(BOOKINGS_COLLECTION);

  return {
    async list(query) {
      const filter: Filter<UserDocument> = {};
      if (query.role) filter.role = query.role;
      if (query.status) filter.isBlocked = query.status === "blocked" ? true : { $ne: true };
      if (query.q) {
        const pattern = { $regex: escapeRegex(query.q), $options: "i" };
        filter.$or = [{ name: pattern }, { email: pattern }, { businessName: pattern }];
      }
      const [docs, total] = await Promise.all([
        users()
          .find(filter, { projection: { stripeCustomerId: 0, stripeSubscriptionId: 0 } })
          .sort({ createdAt: -1, _id: 1 })
          .skip((query.page - 1) * query.limit)
          .limit(query.limit)
          .toArray(),
        users().countDocuments(filter),
      ]);
      const now = new Date();
      return {
        items: docs.map((doc) => serializeUser(toAppUser(doc, now))),
        meta: { page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
      };
    },

    async details(id) {
      const doc = await users().findOne({ _id: id });
      if (!doc) return null;
      const [servicesCount, liveServices, received, sent] = await Promise.all([
        services().countDocuments({ vendorId: id }),
        services().countDocuments({ vendorId: id, status: "approved", isAvailable: true }),
        bookings().countDocuments({ vendorId: id }),
        bookings().countDocuments({ customerId: id }),
      ]);
      return {
        ...serializeUser(toAppUser(doc)),
        activity: {
          services: servicesCount,
          liveServices,
          bookingRequestsReceived: received,
          bookingRequestsSent: sent,
        },
      };
    },

    async setBlocked(id, isBlocked) {
      const doc = await users().findOneAndUpdate(
        { _id: id, role: { $ne: "admin" } },
        { $set: { isBlocked, updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      return doc ? serializeUser(toAppUser(doc)) : null;
    },

    async revokeSessions(id) {
      // Better Auth's adapter stores userId as an ObjectId; match the string form too, defensively.
      const result = await getDb()
        .collection(AUTH_COLLECTIONS.session)
        .deleteMany({ userId: { $in: [id, id.toHexString()] } });
      return result.deletedCount;
    },
  };
}
