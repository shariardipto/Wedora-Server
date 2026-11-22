import cors from "cors";
import express from "express";
import helmet from "helmet";
import { getDatabase } from "./config/database.js";
import type { JwtEnv, ServerEnv } from "./config/env.js";
import { createTokenVerifier, type TokenVerifier } from "./lib/jwt.js";
import { createAuthenticator } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { createHealthRouter } from "./routes/health.js";
import { createAdminServicesRouter } from "./routes/admin-services.js";
import { createAdminUsersRouter } from "./routes/admin-users.js";
import { createBookingsRouter } from "./routes/bookings.js";
import { createMeRouter } from "./routes/me.js";
import { createServicesRouter } from "./routes/services.js";
import { createStatsRouter } from "./routes/stats.js";
import { createVendorBookingsRouter } from "./routes/vendor-bookings.js";
import { createVendorServicesRouter } from "./routes/vendor-services.js";
import { createAdminUserStore, type AdminUserStore } from "./services/admin-users.js";
import { createBookingStore, type BookingStore } from "./services/bookings.js";
import { createServiceStore, type ServiceStore } from "./services/services.js";
import { createStatsStore, type StatsStore } from "./services/stats.js";
import { createUserService, type UserService } from "./services/users.js";

export type AppConfig = Pick<ServerEnv, "CLIENT_ORIGIN"> & JwtEnv;

/** Injectable collaborators — tests swap in fakes, production uses the defaults. */
export type AppDependencies = {
  verifyToken?: TokenVerifier;
  users?: UserService;
  services?: ServiceStore;
  bookings?: BookingStore;
  stats?: StatsStore;
  adminUsers?: AdminUserStore;
};

/**
 * Builds the Express application without starting a listener, so tests and the
 * Vercel entry (src/index.ts) share exactly the same middleware stack.
 *
 * This file is deliberately NOT named app/index/server: Vercel's zero-config
 * Express detection scans those names, and src/index.ts must be the only entry.
 */
export function createApp(config: AppConfig, dependencies: AppDependencies = {}) {
  const users = dependencies.users ?? createUserService(getDatabase);
  const services = dependencies.services ?? createServiceStore(getDatabase);
  const bookings = dependencies.bookings ?? createBookingStore(getDatabase);
  const stats = dependencies.stats ?? createStatsStore(getDatabase);
  const adminUsers = dependencies.adminUsers ?? createAdminUserStore(getDatabase);
  const verifyToken = dependencies.verifyToken ?? createTokenVerifier(config);
  const authenticate = createAuthenticator(verifyToken, users);

  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: config.CLIENT_ORIGIN,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type"],
      maxAge: 600,
    }),
  );

  // The Stripe webhook route (P6) must be mounted ABOVE this line with express.raw().
  app.use(express.json({ limit: "100kb" }));

  app.use(createHealthRouter());
  app.use(createMeRouter(authenticate, users));
  app.use(createServicesRouter(authenticate, services));
  app.use(createVendorServicesRouter(authenticate, services, bookings));
  app.use(createAdminServicesRouter(authenticate, services, bookings));
  app.use(createBookingsRouter(authenticate, bookings, services));
  app.use(createVendorBookingsRouter(authenticate, bookings));
  app.use(createStatsRouter(authenticate, stats));
  app.use(createAdminUsersRouter(authenticate, adminUsers));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
