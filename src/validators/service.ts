import { z } from "zod";
import { SERVICE_CATEGORIES, SERVICE_STATUSES } from "../types/service.js";

/** Service images must be ImgBB uploads made through Wedora. */
export function isHostedImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "i.ibb.co" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

const text = (label: string, min: number, max: number) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(min, `${label} must be at least ${min} characters.`)
    .max(max, `${label} must be ${max} characters or fewer.`);

export const serviceInputSchema = z.strictObject({
  serviceName: text("Service name", 3, 100),
  category: z.enum(SERVICE_CATEGORIES, { error: "Choose a valid category." }),
  description: text("Description", 30, 2000),
  price: z
    .number({ error: "Price must be a number." })
    .int("Price must be a whole number of dollars.")
    .min(10, "Price must be at least $10.")
    .max(1_000_000, "Price must be $1,000,000 or less."),
  location: text("Location", 2, 100),
  images: z
    .array(z.string().refine(isHostedImageUrl, "Images must be uploaded through Wedora."), {
      error: "Add at least one image.",
    })
    .min(1, "Add at least one image.")
    .max(5, "You can add up to 5 images."),
});
export type ServiceInput = z.infer<typeof serviceInputSchema>;

export const serviceUpdateSchema = serviceInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Send at least one field to update.");
export type ServiceUpdate = z.infer<typeof serviceUpdateSchema>;

export const availabilitySchema = z.strictObject({
  isAvailable: z.boolean({ error: "isAvailable must be true or false." }),
});

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

const optionalPrice = z.coerce.number().int().min(0).max(1_000_000).optional();

export const SORT_OPTIONS = ["newest", "price_asc", "price_desc"] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

/** Public browse query (BR-05 is applied by the store, not the caller). */
export const publicListQuerySchema = z
  .object({
    q: optionalText(80),
    category: z.enum(SERVICE_CATEGORIES).optional(),
    location: optionalText(80),
    minPrice: optionalPrice,
    maxPrice: optionalPrice,
    sort: z.enum(SORT_OPTIONS).default("newest"),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(24).default(12),
  })
  .refine(
    (value) => value.minPrice === undefined || value.maxPrice === undefined || value.minPrice <= value.maxPrice,
    { message: "Minimum price can't be above maximum price.", path: ["minPrice"] },
  );
export type PublicListQuery = z.infer<typeof publicListQuerySchema>;

export const adminListQuerySchema = z.object({
  q: optionalText(80),
  category: z.enum(SERVICE_CATEGORIES).optional(),
  status: z.enum(SERVICE_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type AdminListQuery = z.infer<typeof adminListQuerySchema>;

export const vendorListQuerySchema = z.object({
  status: z.enum(SERVICE_STATUSES).optional(),
});

export const featuredQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(12).default(8),
});

export const adminStatusSchema = z
  .strictObject({
    status: z.enum(SERVICE_STATUSES, { error: "Choose pending, approved or rejected." }),
    rejectionReason: z.string().trim().min(5, "Give a short reason (5+ characters).").max(300).optional(),
  })
  .refine((value) => value.status !== "rejected" || Boolean(value.rejectionReason), {
    message: "A reason is required when rejecting a service.",
    path: ["rejectionReason"],
  });
export type AdminStatusInput = z.infer<typeof adminStatusSchema>;

/** Escape user text before using it inside a RegExp (no regex injection). */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
