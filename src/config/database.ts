import { MongoClient, type Db } from "mongodb";
import { parseMongoEnv } from "./env.js";

/**
 * One MongoClient (one connection pool) per process. On Vercel, warm function
 * invocations reuse it; the driver connects lazily on the first operation.
 */
declare global {
  var wedoraMongo: { client: MongoClient; dbName: string } | undefined;
}

function getConnection() {
  if (!globalThis.wedoraMongo) {
    const { MONGODB_URI, MONGODB_DB_NAME } = parseMongoEnv(process.env);
    try {
      globalThis.wedoraMongo = {
        client: new MongoClient(MONGODB_URI, {
          appName: "Wedora API",
          maxPoolSize: 10,
          serverSelectionTimeoutMS: 8000,
        }),
        dbName: MONGODB_DB_NAME,
      };
    } catch {
      // Never echo the URI: it contains credentials.
      throw new Error(
        "Invalid MongoDB connection settings. Check MONGODB_URI in the private environment.",
      );
    }
  }
  return globalThis.wedoraMongo;
}

export function getDatabase(): Db {
  const { client, dbName } = getConnection();
  return client.db(dbName);
}

export async function closeDatabase() {
  const current = globalThis.wedoraMongo;
  globalThis.wedoraMongo = undefined;
  await current?.client.close();
}

/** Better Auth's collection names (mongo adapter defaults). */
export const AUTH_COLLECTIONS = {
  user: "user",
  session: "session",
} as const;
