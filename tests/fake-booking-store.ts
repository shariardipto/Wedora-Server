import { ObjectId } from "mongodb";
import { DuplicateBookingError, type BookingStore } from "../src/services/bookings.js";
import { ACTIVE_BOOKING_STATUSES, toBookingView, type BookingDocument } from "../src/types/booking.js";

/** In-memory BookingStore. `create` mimics the partial unique index (BR-09). */
export function createFakeBookingStore() {
  const docs = new Map<string, BookingDocument>();
  const view = (doc: BookingDocument) => toBookingView(doc);
  const sameDay = (a: Date, b: Date) => a.getTime() === b.getTime();
  const isActiveDuplicate = (customerId: ObjectId, serviceId: ObjectId, eventDate: Date) =>
    [...docs.values()].some(
      (d) =>
        d.customerId.equals(customerId) &&
        d.serviceId.equals(serviceId) &&
        sameDay(d.eventDate, eventDate) &&
        ACTIVE_BOOKING_STATUSES.includes(d.status),
    );

  const store: BookingStore = {
    async hasActiveDuplicate(customerId, serviceId, eventDate) {
      return isActiveDuplicate(new ObjectId(customerId), serviceId, eventDate);
    },
    async create(booking) {
      if (isActiveDuplicate(booking.customerId, booking.serviceId, booking.eventDate)) throw new DuplicateBookingError();
      const now = new Date();
      const doc: BookingDocument = { _id: new ObjectId(), ...booking, status: "pending", createdAt: now, updatedAt: now };
      docs.set(doc._id.toHexString(), doc);
      return view(doc);
    },
    async listForCustomer(customerId, status) {
      return [...docs.values()].filter((d) => d.customerId.toHexString() === customerId && (!status || d.status === status)).map(view);
    },
    async listForVendor(vendorId, status) {
      return [...docs.values()].filter((d) => d.vendorId.toHexString() === vendorId && (!status || d.status === status)).map(view);
    },
    async findForCustomer(id, customerId) {
      const doc = docs.get(id.toHexString());
      return doc && doc.customerId.toHexString() === customerId ? view(doc) : null;
    },
    async findRaw(id) {
      return docs.get(id.toHexString()) ?? null;
    },
    async transitionFromPending(id, owner, to) {
      const doc = docs.get(id.toHexString());
      if (!doc || doc.status !== "pending") return null;
      const owned = "vendorId" in owner ? doc.vendorId.toHexString() === owner.vendorId : doc.customerId.toHexString() === owner.customerId;
      if (!owned) return null;
      doc.status = to;
      doc.updatedAt = new Date();
      return view(doc);
    },
    async cancelPendingForService(serviceId) {
      let count = 0;
      for (const doc of docs.values()) {
        if (doc.serviceId.equals(serviceId) && doc.status === "pending") {
          doc.status = "cancelled";
          count += 1;
        }
      }
      return count;
    },
  };

  return { store, docs };
}
