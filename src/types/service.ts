import type { ObjectId } from "mongodb";

/** The six fixed categories — keep in sync with the client's lib/categories.ts. */
export const SERVICE_CATEGORIES = [
  "photography-videography",
  "venues",
  "decoration-florist",
  "catering",
  "makeup-styling",
  "fashion",
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** Admin review state. Availability is a separate vendor-controlled flag (D007). */
export const SERVICE_STATUSES = ["pending", "approved", "rejected"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/** Free vendors may have at most this many active services (BR-06). */
export const FREE_PLAN_ACTIVE_LIMIT = 3;

export type ServiceDocument = {
  _id: ObjectId;
  vendorId: ObjectId;
  serviceName: string;
  category: ServiceCategory;
  description: string;
  /** Whole US dollars (USD). */
  price: number;
  location: string;
  images: string[];
  status: ServiceStatus;
  isAvailable: boolean;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Vendor fields joined from Better Auth's `user` collection. */
export type VendorDocument = {
  _id: ObjectId;
  name?: string;
  businessName?: string | null;
  image?: string | null;
  isBlocked?: boolean;
  subscriptionPlan?: string;
  subscriptionExpiresAt?: Date | null;
};

export type ServiceWithVendor = ServiceDocument & { vendor?: VendorDocument | null };

export type VendorSummary = {
  id: string;
  name: string;
  businessName: string | null;
  image: string | null;
  isPremium: boolean;
};

export type ServiceView = {
  id: string;
  vendorId: string;
  serviceName: string;
  category: ServiceCategory;
  description: string;
  price: number;
  location: string;
  images: string[];
  status: ServiceStatus;
  isAvailable: boolean;
  rejectionReason: string | null;
  /** Approved, available and offered by an active vendor (BR-05). */
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
  vendor: VendorSummary | null;
};

function toVendorSummary(vendor: VendorDocument | null | undefined, now: Date): VendorSummary | null {
  if (!vendor) return null;
  const expires = vendor.subscriptionExpiresAt instanceof Date ? vendor.subscriptionExpiresAt : null;
  return {
    id: vendor._id.toHexString(),
    name: vendor.name ?? "Wedora vendor",
    businessName: vendor.businessName ?? null,
    image: vendor.image ?? null,
    isPremium: vendor.subscriptionPlan === "premium" && expires !== null && expires > now,
  };
}

export function isPubliclyVisible(doc: ServiceWithVendor): boolean {
  return (
    doc.status === "approved" &&
    doc.isAvailable === true &&
    Boolean(doc.vendor) &&
    doc.vendor?.isBlocked !== true
  );
}

export function toServiceView(doc: ServiceWithVendor, now = new Date()): ServiceView {
  return {
    id: doc._id.toHexString(),
    vendorId: doc.vendorId.toHexString(),
    serviceName: doc.serviceName,
    category: doc.category,
    description: doc.description,
    price: doc.price,
    location: doc.location,
    images: doc.images,
    status: doc.status,
    isAvailable: doc.isAvailable,
    rejectionReason: doc.rejectionReason ?? null,
    isPublic: isPubliclyVisible(doc),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    vendor: toVendorSummary(doc.vendor, now),
  };
}

export type Paged<T> = {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
};
