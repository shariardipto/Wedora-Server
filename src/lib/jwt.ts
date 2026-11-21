import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type { JwtEnv } from "../config/env.js";
import { ApiError } from "./api-error.js";

/** The only thing a token proves is WHO the caller is (BR-04). */
export type TokenIdentity = { userId: string };
export type TokenVerifier = (token: string) => Promise<TokenIdentity>;

const OBJECT_ID = /^[a-f\d]{24}$/i;

const invalidToken = () =>
  new ApiError(
    401,
    "INVALID_TOKEN",
    "Your session token is invalid or has expired. Please sign in again.",
  );

/**
 * Verifies Better Auth JWTs (EdDSA) against the client's JWKS endpoint.
 * Signature, issuer, audience and expiry are all enforced; the key source is
 * fixed by configuration and never taken from the token header.
 */
export function createTokenVerifier(
  config: JwtEnv,
  resolveKey?: JWTVerifyGetKey,
): TokenVerifier {
  const jwks =
    resolveKey ??
    createRemoteJWKSet(new URL(config.BETTER_AUTH_JWKS_URL), {
      timeoutDuration: 5000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });

  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        algorithms: ["EdDSA"],
        issuer: config.BETTER_AUTH_ISSUER,
        audience: config.BETTER_AUTH_AUDIENCE,
        requiredClaims: ["sub", "exp", "iat"],
      });
      if (typeof payload.sub !== "string" || !OBJECT_ID.test(payload.sub)) {
        throw invalidToken();
      }
      return { userId: payload.sub.toLowerCase() };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Network/JWKS availability problems are not the caller's fault.
      if (
        error instanceof errors.JOSEError &&
        !["ERR_JWKS_TIMEOUT", "ERR_JOSE_GENERIC"].includes(error.code)
      ) {
        throw invalidToken();
      }
      throw new ApiError(
        503,
        "AUTH_UNAVAILABLE",
        "Sign-in verification is temporarily unavailable. Please try again.",
      );
    }
  };
}
