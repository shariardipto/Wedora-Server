import { Router } from "express";
import { currentUser, requireRole, type Authenticator } from "../middleware/auth.js";
import type { BillingService } from "../services/billing.js";
import { billingStatusQuerySchema } from "../validators/billing.js";

/** Vendor subscription: Checkout, status (read-only), cancel / resume. */
export function createBillingRouter(authenticate: Authenticator, billing: BillingService) {
  const router = Router();
  router.use("/api/billing", authenticate(), requireRole("vendor"));

  // BR-13: the price and the vendor id are decided here, never by the client.
  router.post("/api/billing/checkout", async (request, response) => {
    const { url } = await billing.startCheckout(currentUser(request));
    response.status(201).json({ success: true, data: { url } });
  });

  // BR-15: the success page polls this. It reads state; it never activates anything.
  router.get("/api/billing/status", async (request, response) => {
    const { session_id: sessionId } = billingStatusQuerySchema.parse(request.query);
    response.json({ success: true, data: await billing.status(currentUser(request), sessionId) });
  });

  // BR-16: Premium stays until the paid-through date; the webhook syncs the rest.
  router.post("/api/billing/cancel", async (request, response) => {
    const data = await billing.cancel(currentUser(request));
    response.json({ success: true, message: "Your subscription will end at the close of this billing period.", data });
  });

  router.post("/api/billing/resume", async (request, response) => {
    const data = await billing.resume(currentUser(request));
    response.json({ success: true, message: "Your subscription will renew as usual.", data });
  });

  return router;
}
