import { Router } from "express";
import { forbidden, notFound } from "../lib/api-error.js";
import { parseObjectId } from "../lib/object-id.js";
import { currentUser, requireRole, type Authenticator } from "../middleware/auth.js";
import type { AdminUserStore } from "../services/admin-users.js";
import { adminUserListQuerySchema, blockUserSchema } from "../validators/admin-user.js";

/** Admin: Manage Users — search, filter, details, block / unblock. */
export function createAdminUsersRouter(authenticate: Authenticator, store: AdminUserStore) {
  const router = Router();
  router.use("/api/admin/users", authenticate(), requireRole("admin"));

  router.get("/api/admin/users", async (request, response) => {
    const query = adminUserListQuerySchema.parse(request.query);
    const { items, meta } = await store.list(query);
    response.json({ success: true, data: items, meta });
  });

  router.get("/api/admin/users/:id", async (request, response) => {
    const id = parseObjectId(request.params.id, "User");
    const user = await store.details(id);
    if (!user) throw notFound("User not found.", "USER_NOT_FOUND");
    response.json({ success: true, data: user });
  });

  router.patch("/api/admin/users/:id/block", async (request, response) => {
    const admin = currentUser(request);
    const id = parseObjectId(request.params.id, "User");
    const { isBlocked } = blockUserSchema.parse(request.body ?? {});

    if (id.toHexString() === admin.id) {
      throw forbidden("You can’t block your own account.", "CANNOT_BLOCK_SELF");
    }

    const updated = await store.setBlocked(id, isBlocked);
    if (!updated) {
      // Either missing, or an admin (admins can't be blocked through the API).
      const existing = await store.details(id);
      if (!existing) throw notFound("User not found.", "USER_NOT_FOUND");
      throw forbidden("Admin accounts can’t be blocked.", "CANNOT_BLOCK_ADMIN");
    }

    // Blocked users are signed out everywhere immediately; the API already
    // rejects them on every request because roles/blocks are read from the DB.
    const revokedSessions = isBlocked ? await store.revokeSessions(id) : 0;

    response.json({
      success: true,
      message: isBlocked
        ? `${updated.name} is blocked and has been signed out.`
        : `${updated.name} is unblocked and can sign in again.`,
      data: { ...updated, revokedSessions },
    });
  });

  return router;
}
