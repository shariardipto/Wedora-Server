import { ObjectId, type Db } from "mongodb";
import { AUTH_COLLECTIONS } from "../config/database.js";
import {
  toAppUser,
  type AppUser,
  type SelfServiceRole,
  type UserDocument,
} from "../types/user.js";

export type UserService = {
  findById(id: string): Promise<AppUser | null>;
  /**
   * Sets the role only while it is still unset (Google onboarding, BR-02).
   * Returns null when the role was already chosen — the update is atomic.
   */
  setInitialRole(id: string, role: SelfServiceRole): Promise<AppUser | null>;
};

export function createUserService(getDb: () => Db): UserService {
  const users = () => getDb().collection<UserDocument>(AUTH_COLLECTIONS.user);

  return {
    async findById(id) {
      if (!ObjectId.isValid(id)) return null;
      const doc = await users().findOne({ _id: new ObjectId(id) });
      return doc ? toAppUser(doc) : null;
    },

    async setInitialRole(id, role) {
      if (!ObjectId.isValid(id)) return null;
      const doc = await users().findOneAndUpdate(
        {
          _id: new ObjectId(id),
          $or: [{ role: null }, { role: { $exists: false } }],
        },
        {
          $set: {
            role,
            isBlocked: false,
            subscriptionPlan: "free",
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after" },
      );
      return doc ? toAppUser(doc) : null;
    },
  };
}
