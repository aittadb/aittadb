import type { AppConfig, PrivacyConfig, RuntimeEnv } from "./types";
import {
  APPLICATION_EVENT_DEFAULT_RETENTION_SECONDS,
  APPLICATION_EVENT_MAX_PAGE_SIZE,
  APPLICATION_EVENT_MAX_RETENTION_SECONDS,
} from "./application-events";

const DEFAULT_ACCESS_TOKEN_TTL = 600;
const DEFAULT_AUTH_CODE_TTL = 300;
const DEFAULT_DEVICE_CODE_TTL = 900;
const DEFAULT_DEVICE_POLL_INTERVAL = 5;
const DEFAULT_REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30;
const DEFAULT_EVENTS_GLOBAL_MAX_ITEMS = 10_000;
const DEFAULT_EVENTS_GLOBAL_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_EVENTS_USER_MAX_ITEMS = 1_000;
const DEFAULT_EVENTS_USER_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_EVENTS_NAMESPACE_MAX_ITEMS = 500;
const DEFAULT_EVENTS_NAMESPACE_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_EVENTS_PAGE_SIZE = 50;
const DEFAULT_EVENTS_READ_RATE_LIMIT = 120;
const DEFAULT_EVENTS_PUBLISH_RATE_LIMIT = 30;
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

  if (!jwtKeyId) throw new Error("JWT_KEY_ID is required");
  if (!rawJwk) throw new Error("JWT_PRIVATE_JWK is required");
  if (isProduction && !env.DB) throw new Error("DB binding is required");

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
  const eventMaxPageSize = readBoundedPositiveInt(
    env.EVENTS_MAX_PAGE_SIZE,
    APPLICATION_EVENT_MAX_PAGE_SIZE,
    APPLICATION_EVENT_MAX_PAGE_SIZE,
    "EVENTS_MAX_PAGE_SIZE",
  );
  const eventDefaultPageSize = readPositiveInt(
    env.EVENTS_DEFAULT_PAGE_SIZE,
    DEFAULT_EVENTS_PAGE_SIZE,
  );
  if (eventDefaultPageSize > eventMaxPageSize) {
    throw new Error(
      "EVENTS_DEFAULT_PAGE_SIZE must not exceed EVENTS_MAX_PAGE_SIZE",
    );
  }

  return {
    issuerUrl,
    jwtPrivateJwk,
    jwtKeyId,
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
    features: {
      records: readBoolean(env.FEATURE_RECORDS_ENABLED, true),
      files: readBoolean(env.FEATURE_FILES_ENABLED, true),
      statistics: readBoolean(env.FEATURE_STATISTICS_ENABLED, true),
      oauthApps: readBoolean(env.FEATURE_OAUTH_APPS_ENABLED, false),
      events: readBoolean(env.FEATURE_EVENTS_ENABLED, false),
    },
    maintenanceCleanupTelemetryEnabled: readBoolean(
      env.MAINTENANCE_CLEANUP_TELEMETRY_ENABLED,
      false,
    ),
    eventRetentionSeconds: readBoundedPositiveInt(
      env.EVENT_RETENTION_SECONDS,
      APPLICATION_EVENT_DEFAULT_RETENTION_SECONDS,
      APPLICATION_EVENT_MAX_RETENTION_SECONDS,
      "EVENT_RETENTION_SECONDS",
    ),
    eventLimits: {
      globalMaxItems: readPositiveInt(
        env.EVENTS_GLOBAL_MAX_ITEMS,
        DEFAULT_EVENTS_GLOBAL_MAX_ITEMS,
      ),
      globalMaxBytes: readPositiveInt(
        env.EVENTS_GLOBAL_MAX_BYTES,
        DEFAULT_EVENTS_GLOBAL_MAX_BYTES,
      ),
      userMaxItems: readPositiveInt(
        env.EVENTS_USER_MAX_ITEMS,
        DEFAULT_EVENTS_USER_MAX_ITEMS,
      ),
      userMaxBytes: readPositiveInt(
        env.EVENTS_USER_MAX_BYTES,
        DEFAULT_EVENTS_USER_MAX_BYTES,
      ),
      namespaceMaxItems: readPositiveInt(
        env.EVENTS_NAMESPACE_MAX_ITEMS,
        DEFAULT_EVENTS_NAMESPACE_MAX_ITEMS,
      ),
      namespaceMaxBytes: readPositiveInt(
        env.EVENTS_NAMESPACE_MAX_BYTES,
        DEFAULT_EVENTS_NAMESPACE_MAX_BYTES,
      ),
    },
    eventDefaultPageSize,
    eventMaxPageSize,
    eventReadRateLimit: readPositiveInt(
      env.EVENTS_READ_RATE_LIMIT,
      DEFAULT_EVENTS_READ_RATE_LIMIT,
    ),
    eventPublishRateLimit: readPositiveInt(
      env.EVENTS_PUBLISH_RATE_LIMIT,
      DEFAULT_EVENTS_PUBLISH_RATE_LIMIT,
    ),
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
    adminSubjects: readAdminSubjects(env.ADMIN_SUBJECTS),
    privacy: readPrivacyConfig(env),
    isTest,
    isProduction,
  };
}

function readPrivacyConfig(env: RuntimeEnv): PrivacyConfig {
  const values = {
    controllerName: readPrivacyText(env.PRIVACY_CONTROLLER_NAME, 200),
    controllerIdentifier: readPrivacyText(
      env.PRIVACY_CONTROLLER_IDENTIFIER,
      100,
    ),
    contactName: readPrivacyText(env.PRIVACY_CONTACT_NAME, 200),
    contactEmail: readPrivacyText(env.PRIVACY_CONTACT_EMAIL, 254),
    contactPhone: readPrivacyText(env.PRIVACY_CONTACT_PHONE, 80),
    contactAddress: readPrivacyText(env.PRIVACY_CONTACT_ADDRESS, 500),
  };
  const parsed = Object.fromEntries(
    Object.entries(values).map(([key, result]) => [key, result.value]),
  ) as Omit<PrivacyConfig, "valid">;
  const valid =
    Object.values(values).every((result) => result.valid) &&
    (!parsed.contactEmail || isContactEmail(parsed.contactEmail));
  return { ...parsed, valid };
}

function readPrivacyText(
  value: string | undefined,
  maxLength: number,
): { value: string | null; valid: boolean } {
  if (value === undefined || value.trim() === "") {
    return { value: null, valid: true };
  }
  if (hasUnsupportedControl(value)) {
    return { value: null, valid: false };
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= maxLength
    ? { value: normalized, valid: true }
    : { value: null, valid: false };
}

function hasUnsupportedControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint < 32 &&
        codePoint !== 9 &&
        codePoint !== 10 &&
        codePoint !== 13) ||
      codePoint === 127
    ) {
      return true;
    }
  }
  return false;
}

function isContactEmail(value: string): boolean {
  return /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(
    value,
  );
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
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

function readAdminSubjects(value: string | undefined): readonly string[] {
  const subjects = [...new Set(splitList(value))];
  if (
    subjects.some(
      (subject) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          subject,
        ),
    )
  ) {
    throw new Error("ADMIN_SUBJECTS must contain canonical UUIDv4 values");
  }
  return subjects;
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

function readBoundedPositiveInt(
  value: string | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const parsed = readPositiveInt(value, fallback);
  if (parsed > maximum) {
    throw new Error(`${name} must not exceed ${maximum}`);
  }
  return parsed;
}
