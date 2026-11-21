import cors from "cors";
import express from "express";
import helmet from "helmet";
import { getDatabase } from "./config/database.js";
import type { JwtEnv, ServerEnv } from "./config/env.js";
import { createTokenVerifier, type TokenVerifier } from "./lib/jwt.js";
import { createAuthenticator } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { createHealthRouter } from "./routes/health.js";
import { createMeRouter } from "./routes/me.js";
import { createUserService, type UserService } from "./services/users.js";

export type AppConfig = Pick<ServerEnv, "CLIENT_ORIGIN"> & JwtEnv;

/** Injectable collaborators — tests swap in fakes, production uses the defaults. */
export type AppDependencies = {
  verifyToken?: TokenVerifier;
  users?: UserService;
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
