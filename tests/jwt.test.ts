import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createTokenVerifier } from "../src/lib/jwt.js";

const ISSUER = "http://localhost:3000";
const config = {
  BETTER_AUTH_JWKS_URL: "http://localhost:3000/api/auth/jwks",
  BETTER_AUTH_ISSUER: ISSUER,
  BETTER_AUTH_AUDIENCE: ISSUER,
};
const USER_ID = "64b7f0c2a1b2c3d4e5f60718";

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let privateKey: PrivateKey;
let verify: ReturnType<typeof createTokenVerifier>;

async function sign(
  overrides: { sub?: string; iss?: string; aud?: string; exp?: string | number } = {},
  key: PrivateKey = privateKey,
) {
  return new SignJWT({ email: "a@b.co" })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" })
    .setSubject(overrides.sub ?? USER_ID)
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? "15m")
    .sign(key);
}

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "test", alg: "EdDSA" };
  verify = createTokenVerifier(config, createLocalJWKSet({ keys: [jwk] }));
});

describe("createTokenVerifier", () => {
  it("accepts a valid Better Auth token and returns only the user id", async () => {
    await expect(verify(await sign())).resolves.toEqual({ userId: USER_ID });
  });

  it.each([
    ["expired", { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["wrong issuer", { iss: "https://evil.example" }],
    ["wrong audience", { aud: "https://other.example" }],
    ["non-ObjectId subject", { sub: "admin" }],
  ])("rejects a token with %s as 401", async (_label, overrides) => {
    await expect(verify(await sign(overrides))).rejects.toMatchObject({
      status: 401,
      code: "INVALID_TOKEN",
    });
  });

  it("rejects a token signed by a different key", async () => {
    const other = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    await expect(verify(await sign({}, other.privateKey))).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects a tampered payload", async () => {
    const [header, , signature] = (await sign()).split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "ffffffffffffffffffffffff", iss: ISSUER, aud: ISSUER, exp: 9999999999, iat: 1 }),
    ).toString("base64url");
    await expect(verify(`${header}.${forged}.${signature}`)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects HS256 tokens (algorithm confusion)", async () => {
    const hs = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER_ID)
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode("x".repeat(32)));
    await expect(verify(hs)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects garbage", async () => {
    await expect(verify("a.b.c")).rejects.toMatchObject({ status: 401 });
  });
});
