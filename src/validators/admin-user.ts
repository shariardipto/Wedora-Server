import { z } from "zod";
import { USER_ROLES } from "../types/user.js";

export const adminUserListQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((value) => (value ? value : undefined)),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(["active", "blocked"]).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

export const blockUserSchema = z.strictObject({
  isBlocked: z.boolean({ error: "isBlocked must be true or false." }),
});
