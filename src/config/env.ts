import { z } from "zod";

/**
 * An HTTP(S) origin with no path, query or trailing slash,
 * e.g. "https://wedora.vercel.app" — the exact value the browser sends in `Origin`.
 */
const origin = z.url().refine((value) => {
  const url = URL.parse(value);
  return (
    url !== null &&
    ["http:", "https:"].includes(url.protocol) &&
    value === url.origin
  );
}, "Use an HTTP(S) origin without a trailing slash or path");

const serverEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  CLIENT_ORIGIN: origin.default("http://localhost:3000"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Lists the failing variable names only, so secret values never reach logs. */
export function describeInvalidFields(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => issue.path.join(".")))].join(
    ", ",
  );
}

export function parseServerEnv(input: Record<string, unknown>): ServerEnv {
  const result = serverEnvSchema.safeParse(input);

  if (!result.success) {
    throw new Error(
      `Invalid server configuration. Check: ${describeInvalidFields(result.error)}.`,
    );
  }

  if (
    result.data.NODE_ENV === "production" &&
    input.CLIENT_ORIGIN === undefined
  ) {
    throw new Error(
      "Invalid server configuration. Check: CLIENT_ORIGIN (required in production).",
    );
  }

  return result.data;
}
