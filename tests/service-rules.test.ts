import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { buildPublicFilter, contentChanged, sortStage } from "../src/services/services.js";
import type { ServiceDocument } from "../src/types/service.js";
import {
  adminStatusSchema,
  escapeRegex,
  isHostedImageUrl,
  publicListQuerySchema,
  serviceInputSchema,
  serviceUpdateSchema,
} from "../src/validators/service.js";
import { validInput } from "./helpers.js";


describe("serviceInputSchema", () => {
  it("accepts a complete service", () => {
    expect(serviceInputSchema.parse(validInput)).toMatchObject({ price: 4500 });
  });

  it.each([
    ["short name", { serviceName: "ab" }],
    ["unknown category", { category: "fireworks" }],
    ["short description", { description: "Too short." }],
    ["fractional price", { price: 999.5 }],
    ["price as string", { price: "45000" }],
    ["too cheap", { price: 5 }],
    ["no images", { images: [] }],
    ["six images", { images: Array(6).fill(validInput.images[0]) }],
    ["foreign image host", { images: ["https://evil.example/x.jpg"] }],
    ["http image", { images: ["http://i.ibb.co/x.jpg"] }],
  ])("rejects %s", (_label, override) => {
    expect(serviceInputSchema.safeParse({ ...validInput, ...override }).success).toBe(false);
  });

  it("rejects unknown fields such as status or vendorId (no mass assignment)", () => {
    expect(serviceInputSchema.safeParse({ ...validInput, status: "approved" }).success).toBe(false);
    expect(serviceInputSchema.safeParse({ ...validInput, vendorId: new ObjectId().toHexString() }).success).toBe(false);
    expect(serviceUpdateSchema.safeParse({ isAvailable: true }).success).toBe(false);
    expect(serviceUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe("publicListQuerySchema", () => {
  it("applies defaults and coerces numbers from the query string", () => {
    expect(publicListQuerySchema.parse({ page: "2", minPrice: "1000", q: "  " })).toEqual({
      sort: "newest",
      page: 2,
      limit: 12,
      minPrice: 1000,
      q: undefined,
      location: undefined,
    });
  });

  it("rejects bad sort, oversized limits and inverted price ranges", () => {
    expect(publicListQuerySchema.safeParse({ sort: "random" }).success).toBe(false);
    expect(publicListQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(publicListQuerySchema.safeParse({ minPrice: "5000", maxPrice: "100" }).success).toBe(false);
    expect(publicListQuerySchema.safeParse({ category: ["venues", "catering"] }).success).toBe(false);
  });
});

describe("buildPublicFilter (BR-05)", () => {
  it("always restricts to approved and available services", () => {
    const filter = buildPublicFilter({ q: "photo", category: "venues", minPrice: 10, maxPrice: 99 });
    expect(filter).toMatchObject({ status: "approved", isAvailable: true, category: "venues", price: { $gte: 10, $lte: 99 } });
  });

  it("escapes search text so it can't inject regex", () => {
    const filter = buildPublicFilter({ q: "a.*(b" });
    expect(JSON.stringify(filter)).toContain("a\\\\.\\\\*\\\\(b");
    expect(escapeRegex("^$.|?*+()[]{}\\")).toBe("\\^\\$\\.\\|\\?\\*\\+\\(\\)\\[\\]\\{\\}\\\\");
  });

  it("maps sort options to stable sort stages", () => {
    expect(sortStage("price_asc")).toEqual({ price: 1, createdAt: -1, _id: 1 });
    expect(sortStage("price_desc")).toEqual({ price: -1, createdAt: -1, _id: 1 });
    expect(sortStage("newest")).toEqual({ createdAt: -1, _id: 1 });
  });
});

describe("contentChanged (BR-07)", () => {
  const existing = {
    ...validInput,
    _id: new ObjectId(),
    vendorId: new ObjectId(),
    status: "approved",
    isAvailable: true,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as ServiceDocument;

  it("detects real content changes only", () => {
    expect(contentChanged(existing, { price: 5000 })).toBe(true);
    expect(contentChanged(existing, { images: ["https://i.ibb.co/new/x.jpg"] })).toBe(true);
    expect(contentChanged(existing, { price: 4500, location: "Brooklyn, NY" })).toBe(false);
  });
});

describe("adminStatusSchema", () => {
  it("requires a reason when rejecting", () => {
    expect(adminStatusSchema.safeParse({ status: "rejected" }).success).toBe(false);
    expect(adminStatusSchema.safeParse({ status: "rejected", rejectionReason: "Photos are blurry" }).success).toBe(true);
    expect(adminStatusSchema.safeParse({ status: "approved" }).success).toBe(true);
    expect(adminStatusSchema.safeParse({ status: "published" }).success).toBe(false);
  });

  it("only accepts ImgBB https URLs as hosted images", () => {
    expect(isHostedImageUrl("https://i.ibb.co/x/y.png")).toBe(true);
    expect(isHostedImageUrl("https://i.ibb.co.evil.example/y.png")).toBe(false);
    expect(isHostedImageUrl("https://i.ibb.co/x/y.png?track=1")).toBe(false);
  });
});
