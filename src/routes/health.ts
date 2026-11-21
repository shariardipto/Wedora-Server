import { Router } from "express";

/** Liveness checks used by local development, Vercel smoke tests and uptime monitors. */
export function createHealthRouter() {
  const router = Router();

  router.get("/", (_request, response) => {
    response.json({
      success: true,
      message: "Wedora API is running.",
      data: { service: "wedora-api", docs: "/api/health" },
    });
  });

  router.get("/api/health", (_request, response) => {
    response.set("Cache-Control", "no-store").json({
      success: true,
      data: { status: "ok", service: "wedora-api" },
    });
  });

  return router;
}
