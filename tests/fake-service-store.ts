import { ObjectId } from "mongodb";
import { ACTIVE_STATUSES, type ServiceStore } from "../src/services/services.js";
import {
  SERVICE_CATEGORIES,
  toServiceView,
  type ServiceDocument,
  type VendorDocument,
} from "../src/types/service.js";

/** In-memory ServiceStore for route tests (business rules live in the routes). */
export function createFakeServiceStore(vendors: VendorDocument[] = []) {
  const docs = new Map<string, ServiceDocument>();
  const vendorById = new Map(vendors.map((v) => [v._id.toHexString(), v]));
  const withVendor = (doc: ServiceDocument) => ({ ...doc, vendor: vendorById.get(doc.vendorId.toHexString()) ?? null });
  const view = (doc: ServiceDocument) => toServiceView(withVendor(doc));
  const page = <T>(items: T[]) => ({ items, meta: { page: 1, limit: 12, total: items.length, totalPages: 1 } });

  const store: ServiceStore = {
    async listPublic() {
      return page([...docs.values()].map(view).filter((s) => s.isPublic));
    },
    async featured(limit) {
      return [...docs.values()].map(view).filter((s) => s.isPublic).slice(0, limit);
    },
    async categoryCounts() {
      const pub = [...docs.values()].map(view).filter((s) => s.isPublic);
      return SERVICE_CATEGORIES.map((category) => ({ category, count: pub.filter((s) => s.category === category).length }));
    },
    async findById(id) {
      const doc = docs.get(id.toHexString());
      return doc ? view(doc) : null;
    },
    async listByVendor(vendorId, status) {
      return [...docs.values()]
        .filter((d) => d.vendorId.toHexString() === vendorId && (!status || d.status === status))
        .map(view);
    },
    async countActive(vendorId, excludeId) {
      return [...docs.values()].filter(
        (d) =>
          d.vendorId.toHexString() === vendorId &&
          ACTIVE_STATUSES.includes(d.status) &&
          d.isAvailable &&
          (!excludeId || !d._id.equals(excludeId)),
      ).length;
    },
    async findOwnedRaw(id, vendorId) {
      const doc = docs.get(id.toHexString());
      return doc && doc.vendorId.toHexString() === vendorId ? doc : null;
    },
    async create(vendorId, input) {
      const now = new Date();
      const doc: ServiceDocument = {
        _id: new ObjectId(),
        vendorId: new ObjectId(vendorId),
        ...input,
        status: "pending",
        isAvailable: true,
        rejectionReason: null,
        createdAt: now,
        updatedAt: now,
      };
      docs.set(doc._id.toHexString(), doc);
      return view(doc);
    },
    async update(id, vendorId, set) {
      const doc = docs.get(id.toHexString());
      if (!doc || doc.vendorId.toHexString() !== vendorId) return null;
      Object.assign(doc, set, { updatedAt: new Date() });
      return view(doc);
    },
    async remove(id, vendorId) {
      const doc = docs.get(id.toHexString());
      if (!doc || (vendorId && doc.vendorId.toHexString() !== vendorId)) return false;
      return docs.delete(id.toHexString());
    },
    async listAll() {
      return page([...docs.values()].map(view));
    },
    async setStatus(id, status, reason) {
      const doc = docs.get(id.toHexString());
      if (!doc) return null;
      Object.assign(doc, { status, rejectionReason: status === "rejected" ? reason : null });
      return view(doc);
    },
  };

  /** Insert a service directly in any state (test setup). */
  function seed(vendorId: ObjectId, overrides: Partial<ServiceDocument> = {}) {
    const now = new Date();
    const doc: ServiceDocument = {
      _id: new ObjectId(),
      vendorId,
      serviceName: "Seeded Service",
      category: "venues",
      description: "A seeded service description that is long enough to pass validation rules.",
      price: 1200,
      location: "Austin, TX",
      images: ["https://i.ibb.co/seed/x.jpg"],
      status: "approved",
      isAvailable: true,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    docs.set(doc._id.toHexString(), doc);
    return doc;
  }

  return { store, docs, seed };
}
