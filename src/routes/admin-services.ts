import { Router } from "express";
import { notFound } from "../lib/api-error.js";
import { parseObjectId } from "../lib/object-id.js";
import { requireRole, type Authenticator } from "../middleware/auth.js";
import type { ServiceStore } from "../services/services.js";
import { adminListQuerySchema, adminStatusSchema } from "../validators/service.js";

const STATUS_MESSAGES = {
  approved: "Service approved — it’s now visible to customers.",
  rejected: "Service rejected. The vendor will see your reason.",
  pending: "Service moved back to review.",
} as const;

/** Admin review: list every service, approve / reject / re-review, delete. */
export function createAdminServicesRouter(authenticate: Authenticator, store: ServiceStore) {
  const router = Router();
  router.use("/api/admin/services", authenticate(), requireRole("admin"));

  router.get("/api/admin/services", async (request, response) => {
    const query = adminListQuerySchema.parse(request.query);
    const { items, meta } = await store.listAll(query);
    response.json({ success: true, data: items, meta });
  });

  router.patch("/api/admin/services/:id/status", async (request, response) => {
    const id = parseObjectId(request.params.id, "Service");
    const { status, rejectionReason } = adminStatusSchema.parse(request.body ?? {});
    const service = await store.setStatus(id, status, rejectionReason ?? null);
    if (!service) throw notFound("Service not found.", "SERVICE_NOT_FOUND");
    response.json({ success: true, message: STATUS_MESSAGES[status], data: service });
  });

  router.delete("/api/admin/services/:id", async (request, response) => {
    const id = parseObjectId(request.params.id, "Service");
    const removed = await store.remove(id);
    if (!removed) throw notFound("Service not found.", "SERVICE_NOT_FOUND");
    response.json({ success: true, message: "Service deleted.", data: { id: id.toHexString() } });
  });

  return router;
}
