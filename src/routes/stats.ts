import { Router } from "express";
import { currentUser, requireRole, type Authenticator } from "../middleware/auth.js";
import type { StatsStore } from "../services/stats.js";
import { FREE_PLAN_ACTIVE_LIMIT } from "../types/service.js";

/** Dashboard overview statistics, one endpoint per role. */
export function createStatsRouter(authenticate: Authenticator, stats: StatsStore) {
  const router = Router();

  router.get("/api/vendor/stats", authenticate(), requireRole("vendor"), async (request, response) => {
    const user = currentUser(request);
    const counts = await stats.vendor(user.id);
    response.json({
      success: true,
      data: {
        ...counts,
        plan: {
          name: user.isPremium ? "premium" : "free",
          isPremium: user.isPremium,
          expiresAt: user.subscriptionExpiresAt?.toISOString() ?? null,
          cancelAtPeriodEnd: user.subscriptionCancelAtPeriodEnd,
          activeLimit: user.isPremium ? null : FREE_PLAN_ACTIVE_LIMIT,
        },
      },
    });
  });

  router.get("/api/customer/stats", authenticate(), requireRole("customer"), async (request, response) => {
    response.json({ success: true, data: await stats.customer(currentUser(request).id) });
  });

  router.get("/api/admin/stats", authenticate(), requireRole("admin"), async (_request, response) => {
    response.json({ success: true, data: await stats.admin() });
  });

  return router;
}
