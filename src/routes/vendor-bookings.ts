import { Router } from "express";
import { parseObjectId } from "../lib/object-id.js";
import { currentUser, requireRole, type Authenticator } from "../middleware/auth.js";
import type { BookingStore } from "../services/bookings.js";
import { bookingListQuerySchema, vendorDecisionSchema } from "../validators/booking.js";
import { explainFailedTransition } from "./bookings.js";

/** Vendor-side booking requests (BR-10). */
export function createVendorBookingsRouter(authenticate: Authenticator, bookings: BookingStore) {
  const router = Router();
  router.use("/api/vendor/bookings", authenticate(), requireRole("vendor"));

  // Requests for this vendor's services only.
  router.get("/api/vendor/bookings", async (request, response) => {
    const { status } = bookingListQuerySchema.parse(request.query);
    response.json({ success: true, data: await bookings.listForVendor(currentUser(request).id, status) });
  });

  // Accept or reject — only pending requests, only once, only the vendor's own.
  router.patch("/api/vendor/bookings/:id", async (request, response) => {
    const user = currentUser(request);
    const id = parseObjectId(request.params.id, "Booking");
    const { status } = vendorDecisionSchema.parse(request.body ?? {});

    const booking = await bookings.transitionFromPending(id, { vendorId: user.id }, status);
    if (!booking) {
      explainFailedTransition(await bookings.findRaw(id), (doc) => doc.vendorId.toHexString() === user.id);
    }
    response.json({
      success: true,
      message: status === "accepted" ? "Booking accepted." : "Booking rejected.",
      data: booking,
    });
  });

  return router;
}
