import express, { Router } from "express";
import { ApiError, badRequest } from "../lib/api-error.js";
import type { StripeEvent } from "../lib/stripe.js";
import type { BillingService } from "../services/billing.js";

/**
 * POST /api/webhooks/stripe — the ONLY way Premium is activated (BR-14).
 *
 * Mounted before `express.json()`: the signature is computed over the exact
 * raw bytes, so the body must not be parsed first. A handler failure returns
 * 5xx, which makes Stripe retry; every handler is idempotent.
 */
export function createStripeWebhookRouter(billing: BillingService) {
  const router = Router();

  router.post(
    "/api/webhooks/stripe",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (request, response) => {
      const signature = request.get("stripe-signature");
      if (!signature || !Buffer.isBuffer(request.body)) {
        throw badRequest("Missing Stripe signature.", "INVALID_WEBHOOK");
      }

      let event: StripeEvent;
      try {
        event = billing.verifyWebhook(request.body, signature);
      } catch (error) {
        if (error instanceof ApiError) throw error; // e.g. payments not configured (503)
        throw badRequest("Invalid Stripe signature.", "INVALID_SIGNATURE");
      }

      const outcome = await billing.handleEvent(event);
      response.json({ received: true, outcome });
    },
  );

  return router;
}
