import { describe, expect, it } from "vitest";
import { serializeUser, toAppUser } from "../src/types/user.js";
import { makeUser } from "./helpers.js";

const NOW = new Date("2026-11-22T00:00:00Z");

describe("toAppUser", () => {
  it("treats premium as active only before the expiry date", () => {
    const active = toAppUser(
      makeUser({ subscriptionPlan: "premium", subscriptionExpiresAt: new Date("2026-12-22T00:00:00Z") }),
      NOW,
    );
    const expired = toAppUser(
      makeUser({ subscriptionPlan: "premium", subscriptionExpiresAt: new Date("2026-11-01T00:00:00Z") }),
      NOW,
    );
    const noExpiry = toAppUser(makeUser({ subscriptionPlan: "premium", subscriptionExpiresAt: null }), NOW);

    expect(active.isPremium).toBe(true);
    expect(expired.isPremium).toBe(false);
    expect(noExpiry.isPremium).toBe(false);
  });

  it("normalizes unknown roles and missing flags safely", () => {
    const user = toAppUser(
      makeUser({ role: "superuser" as never, isBlocked: undefined, subscriptionPlan: undefined }),
      NOW,
    );
    expect(user.role).toBeNull();
    expect(user.isBlocked).toBe(false);
    expect(user.subscriptionPlan).toBe("free");
  });

  it("serializes without Stripe identifiers", () => {
    const json = serializeUser(toAppUser(makeUser({ stripeSubscriptionId: "sub_x" }), NOW));
    expect(Object.keys(json)).not.toContain("stripeCustomerId");
    expect(Object.keys(json)).not.toContain("stripeSubscriptionId");
  });
});
