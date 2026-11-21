import { ObjectId, type Collection, type Db, type Document, type Filter } from "mongodb";
import { AUTH_COLLECTIONS } from "../config/database.js";
import {
  SERVICE_CATEGORIES,
  toServiceView,
  type Paged,
  type ServiceCategory,
  type ServiceDocument,
  type ServiceStatus,
  type ServiceView,
  type ServiceWithVendor,
} from "../types/service.js";
import {
  escapeRegex,
  type AdminListQuery,
  type PublicListQuery,
  type ServiceInput,
  type ServiceUpdate,
  type SortOption,
} from "../validators/service.js";

export const SERVICES_COLLECTION = "services";

// ---------------------------------------------------------------------------
// Pure query builders (unit-tested)
// ---------------------------------------------------------------------------

/** Statuses that count toward the free-plan limit when the service is available. */
export const ACTIVE_STATUSES: ServiceStatus[] = ["pending", "approved"];

/** Filter for what customers may see: approved AND available (BR-05). */
export function buildPublicFilter(query: Partial<PublicListQuery>): Filter<ServiceDocument> {
  const filter: Filter<ServiceDocument> = { status: "approved", isAvailable: true };
  if (query.category) filter.category = query.category;
  if (query.location) filter.location = { $regex: escapeRegex(query.location), $options: "i" };
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    filter.price = {
      ...(query.minPrice !== undefined ? { $gte: query.minPrice } : {}),
      ...(query.maxPrice !== undefined ? { $lte: query.maxPrice } : {}),
    };
  }
  if (query.q) {
    const pattern = { $regex: escapeRegex(query.q), $options: "i" };
    filter.$or = [{ serviceName: pattern }, { description: pattern }, { location: pattern }];
  }
  return filter;
}

export function sortStage(sort: SortOption): Record<string, 1 | -1> {
  if (sort === "price_asc") return { price: 1, createdAt: -1, _id: 1 };
  if (sort === "price_desc") return { price: -1, createdAt: -1, _id: 1 };
  return { createdAt: -1, _id: 1 };
}

const vendorLookup: Document[] = [
  {
    $lookup: {
      from: AUTH_COLLECTIONS.user,
      localField: "vendorId",
      foreignField: "_id",
      as: "vendor",
      pipeline: [
        {
          $project: {
            name: 1,
            businessName: 1,
            image: 1,
            isBlocked: 1,
            subscriptionPlan: 1,
            subscriptionExpiresAt: 1,
          },
        },
      ],
    },
  },
  { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
];

/** Hide services of deleted or blocked vendors from the public. */
const activeVendorOnly: Document = {
  $match: { vendor: { $ne: null }, "vendor.isBlocked": { $ne: true } },
};

async function paginate(
  collection: Collection<ServiceDocument>,
  pipeline: Document[],
  page: number,
  limit: number,
): Promise<Paged<ServiceView>> {
  const [result] = await collection
    .aggregate<{ items: ServiceWithVendor[]; total: { count: number }[] }>([
      ...pipeline,
      {
        $facet: {
          items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
          total: [{ $count: "count" }],
        },
      },
    ])
    .toArray();
  const total = result?.total[0]?.count ?? 0;
  const now = new Date();
  return {
    items: (result?.items ?? []).map((doc) => toServiceView(doc, now)),
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type CategoryCount = { category: ServiceCategory; count: number };

export type ServiceStore = {
  listPublic(query: PublicListQuery): Promise<Paged<ServiceView>>;
  featured(limit: number): Promise<ServiceView[]>;
  categoryCounts(): Promise<CategoryCount[]>;
  findById(id: ObjectId): Promise<ServiceView | null>;
  listByVendor(vendorId: string, status?: ServiceStatus): Promise<ServiceView[]>;
  countActive(vendorId: string, excludeId?: ObjectId): Promise<number>;
  findOwnedRaw(id: ObjectId, vendorId: string): Promise<ServiceDocument | null>;
  create(vendorId: string, input: ServiceInput): Promise<ServiceView>;
  update(id: ObjectId, vendorId: string, set: Partial<ServiceDocument>): Promise<ServiceView | null>;
  remove(id: ObjectId, vendorId?: string): Promise<boolean>;
  listAll(query: AdminListQuery): Promise<Paged<ServiceView>>;
  setStatus(id: ObjectId, status: ServiceStatus, reason: string | null): Promise<ServiceView | null>;
};

export function createServiceStore(getDb: () => Db): ServiceStore {
  const services = () => getDb().collection<ServiceDocument>(SERVICES_COLLECTION);

  async function findViewById(id: ObjectId): Promise<ServiceView | null> {
    const [doc] = await services()
      .aggregate<ServiceWithVendor>([{ $match: { _id: id } }, ...vendorLookup])
      .toArray();
    return doc ? toServiceView(doc) : null;
  }

  return {
    async listPublic(query) {
      return paginate(
        services(),
        [
          { $match: buildPublicFilter(query) },
          { $sort: sortStage(query.sort) },
          ...vendorLookup,
          activeVendorOnly,
        ],
        query.page,
        query.limit,
      );
    },

    async featured(limit) {
      const docs = await services()
        .aggregate<ServiceWithVendor>([
          { $match: buildPublicFilter({}) },
          { $sort: { createdAt: -1 } },
          { $limit: limit * 2 }, // headroom for services of blocked vendors
          ...vendorLookup,
          activeVendorOnly,
          { $limit: limit },
        ])
        .toArray();
      const now = new Date();
      return docs.map((doc) => toServiceView(doc, now));
    },

    async categoryCounts() {
      const rows = await services()
        .aggregate<{ _id: ServiceCategory; count: number }>([
          { $match: buildPublicFilter({}) },
          ...vendorLookup,
          activeVendorOnly,
          { $group: { _id: "$category", count: { $sum: 1 } } },
        ])
        .toArray();
      const counts = new Map(rows.map((row) => [row._id, row.count]));
      return SERVICE_CATEGORIES.map((category) => ({ category, count: counts.get(category) ?? 0 }));
    },

    findById: findViewById,

    async listByVendor(vendorId, status) {
      const docs = await services()
        .aggregate<ServiceWithVendor>([
          { $match: { vendorId: new ObjectId(vendorId), ...(status ? { status } : {}) } },
          { $sort: { createdAt: -1 } },
          ...vendorLookup,
        ])
        .toArray();
      const now = new Date();
      return docs.map((doc) => toServiceView(doc, now));
    },

    async countActive(vendorId, excludeId) {
      return services().countDocuments({
        vendorId: new ObjectId(vendorId),
        status: { $in: ACTIVE_STATUSES },
        isAvailable: true,
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      });
    },

    async findOwnedRaw(id, vendorId) {
      return services().findOne({ _id: id, vendorId: new ObjectId(vendorId) });
    },

    async create(vendorId, input) {
      const now = new Date();
      const doc: ServiceDocument = {
        _id: new ObjectId(),
        vendorId: new ObjectId(vendorId),
        ...input,
        status: "pending", // every new service waits for admin review
        isAvailable: true,
        rejectionReason: null,
        createdAt: now,
        updatedAt: now,
      };
      await services().insertOne(doc);
      return (await findViewById(doc._id))!;
    },

    async update(id, vendorId, set) {
      // Ownership is part of the filter: another vendor's id simply matches nothing.
      const result = await services().updateOne(
        { _id: id, vendorId: new ObjectId(vendorId) },
        { $set: { ...set, updatedAt: new Date() } },
      );
      return result.matchedCount === 1 ? findViewById(id) : null;
    },

    async remove(id, vendorId) {
      const result = await services().deleteOne({
        _id: id,
        ...(vendorId ? { vendorId: new ObjectId(vendorId) } : {}),
      });
      return result.deletedCount === 1;
    },

    async listAll(query) {
      const match: Filter<ServiceDocument> = {};
      if (query.status) match.status = query.status;
      if (query.category) match.category = query.category;
      const pipeline: Document[] = [{ $match: match }, { $sort: { createdAt: -1, _id: 1 } }, ...vendorLookup];
      if (query.q) {
        const pattern = { $regex: escapeRegex(query.q), $options: "i" };
        pipeline.push({
          $match: {
            $or: [
              { serviceName: pattern },
              { location: pattern },
              { "vendor.name": pattern },
              { "vendor.businessName": pattern },
            ],
          },
        });
      }
      return paginate(services(), pipeline, query.page, query.limit);
    },

    async setStatus(id, status, reason) {
      const result = await services().updateOne(
        { _id: id },
        { $set: { status, rejectionReason: status === "rejected" ? reason : null, updatedAt: new Date() } },
      );
      return result.matchedCount === 1 ? findViewById(id) : null;
    },
  };
}

/** Fields whose change sends an approved/rejected service back to review (BR-07). */
export const REVIEWED_FIELDS: (keyof ServiceUpdate)[] = [
  "serviceName",
  "category",
  "description",
  "price",
  "location",
  "images",
];

export function contentChanged(existing: ServiceDocument, update: ServiceUpdate): boolean {
  return REVIEWED_FIELDS.some((field) => {
    if (!(field in update)) return false;
    const next = update[field];
    const current = existing[field as keyof ServiceDocument];
    return JSON.stringify(next) !== JSON.stringify(current);
  });
}
