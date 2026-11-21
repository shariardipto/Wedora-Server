import { ObjectId } from "mongodb";
import { ApiError } from "../src/lib/api-error.js";
import type { TokenVerifier } from "../src/lib/jwt.js";
import type { UserService } from "../src/services/users.js";
import { toAppUser, type UserDocument } from "../src/types/user.js";

export const TEST_CONFIG = {
  CLIENT_ORIGIN: "http://localhost:3000",
  BETTER_AUTH_JWKS_URL: "http://localhost:3000/api/auth/jwks",
  BETTER_AUTH_ISSUER: "http://localhost:3000",
  BETTER_AUTH_AUDIENCE: "http://localhost:3000",
};

/** Tokens are just "token-<userId>"; anything else is rejected as invalid. */
export const fakeVerifier: TokenVerifier = async (token) => {
  const match = /^token-([a-f\d]{24})$/.exec(token);
  if (!match?.[1]) {
    throw new ApiError(401, "INVALID_TOKEN", "invalid");
  }
  return { userId: match[1] };
};

/** Bearer value accepted by `fakeVerifier` (shaped like a JWT for the header regex). */
export function bearerFor(userId: string) {
  return `Bearer token-${userId}.x.y`;
}

export const jwtShapedVerifier: TokenVerifier = async (token) =>
  fakeVerifier(token.split(".")[0] ?? "");

export function makeUser(overrides: Partial<UserDocument> = {}): UserDocument {
  return {
    _id: new ObjectId(),
    name: "Test User",
    email: `user-${Math.random().toString(36).slice(2)}@example.com`,
    image: null,
    role: "customer",
    isBlocked: false,
    subscriptionPlan: "free",
    subscriptionExpiresAt: null,
    stripeCustomerId: "cus_secret",
    createdAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

export function createFakeUserService(seed: UserDocument[] = []) {
  const store = new Map(seed.map((doc) => [doc._id.toHexString(), doc]));
  const service: UserService = {
    async findById(id) {
      const doc = store.get(id);
      return doc ? toAppUser(doc) : null;
    },
    async setInitialRole(id, role) {
      const doc = store.get(id);
      if (!doc || doc.role) return null;
      doc.role = role;
      return toAppUser(doc);
    },
  };
  return { service, store };
}

/** A complete, valid service payload. */
export const validInput = {
  serviceName: "Golden Hour Wedding Photography",
  category: "photography-videography",
  description: "Full-day wedding coverage with two photographers, an online gallery and a printed album.",
  price: 4500,
  location: "Brooklyn, NY",
  images: ["https://i.ibb.co/abc123/cover.jpg"],
};
