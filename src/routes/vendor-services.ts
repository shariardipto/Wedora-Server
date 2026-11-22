import { Router } from "express";
import type { ObjectId } from "mongodb";
import { forbidden, notFound } from "../lib/api-error.js";
import { parseObjectId } from "../lib/object-id.js";
import { currentUser, requireRole, type Authenticator } from "../middleware/auth.js";
import type { BookingStore } from "../services/bookings.js";
import { contentChanged, type ServiceStore } from "../services/services.js";
import { FREE_PLAN_ACTIVE_LIMIT, type ServiceDocument } from "../types/service.js";
import type { AppUser } from "../types/user.js";
import {
  availabilitySchema,
  serviceInputSchema,
  serviceUpdateSchema,
  vendorListQuerySchema,
} from "../validators/service.js";

const serviceNotFound = () =>
  notFound("Service not found, or it doesn’t belong to your account.", "SERVICE_NOT_FOUND");

/**
 * BR-06: free vendors may keep at most 3 active services
 * (pending or approved, and available). Premium is unlimited.
 */
export async function assertCanActivate(store: ServiceStore, user: AppUser, excludeId?: ObjectId) {
  if (user.isPremium) return;
  const active = await store.countActive(user.id, excludeId);
  if (active >= FREE_PLAN_ACTIVE_LIMIT) {
    throw forbidden(
      `The Free plan allows up to ${FREE_PLAN_ACTIVE_LIMIT} active services. Pause or delete one, or upgrade to Premium for unlimited services.`,
      "PLAN_LIMIT_REACHED",
    );
  }
}

const countsTowardLimit = (doc: Pick<ServiceDocument, "status" | "isAvailable">) =>
  doc.isAvailable && (doc.status === "pending" || doc.status === "approved");

export function createVendorServicesRouter(authenticate: Authenticator, store: ServiceStore, bookings: BookingStore) {
  const router = Router();
  router.use("/api/vendor/services", authenticate(), requireRole("vendor"));

  // My Services + plan usage.
  router.get("/api/vendor/services", async (request, response) => {
    const user = currentUser(request);
    const { status } = vendorListQuerySchema.parse(request.query);
    const [services, activeCount] = await Promise.all([
      store.listByVendor(user.id, status),
      store.countActive(user.id),
    ]);
    response.json({
      success: true,
      data: services,
      meta: {
        activeCount,
        activeLimit: user.isPremium ? null : FREE_PLAN_ACTIVE_LIMIT,
        isPremium: user.isPremium,
      },
    });
  });

  // Add Service — always starts as "pending" until an admin approves it.
  router.post("/api/vendor/services", async (request, response) => {
    const user = currentUser(request);
    const input = serviceInputSchema.parse(request.body ?? {});
    await assertCanActivate(store, user);
    const service = await store.create(user.id, input);
    response.status(201).json({
      success: true,
      message: "Service submitted for review.",
      data: service,
    });
  });

  router.patch("/api/vendor/services/:id", async (request, response) => {
    const user = currentUser(request);
    const id = parseObjectId(request.params.id, "Service");
    const update = serviceUpdateSchema.parse(request.body ?? {});
    const existing = await store.findOwnedRaw(id, user.id);
    if (!existing) throw serviceNotFound();

    const set: Partial<ServiceDocument> = { ...update };
    let message = "Service updated.";
    // BR-07: content edits to a reviewed service go back to the admin.
    if (existing.status !== "pending" && contentChanged(existing, update)) {
      set.status = "pending";
      set.rejectionReason = null;
      message = "Changes saved — your service is back in review.";
      // A rejected service re-entering review becomes active again.
      if (!countsTowardLimit(existing) && existing.isAvailable) {
        await assertCanActivate(store, user, id);
      }
    }

    const service = await store.update(id, user.id, set);
    if (!service) throw serviceNotFound();
    response.json({ success: true, message, data: service });
  });

  // Manage availability (pause / resume) without re-review.
  router.patch("/api/vendor/services/:id/availability", async (request, response) => {
    const user = currentUser(request);
    const id = parseObjectId(request.params.id, "Service");
    const { isAvailable } = availabilitySchema.parse(request.body ?? {});
    const existing = await store.findOwnedRaw(id, user.id);
    if (!existing) throw serviceNotFound();

    if (isAvailable && !existing.isAvailable && existing.status !== "rejected") {
      await assertCanActivate(store, user, id);
    }
    const service = await store.update(id, user.id, { isAvailable });
    if (!service) throw serviceNotFound();
    response.json({
      success: true,
      message: isAvailable ? "Service is available again." : "Service paused.",
      data: service,
    });
  });

  router.delete("/api/vendor/services/:id", async (request, response) => {
    const user = currentUser(request);
    const id = parseObjectId(request.params.id, "Service");
    const removed = await store.remove(id, user.id);
    if (!removed) throw serviceNotFound();
    // BR-08: pending requests can no longer be fulfilled; accepted ones keep their record.
    const cancelledRequests = await bookings.cancelPendingForService(id);
    response.json({
      success: true,
      message: cancelledRequests ? `Service deleted. ${cancelledRequests} pending request(s) were cancelled.` : "Service deleted.",
      data: { id: id.toHexString(), cancelledRequests },
    });
  });

  return router;
}
