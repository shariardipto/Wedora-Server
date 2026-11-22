import { Router } from "express";
import { requireRole, type Authenticator } from "../middleware/auth.js";
import type { BillingStore } from "../services/billing-store.js";
import { adminTransactionQuerySchema } from "../validators/billing.js";

/** Admin: read-only transaction history. There are deliberately no write routes. */
export function createAdminTransactionsRouter(authenticate: Authenticator, store: BillingStore) {
  const router = Router();

  router.get("/api/admin/transactions", authenticate(), requireRole("admin"), async (request, response) => {
    const query = adminTransactionQuerySchema.parse(request.query);
    const { items, meta, summary } = await store.listForAdmin(query);
    response.json({ success: true, data: items, meta: { ...meta, summary } });
  });

  return router;
}
