import { MongoServerError, ObjectId, type Db, type Document, type Filter } from "mongodb";
import { AUTH_COLLECTIONS } from "../config/database.js";
import {
  ACTIVE_BOOKING_STATUSES,
  toBookingView,
  type BookingDocument,
  type BookingStatus,
  type BookingView,
  type BookingWithRelations,
} from "../types/booking.js";
import { SERVICES_COLLECTION } from "./services.js";

export const BOOKINGS_COLLECTION = "bookings";

/** Joins the service plus both people involved, with only the fields the UI needs. */
const relationsLookup: Document[] = [
  {
    $lookup: {
      from: SERVICES_COLLECTION,
      localField: "serviceId",
      foreignField: "_id",
      as: "service",
      pipeline: [{ $project: { serviceName: 1, category: 1, images: { $slice: ["$images", 1] }, price: 1, location: 1 } }],
    },
  },
  { $unwind: { path: "$service", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: AUTH_COLLECTIONS.user,
      localField: "vendorId",
      foreignField: "_id",
      as: "vendor",
      pipeline: [{ $project: { name: 1, businessName: 1, image: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1 } }],
    },
  },
  { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: AUTH_COLLECTIONS.user,
      localField: "customerId",
      foreignField: "_id",
      as: "customer",
      pipeline: [{ $project: { name: 1, email: 1, image: 1, phone: 1 } }],
    },
  },
  { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
];

export class DuplicateBookingError extends Error {}

export type NewBooking = Omit<BookingDocument, "_id" | "status" | "createdAt" | "updatedAt">;
export type BookingOwner = { vendorId: string } | { customerId: string };

export type BookingStore = {
  hasActiveDuplicate(customerId: string, serviceId: ObjectId, eventDate: Date): Promise<boolean>;
  /** Throws DuplicateBookingError if the partial unique index rejects it (concurrent duplicate). */
  create(booking: NewBooking): Promise<BookingView>;
  listForCustomer(customerId: string, status?: BookingStatus): Promise<BookingView[]>;
  listForVendor(vendorId: string, status?: BookingStatus): Promise<BookingView[]>;
  findForCustomer(id: ObjectId, customerId: string): Promise<BookingView | null>;
  findRaw(id: ObjectId): Promise<BookingDocument | null>;
  /** Atomically moves a PENDING booking owned by `owner` to `to`. Null if nothing matched. */
  transitionFromPending(id: ObjectId, owner: BookingOwner, to: BookingStatus): Promise<BookingView | null>;
  /** BR-08: pending requests for a deleted service are cancelled. */
  cancelPendingForService(serviceId: ObjectId): Promise<number>;
};

export function createBookingStore(getDb: () => Db): BookingStore {
  const bookings = () => getDb().collection<BookingDocument>(BOOKINGS_COLLECTION);

  async function list(match: Filter<BookingDocument>) {
    const docs = await bookings()
      .aggregate<BookingWithRelations>([{ $match: match }, { $sort: { createdAt: -1, _id: 1 } }, { $limit: 200 }, ...relationsLookup])
      .toArray();
    const now = new Date();
    return docs.map((doc) => toBookingView(doc, now));
  }

  async function findView(match: Filter<BookingDocument>) {
    const [doc] = await bookings().aggregate<BookingWithRelations>([{ $match: match }, ...relationsLookup]).toArray();
    return doc ? toBookingView(doc) : null;
  }

  return {
    async hasActiveDuplicate(customerId, serviceId, eventDate) {
      const found = await bookings().findOne(
        { customerId: new ObjectId(customerId), serviceId, eventDate, status: { $in: ACTIVE_BOOKING_STATUSES } },
        { projection: { _id: 1 } },
      );
      return found !== null;
    },

    async create(booking) {
      const now = new Date();
      const doc: BookingDocument = { _id: new ObjectId(), ...booking, status: "pending", createdAt: now, updatedAt: now };
      try {
        await bookings().insertOne(doc);
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) throw new DuplicateBookingError();
        throw error;
      }
      return (await findView({ _id: doc._id }))!;
    },

    listForCustomer: (customerId, status) =>
      list({ customerId: new ObjectId(customerId), ...(status ? { status } : {}) }),

    listForVendor: (vendorId, status) => list({ vendorId: new ObjectId(vendorId), ...(status ? { status } : {}) }),

    findForCustomer: (id, customerId) => findView({ _id: id, customerId: new ObjectId(customerId) }),

    findRaw: (id) => bookings().findOne({ _id: id }),

    async transitionFromPending(id, owner, to) {
      const ownerFilter =
        "vendorId" in owner ? { vendorId: new ObjectId(owner.vendorId) } : { customerId: new ObjectId(owner.customerId) };
      // Ownership AND "still pending" are part of the filter, so two clicks or two
      // tabs can never process the same request twice (BR-10, BR-11).
      const updated = await bookings().findOneAndUpdate(
        { _id: id, ...ownerFilter, status: "pending" },
        { $set: { status: to, updatedAt: new Date() } },
        { returnDocument: "after", projection: { _id: 1 } },
      );
      return updated ? findView({ _id: id }) : null;
    },

    async cancelPendingForService(serviceId) {
      const result = await bookings().updateMany(
        { serviceId, status: "pending" },
        { $set: { status: "cancelled", updatedAt: new Date() } },
      );
      return result.modifiedCount;
    },
  };
}
