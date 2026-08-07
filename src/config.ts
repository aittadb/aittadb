import type { AppConfig, RuntimeEnv } from "./types";

const DEFAULT_ACCESS_TOKEN_TTL = 600;
const DEFAULT_AUTH_CODE_TTL = 300;
const DEFAULT_DEVICE_CODE_TTL = 900;
const DEFAULT_DEVICE_POLL_INTERVAL = 5;
const DEFAULT_REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30;

export function loadConfig(env: RuntimeEnv, requestUrl: string): AppConfig {
  const isProduction = env.NODE_ENV === "production";
  const isTest = env.NODE_ENV === "test";
  const issuerUrl = normalizeIssuer(
    env.ISSUER_URL ?? new URL(requestUrl).origin,
  );
  const jwtKeyId = env.JWT_KEY_ID ?? (isTest ? "test-key" : "");
  const rawJwk = env.JWT_PRIVATE_JWK;

  if (!jwtKeyId) throw new Error("JWT_KEY_ID is required");
  if (!rawJwk) throw new Error("JWT_PRIVATE_JWK is required");
  if (isProduction && !env.DB) throw new Error("DB binding is required");

  const jwtPrivateJwk = parseJwk(rawJwk);
  if (jwtPrivateJwk.kty !== "EC" || jwtPrivateJwk.crv !== "P-256") {
    throw new Error("JWT_PRIVATE_JWK must be an EC P-256 private JWK");
  }

  return {
    issuerUrl,
    jwtPrivateJwk,
    jwtKeyId,
    adminEmails: splitList(env.ADMIN_EMAILS),
    accessTokenTtlSeconds: readPositiveInt(
      env.ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_ACCESS_TOKEN_TTL,
    ),
    authCodeTtlSeconds: readPositiveInt(
      env.AUTH_CODE_TTL_SECONDS,
      DEFAULT_AUTH_CODE_TTL,
    ),
    deviceCodeTtlSeconds: readPositiveInt(
      env.DEVICE_CODE_TTL_SECONDS,
      DEFAULT_DEVICE_CODE_TTL,
    ),
    devicePollIntervalSeconds: readPositiveInt(
      env.DEVICE_POLL_INTERVAL_SECONDS,
      DEFAULT_DEVICE_POLL_INTERVAL,
    ),
    refreshTokenTtlSeconds: readPositiveInt(
      env.REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_REFRESH_TOKEN_TTL,
    ),
    allowedCorsOrigins: splitList(env.ALLOWED_CORS_ORIGINS),
    isTest,
    isProduction,
  };
}

function normalizeIssuer(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function parseJwk(value: string): JsonWebKey {
  try {
    return JSON.parse(value) as JsonWebKey;
  } catch {
    throw new Error("JWT_PRIVATE_JWK must be valid JSON");
  }
}

function splitList(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, received ${value}`);
  }
  return parsed;
}
