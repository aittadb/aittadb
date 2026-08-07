import type { AppConfig, RuntimeEnv } from "./types";

const DEFAULT_ACCESS_TOKEN_TTL = 600;
const DEFAULT_AUTH_CODE_TTL = 300;
const DEFAULT_DEVICE_CODE_TTL = 900;
const DEFAULT_DEVICE_POLL_INTERVAL = 5;
const DEFAULT_REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30;
const DEFAULT_STORAGE_GLOBAL_MAX_ITEMS = 10_000;
const DEFAULT_STORAGE_GLOBAL_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_STORAGE_USER_MAX_ITEMS = 1_000;
const DEFAULT_STORAGE_USER_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_STORAGE_NAMESPACE_MAX_ITEMS = 500;
const DEFAULT_STORAGE_NAMESPACE_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_STORAGE_PAGE_SIZE = 50;
const MAX_STORAGE_PAGE_SIZE = 100;
const DEFAULT_STORAGE_READ_RATE_LIMIT = 120;
const DEFAULT_STORAGE_WRITE_RATE_LIMIT = 30;

export function loadConfig(env: RuntimeEnv, requestUrl: string): AppConfig {
  const isProduction = env.NODE_ENV === "production";
  const isTest = env.NODE_ENV === "test";
  const issuerUrl = normalizeIssuer(
    env.ISSUER_URL ?? new URL(requestUrl).origin,
  );
  const jwtKeyId = env.JWT_KEY_ID ?? (isTest ? "test-key" : "");
  const rawJwk = env.JWT_PRIVATE_JWK;
  const adminAccessKeyHash = env.ADMIN_ACCESS_KEY_HASH?.trim() || null;

  if (!jwtKeyId) throw new Error("JWT_KEY_ID is required");
  if (!rawJwk) throw new Error("JWT_PRIVATE_JWK is required");
  if (isProduction && !env.DB) throw new Error("DB binding is required");
  if (adminAccessKeyHash && !/^[A-Za-z0-9_-]{43}$/.test(adminAccessKeyHash)) {
    throw new Error("ADMIN_ACCESS_KEY_HASH must be a SHA-256 base64url digest");
  }

  const jwtPrivateJwk = parseJwk(rawJwk);
  if (
    jwtPrivateJwk.kty !== "EC" ||
    jwtPrivateJwk.crv !== "P-256" ||
    !jwtPrivateJwk.d
  ) {
    throw new Error("JWT_PRIVATE_JWK must be an EC P-256 private JWK");
  }

  const storageMaxPageSize = readPositiveInt(
    env.STORAGE_MAX_PAGE_SIZE,
    MAX_STORAGE_PAGE_SIZE,
  );
  const storageDefaultPageSize = readPositiveInt(
    env.STORAGE_DEFAULT_PAGE_SIZE,
    DEFAULT_STORAGE_PAGE_SIZE,
  );
  if (storageDefaultPageSize > storageMaxPageSize) {
    throw new Error(
      "STORAGE_DEFAULT_PAGE_SIZE must not exceed STORAGE_MAX_PAGE_SIZE",
    );
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
    storageLimits: {
      writesEnabled: readBoolean(env.STORAGE_WRITES_ENABLED, true),
      globalMaxItems: readPositiveInt(
        env.STORAGE_GLOBAL_MAX_ITEMS,
        DEFAULT_STORAGE_GLOBAL_MAX_ITEMS,
      ),
      globalMaxBytes: readPositiveInt(
        env.STORAGE_GLOBAL_MAX_BYTES,
        DEFAULT_STORAGE_GLOBAL_MAX_BYTES,
      ),
      userMaxItems: readPositiveInt(
        env.STORAGE_USER_MAX_ITEMS,
        DEFAULT_STORAGE_USER_MAX_ITEMS,
      ),
      userMaxBytes: readPositiveInt(
        env.STORAGE_USER_MAX_BYTES,
        DEFAULT_STORAGE_USER_MAX_BYTES,
      ),
      namespaceMaxItems: readPositiveInt(
        env.STORAGE_NAMESPACE_MAX_ITEMS,
        DEFAULT_STORAGE_NAMESPACE_MAX_ITEMS,
      ),
      namespaceMaxBytes: readPositiveInt(
        env.STORAGE_NAMESPACE_MAX_BYTES,
        DEFAULT_STORAGE_NAMESPACE_MAX_BYTES,
      ),
    },
    storageDefaultPageSize,
    storageMaxPageSize,
    storageReadRateLimit: readPositiveInt(
      env.STORAGE_READ_RATE_LIMIT,
      DEFAULT_STORAGE_READ_RATE_LIMIT,
    ),
    storageWriteRateLimit: readPositiveInt(
      env.STORAGE_WRITE_RATE_LIMIT,
      DEFAULT_STORAGE_WRITE_RATE_LIMIT,
    ),
    adminSubjects: splitList(env.ADMIN_SUBJECTS),
    adminAccessKeyHash,
    isTest,
    isProduction,
  };
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Expected boolean, received ${value}`);
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
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`Expected positive integer, received ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Expected positive integer, received ${value}`);
  }
  return parsed;
}
