import { Router } from "express";
import { ObjectId } from "mongodb";
import { conflict, forbidden, notFound } from "../lib/api-error.js";
import { parseObjectId } from "../lib/object-id.js";
import { currentUser, requireRole, type Authenticator } from "../middleware/auth.js";
import { DuplicateBookingError, type BookingStore } from "../services/bookings.js";
import type { ServiceStore } from "../services/services.js";
import type { BookingDocument } from "../types/booking.js";
import { bookingListQuerySchema, createBookingSchema, parseDateOnly } from "../validators/booking.js";

const duplicate = () =>
  conflict(
    "You already have an active booking request for this service on that date.",
    "DUPLICATE_BOOKING",
  );

/**
 * After a conditional update matched nothing: was it someone else's booking
 * (404, don't reveal it exists) or already processed (409)?
 */
export function explainFailedTransition(
  raw: BookingDocument | null,
  isOwner: (doc: BookingDocument) => boolean,
): never {
  if (!raw || !isOwner(raw)) {
    throw notFound("Booking request not found.", "BOOKING_NOT_FOUND");
  }
  throw conflict(
    `This booking request has already been ${raw.status} and can’t be changed.`,
    "BOOKING_ALREADY_PROCESSED",
  );
}

/** Customer-side booking routes (BR-09, BR-11). */
export function createBookingsRouter(authenticate: Authenticator, bookings: BookingStore, services: ServiceStore) {
  const router = Router();
  const customerOnly = [authenticate(), requireRole("customer")];

  // Booking Request: vendors and admins get 403 here — only customers book (BR-09).
  router.post("/api/bookings", ...customerOnly, async (request, response) => {
    const user = currentUser(request);
    const input = createBookingSchema.parse(request.body ?? {});
    const serviceId = new ObjectId(input.serviceId);

    const service = await services.findById(serviceId);
    if (!service || !service.isPublic) {
      throw notFound("This service isn’t available for booking right now.", "SERVICE_UNAVAILABLE");
    }
    if (service.vendorId === user.id) {
      throw forbidden("You can’t book your own service.", "OWN_SERVICE");
    }

    const eventDate = parseDateOnly(input.eventDate)!;
    if (await bookings.hasActiveDuplicate(user.id, serviceId, eventDate)) throw duplicate();

    try {
      const booking = await bookings.create({
        serviceId,
        vendorId: new ObjectId(service.vendorId), // from the service, never from the client
        customerId: new ObjectId(user.id),
        eventDate,
        eventLocation: input.eventLocation,
        message: input.message,
      });
      response.status(201).json({
        success: true,
        message: "Booking request sent! The vendor will review it soon.",
        data: booking,
      });
    } catch (error) {
      // Two simultaneous submissions: the partial unique index lets only one through.
      if (error instanceof DuplicateBookingError) throw duplicate();
      throw error;
    }
  });

  router.get("/api/customer/bookings", ...customerOnly, async (request, response) => {
    const { status } = bookingListQuerySchema.parse(request.query);
    response.json({ success: true, data: await bookings.listForCustomer(currentUser(request).id, status) });
  });

  router.get("/api/customer/bookings/:id", ...customerOnly, async (request, response) => {
    const id = parseObjectId(request.params.id, "Booking");
    const booking = await bookings.findForCustomer(id, currentUser(request).id);
    if (!booking) throw notFound("Booking request not found.", "BOOKING_NOT_FOUND");
    response.json({ success: true, data: booking });
  });

  // Only the owner, and only while pending (BR-11).
  router.patch("/api/customer/bookings/:id/cancel", ...customerOnly, async (request, response) => {
    const user = currentUser(request);
    const id = parseObjectId(request.params.id, "Booking");
    const booking = await bookings.transitionFromPending(id, { customerId: user.id }, "cancelled");
    if (!booking) {
      explainFailedTransition(await bookings.findRaw(id), (doc) => doc.customerId.toHexString() === user.id);
    }
    response.json({ success: true, message: "Booking request cancelled.", data: booking });
  });

  return router;
}
