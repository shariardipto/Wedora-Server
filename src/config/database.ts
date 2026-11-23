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
    let client: MongoClient;
    try {
      client = new MongoClient(MONGODB_URI, {
        appName: "Wedora API",
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 8000,
      });
    } catch {
      // Never echo the URI: it contains credentials.
      throw new Error(
        "Invalid MongoDB connection settings. Check MONGODB_URI in the private environment.",
      );
    }
    // Self-healing: if a connection attempt fails (a network blip, a cluster failover), the driver
    // closes the client's topology but keeps it, so every later query fails at once with
    // MongoTopologyClosedError and never reconnects, for as long as the warm instance lives (seen
    // on the client app on 23 Nov 2026). Drop the client then; the next getDatabase() connects afresh.
    client.once("topologyClosed", () => {
      if (globalThis.wedoraMongo?.client !== client) return;
      globalThis.wedoraMongo = undefined;
      void client.close().catch(() => undefined);
    });
    globalThis.wedoraMongo = { client, dbName: MONGODB_DB_NAME };
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
