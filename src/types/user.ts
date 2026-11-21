import type { ObjectId } from "mongodb";

export const USER_ROLES = ["customer", "vendor", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Roles a user may pick for themselves (sign-up / Google onboarding). */
export const SELF_SERVICE_ROLES = ["customer", "vendor"] as const;
export type SelfServiceRole = (typeof SELF_SERVICE_ROLES)[number];

export type SubscriptionPlan = "free" | "premium";

/** Shape of a document in Better Auth's `user` collection (plus our fields). */
export type UserDocument = {
  _id: ObjectId;
  name: string;
  email: string;
  emailVerified?: boolean;
  image?: string | null;
  role?: UserRole | null;
  isBlocked?: boolean;
  businessName?: string | null;
  phone?: string | null;
  subscriptionPlan?: SubscriptionPlan;
  subscriptionExpiresAt?: Date | null;
  subscriptionCancelAtPeriodEnd?: boolean;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

/** The authoritative, server-loaded user attached to each authenticated request. */
export type AppUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: UserRole | null;
  isBlocked: boolean;
  businessName: string | null;
  phone: string | null;
  subscriptionPlan: SubscriptionPlan;
  subscriptionExpiresAt: Date | null;
  subscriptionCancelAtPeriodEnd: boolean;
  /** Premium only while the plan is premium AND not yet expired. */
  isPremium: boolean;
  createdAt: Date | null;
};

export function toAppUser(doc: UserDocument, now = new Date()): AppUser {
  const plan: SubscriptionPlan =
    doc.subscriptionPlan === "premium" ? "premium" : "free";
  const expiresAt =
    doc.subscriptionExpiresAt instanceof Date ? doc.subscriptionExpiresAt : null;
  const role =
    doc.role && (USER_ROLES as readonly string[]).includes(doc.role)
      ? doc.role
      : null;

  return {
    id: doc._id.toHexString(),
    name: doc.name,
    email: doc.email,
    image: doc.image ?? null,
    role,
    isBlocked: doc.isBlocked === true,
    businessName: doc.businessName ?? null,
    phone: doc.phone ?? null,
    subscriptionPlan: plan,
    subscriptionExpiresAt: expiresAt,
    subscriptionCancelAtPeriodEnd: doc.subscriptionCancelAtPeriodEnd === true,
    isPremium: plan === "premium" && expiresAt !== null && expiresAt > now,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt : null,
  };
}

/** Public JSON shape for /api/me — never includes Stripe identifiers. */
export function serializeUser(user: AppUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    role: user.role,
    isBlocked: user.isBlocked,
    businessName: user.businessName,
    phone: user.phone,
    subscriptionPlan: user.subscriptionPlan,
    subscriptionExpiresAt: user.subscriptionExpiresAt?.toISOString() ?? null,
    subscriptionCancelAtPeriodEnd: user.subscriptionCancelAtPeriodEnd,
    isPremium: user.isPremium,
    createdAt: user.createdAt?.toISOString() ?? null,
  };
}
