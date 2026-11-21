import dotenv from "dotenv";
import type { Express } from "express";
import { parseServerEnv } from "./config/env.js";
import { createApp } from "./create-app.js";

dotenv.config({ quiet: true });

const env = parseServerEnv(process.env);
const app: Express = createApp(env);

// Vercel imports the default export and sets VERCEL=1; locally we start a listener.
if (!process.env.VERCEL) {
  const server = app.listen(env.PORT, () => {
    console.info(`Wedora API listening at http://localhost:${env.PORT}`);
  });

  server.on("error", (error) => {
    console.error(
      `Wedora API could not start on port ${env.PORT}: ${error.message}`,
    );
    process.exitCode = 1;
  });

  const shutdown = () => {
    server.close(() => {
      process.exitCode = 0;
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export default app;
