import { z } from "zod";
import { TRANSACTION_STATUSES } from "../types/transaction.js";

/** Stripe Checkout session ids, e.g. `cs_test_a1B2…`. */
export const CHECKOUT_SESSION_ID = /^cs_(?:test|live)_[A-Za-z0-9]{10,250}$/;

export const billingStatusQuerySchema = z.object({
  session_id: z
    .string()
    .regex(CHECKOUT_SESSION_ID, "That checkout reference is not valid.")
    .optional(),
});

export const adminTransactionQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((value) => (value ? value : undefined)),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type AdminTransactionQuery = z.infer<typeof adminTransactionQuerySchema>;
