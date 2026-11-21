import { Router } from "express";
import { z } from "zod";
import { conflict } from "../lib/api-error.js";
import { currentUser, type Authenticator } from "../middleware/auth.js";
import type { UserService } from "../services/users.js";
import { SELF_SERVICE_ROLES, serializeUser } from "../types/user.js";

const chooseRoleSchema = z.strictObject({
  role: z.enum(SELF_SERVICE_ROLES, {
    error: "Choose either Customer or Vendor.",
  }),
});

export function createMeRouter(authenticate: Authenticator, users: UserService) {
  const router = Router();

  // Current user's profile, read fresh from the database.
  router.get("/api/me", authenticate({ allowRoleless: true }), (request, response) => {
    response.json({ success: true, data: serializeUser(currentUser(request)) });
  });

  // One-time account-type choice for users who signed up with Google (BR-02).
  // Admin can never be chosen here; an already-set role can never be changed.
  router.post(
    "/api/me/role",
    authenticate({ allowRoleless: true }),
    async (request, response) => {
      const user = currentUser(request);
      const { role } = chooseRoleSchema.parse(request.body ?? {});

      if (user.role) {
        throw conflict(
          "Your account type has already been set and cannot be changed.",
          "ROLE_ALREADY_SET",
        );
      }

      const updated = await users.setInitialRole(user.id, role);
      if (!updated) {
        throw conflict(
          "Your account type has already been set and cannot be changed.",
          "ROLE_ALREADY_SET",
        );
      }

      response.json({
        success: true,
        message: "Account type saved.",
        data: serializeUser(updated),
      });
    },
  );

  return router;
}
