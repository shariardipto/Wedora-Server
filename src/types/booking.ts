import type { ObjectId } from "mongodb";
import type { ServiceCategory, VendorDocument, VendorSummary } from "./service.js";

export const BOOKING_STATUSES = ["pending", "accepted", "rejected", "cancelled"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Statuses that "hold" a date — a duplicate request for the same date is refused (BR-09). */
export const ACTIVE_BOOKING_STATUSES: BookingStatus[] = ["pending", "accepted"];

export type BookingDocument = {
  _id: ObjectId;
  serviceId: ObjectId;
  /** Copied from the service at request time — never taken from the client. */
  vendorId: ObjectId;
  customerId: ObjectId;
  /** Calendar date stored as UTC midnight. */
  eventDate: Date;
  eventLocation: string;
  message: string;
  status: BookingStatus;
  createdAt: Date;
  updatedAt: Date;
};

type JoinedService = {
  _id: ObjectId;
  serviceName: string;
  category: ServiceCategory;
  images?: string[];
  price: number;
  location: string;
};

type JoinedCustomer = {
  _id: ObjectId;
  name?: string;
  email?: string;
  image?: string | null;
  phone?: string | null;
};

export type BookingWithRelations = BookingDocument & {
  service?: JoinedService | null;
  vendor?: VendorDocument | null;
  customer?: JoinedCustomer | null;
};

export type BookingView = {
  id: string;
  serviceId: string;
  vendorId: string;
  customerId: string;
  /** YYYY-MM-DD */
  eventDate: string;
  eventLocation: string;
  message: string;
  status: BookingStatus;
  createdAt: string;
  updatedAt: string;
  /** null when the service has since been deleted. */
  service: {
    id: string;
    serviceName: string;
    category: ServiceCategory;
    image: string | null;
    price: number;
    location: string;
  } | null;
  vendor: VendorSummary | null;
  customer: { id: string; name: string; email: string; image: string | null; phone: string | null } | null;
};

export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function toBookingView(doc: BookingWithRelations, now = new Date()): BookingView {
  const vendor = doc.vendor;
  const expires = vendor?.subscriptionExpiresAt instanceof Date ? vendor.subscriptionExpiresAt : null;
  return {
    id: doc._id.toHexString(),
    serviceId: doc.serviceId.toHexString(),
    vendorId: doc.vendorId.toHexString(),
    customerId: doc.customerId.toHexString(),
    eventDate: toDateOnly(doc.eventDate),
    eventLocation: doc.eventLocation,
    message: doc.message ?? "",
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    service: doc.service
      ? {
          id: doc.service._id.toHexString(),
          serviceName: doc.service.serviceName,
          category: doc.service.category,
          image: doc.service.images?.[0] ?? null,
          price: doc.service.price,
          location: doc.service.location,
        }
      : null,
    vendor: vendor
      ? {
          id: vendor._id.toHexString(),
          name: vendor.name ?? "Wedora vendor",
          businessName: vendor.businessName ?? null,
          image: vendor.image ?? null,
          isPremium: vendor.subscriptionPlan === "premium" && expires !== null && expires > now,
        }
      : null,
    customer: doc.customer
      ? {
          id: doc.customer._id.toHexString(),
          name: doc.customer.name ?? "Wedora customer",
          email: doc.customer.email ?? "",
          image: doc.customer.image ?? null,
          phone: doc.customer.phone ?? null,
        }
      : null,
  };
}
