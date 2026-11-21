import { Router } from "express";
import { notFound } from "../lib/api-error.js";
import { parseObjectId } from "../lib/object-id.js";
import { currentUser, type Authenticator } from "../middleware/auth.js";
import type { ServiceStore } from "../services/services.js";
import { featuredQuerySchema, publicListQuerySchema } from "../validators/service.js";

/** Public browsing + authenticated service details. */
export function createServicesRouter(authenticate: Authenticator, store: ServiceStore) {
  const router = Router();

  // Browse: approved + available only, with search, filters, price sort and pagination.
  router.get("/api/services", async (request, response) => {
    const query = publicListQuerySchema.parse(request.query);
    const { items, meta } = await store.listPublic(query);
    response.set("Cache-Control", "no-store").json({ success: true, data: items, meta });
  });

  router.get("/api/services/featured", async (request, response) => {
    const { limit } = featuredQuerySchema.parse(request.query);
    response.set("Cache-Control", "no-store").json({ success: true, data: await store.featured(limit) });
  });

  router.get("/api/services/categories", async (_request, response) => {
    response.set("Cache-Control", "no-store").json({ success: true, data: await store.categoryCounts() });
  });

  // Details require sign-in. Customers only see public services; the owning
  // vendor and admins may also open pending/rejected/paused ones.
  router.get("/api/services/:id", authenticate(), async (request, response) => {
    const id = parseObjectId(request.params.id, "Service");
    const user = currentUser(request);
    const service = await store.findById(id);

    const isOwner = service?.vendorId === user.id;
    const isAdmin = user.role === "admin";
    if (!service || !(service.isPublic || isOwner || isAdmin)) {
      throw notFound("This service doesn’t exist or is no longer available.", "SERVICE_NOT_FOUND");
    }
    response.json({ success: true, data: service });
  });

  return router;
}
