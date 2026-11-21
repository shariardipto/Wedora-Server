import type { Request, RequestHandler } from "express";
import { ApiError, forbidden, unauthorized } from "../lib/api-error.js";
import type { TokenVerifier } from "../lib/jwt.js";
import type { UserService } from "../services/users.js";
import type { AppUser, UserRole } from "../types/user.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Set by `authenticate` — loaded from MongoDB, never from the token. */
    user?: AppUser;
  }
}

const BEARER = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/;

type AuthenticateOptions = {
  /** Allow users who have not picked a role yet (Google onboarding endpoints). */
  allowRoleless?: boolean;
};

export type Authenticator = (options?: AuthenticateOptions) => RequestHandler;

/**
 * 1. Verifies the Bearer JWT (401 if missing/invalid/expired).
 * 2. Loads the CURRENT user from MongoDB, so role, block status and plan are
 *    always authoritative — a stale token cannot carry an old role (BR-04).
 * 3. Rejects blocked accounts (403) and users without a role (403) unless allowed.
 */
export function createAuthenticator(
  verifyToken: TokenVerifier,
  users: UserService,
): Authenticator {
  return ({ allowRoleless = false } = {}) =>
    async (request, response, next) => {
      response.set("Cache-Control", "private, no-store");

      const header = request.get("authorization") ?? "";
      const match = header.length <= 8192 ? BEARER.exec(header) : null;
      if (!match?.[1]) {
        throw unauthorized("Please sign in to continue.", "AUTH_REQUIRED");
      }

      const { userId } = await verifyToken(match[1]);
      const user = await users.findById(userId);
      if (!user) {
        throw unauthorized(
          "Your account could not be found. Please sign in again.",
          "ACCOUNT_NOT_FOUND",
        );
      }
      if (user.isBlocked) {
        throw forbidden(
          "Your account has been blocked. Please contact support.",
          "ACCOUNT_BLOCKED",
        );
      }
      if (!user.role && !allowRoleless) {
        throw forbidden(
          "Please choose your account type to continue.",
          "ROLE_REQUIRED",
        );
      }

      request.user = user;
      next();
    };
}

/** Role gate — must run after `authenticate`. Wrong role → 403. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (request, _response, next) => {
    const role = request.user?.role;
    if (!role || !roles.includes(role)) {
      throw forbidden(
        "You do not have permission to access this resource.",
        "FORBIDDEN_ROLE",
      );
    }
    next();
  };
}

/** The authenticated user for handlers behind `authenticate`. */
export function currentUser(request: Request): AppUser {
  if (!request.user) {
    throw new ApiError(401, "AUTH_REQUIRED", "Please sign in to continue.");
  }
  return request.user;
}
