import { z } from "zod";
import { BOOKING_STATUSES } from "../types/booking.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_BOOKING_YEARS_AHEAD = 2;

/** "YYYY-MM-DD" → UTC-midnight Date, or null if it isn't a real calendar date. */
export function parseDateOnly(value: string): Date | null {
  if (!DATE_ONLY.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function utcToday(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Event dates must be today (UTC) or later, and at most two years ahead.
 * "Today in UTC" is used so a customer in the Americas can still pick their
 * local "tomorrow" late in the evening.
 */
export function eventDateProblem(value: string, now = new Date()): string | null {
  const date = parseDateOnly(value);
  if (!date) return "Choose a valid event date.";
  const today = utcToday(now);
  if (date < today) return "The event date must be in the future.";
  const limit = new Date(today);
  limit.setUTCFullYear(limit.getUTCFullYear() + MAX_BOOKING_YEARS_AHEAD);
  if (date > limit) return `Event dates can be at most ${MAX_BOOKING_YEARS_AHEAD} years ahead.`;
  return null;
}

export const createBookingSchema = z.strictObject({
  serviceId: z.string({ error: "Choose a service to book." }).regex(/^[a-f\d]{24}$/i, "Choose a valid service."),
  eventDate: z
    .string({ error: "Choose an event date." })
    .superRefine((value, ctx) => {
      const problem = eventDateProblem(value);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  eventLocation: z
    .string({ error: "Enter the event location." })
    .trim()
    .min(3, "Event location must be at least 3 characters.")
    .max(200, "Event location must be 200 characters or fewer."),
  message: z
    .string()
    .trim()
    .max(1000, "Your message must be 1,000 characters or fewer.")
    .optional()
    .default(""),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const vendorDecisionSchema = z.strictObject({
  status: z.enum(["accepted", "rejected"], { error: "Choose accept or reject." }),
});

export const bookingListQuerySchema = z.object({
  status: z.enum(BOOKING_STATUSES).optional(),
});
