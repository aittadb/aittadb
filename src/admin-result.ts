import { base64UrlDecode, base64UrlEncode, randomToken } from "./crypto";
import { parseCookies } from "./http";
import type { AppConfig } from "./types";
import {
  ADMIN_CLIENT_OPERATIONS,
  type AdminMutationOperation,
  type AdminMutationResult,
} from "./admin-clients";

export const ADMIN_SUBMISSION_TTL_SECONDS = 15 * 60;
export const ADMIN_RESULT_TTL_SECONDS = 5 * 60;
export const ADMIN_RESULT_COOKIE_NAME = "aittadb_admin_result";

interface AdminResultPayload extends AdminMutationResult {
  version: 1;
  submissionToken: string;
  expiresAt: number;
}

export interface OpenedAdminResult {
  submissionToken: string;
  result: AdminMutationResult;
}

export function createAdminSubmissionToken(): string {
  return randomToken(24);
}

export function isAdminSubmissionToken(value: string | null): value is string {
  return Boolean(value && /^[A-Za-z0-9_-]{32}$/.test(value));
}

export function readAdminResultCookie(request: Request): string | null {
  return parseCookies(request).get(ADMIN_RESULT_COOKIE_NAME) ?? null;
}

export function adminResultCookie(value: string): string {
  return `${ADMIN_RESULT_COOKIE_NAME}=${value}; Path=/admin/clients; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_RESULT_TTL_SECONDS}`;
}

export function clearAdminResultCookie(): string {
  return `${ADMIN_RESULT_COOKIE_NAME}=; Path=/admin/clients; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function sealAdminResult(
  submissionToken: string,
  result: AdminMutationResult,
  subject: string,
  config: AppConfig,
  now: number,
): Promise<string> {
  if (!isAdminSubmissionToken(submissionToken))
    throw new Error("invalid_admin_submission");
  const payload: AdminResultPayload = {
    version: 1,
    submissionToken,
    operation: result.operation,
    clientId: result.clientId,
    ...(result.secret ? { secret: result.secret } : {}),
    expiresAt: now + ADMIN_RESULT_TTL_SECONDS,
  };
  if (!isAdminResultPayload(payload, now))
    throw new Error("invalid_admin_result");

  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: adminResultAdditionalData(
        config.issuerUrl,
        subject,
      ) as BufferSource,
    },
    await adminResultKey(config),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function openAdminResult(
  value: string,
  subject: string,
  config: AppConfig,
  now: number,
): Promise<OpenedAdminResult | null> {
  if (value.length > 2_100) return null;
  const parts = value.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== "v1" ||
    !isCanonicalBase64Url(parts[1]!) ||
    !isCanonicalBase64Url(parts[2]!) ||
    parts[2]!.length > 2_048
  ) {
    return null;
  }
  try {
    const iv = base64UrlDecode(parts[1]!);
    if (iv.byteLength !== 12) return null;
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: adminResultAdditionalData(
          config.issuerUrl,
          subject,
        ) as BufferSource,
      },
      await adminResultKey(config),
      base64UrlDecode(parts[2]!) as BufferSource,
    );
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    if (!isAdminResultPayload(payload, now)) return null;
    return {
      submissionToken: payload.submissionToken,
      result: {
        operation: payload.operation,
        clientId: payload.clientId,
        ...(payload.secret ? { secret: payload.secret } : {}),
      },
    };
  } catch {
    return null;
  }
}

async function adminResultKey(config: AppConfig): Promise<CryptoKey> {
  const secret = config.jwtPrivateJwk.d;
  if (!secret) throw new Error("missing_private_key_material");
  const material = await crypto.subtle.importKey(
    "raw",
    base64UrlDecode(secret) as BufferSource,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(config.issuerUrl),
      info: new TextEncoder().encode("aittadb-admin-result-v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function adminResultAdditionalData(
  issuer: string,
  subject: string,
): Uint8Array {
  return new TextEncoder().encode(
    `aittadb-admin-result-v1\u0000${issuer}\u0000${subject}`,
  );
}

function isCanonicalBase64Url(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    return base64UrlEncode(base64UrlDecode(value)) === value;
  } catch {
    return false;
  }
}

function isAdminResultPayload(
  value: unknown,
  now: number,
): value is AdminResultPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Partial<AdminResultPayload>;
  if (
    payload.version !== 1 ||
    !isAdminSubmissionToken(payload.submissionToken ?? null) ||
    !isAdminMutationOperation(payload.operation) ||
    typeof payload.clientId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.clientId,
    ) ||
    !Number.isInteger(payload.expiresAt) ||
    payload.expiresAt! <= now ||
    payload.expiresAt! > now + ADMIN_RESULT_TTL_SECONDS
  ) {
    return false;
  }
  if (
    payload.secret !== undefined &&
    (typeof payload.secret !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(payload.secret))
  ) {
    return false;
  }
  return payload.operation === "create" || payload.operation === "rotate_secret"
    ? payload.operation !== "rotate_secret" || payload.secret !== undefined
    : payload.secret === undefined;
}

function isAdminMutationOperation(
  value: unknown,
): value is AdminMutationOperation {
  return value === "create" || ADMIN_CLIENT_OPERATIONS.includes(value as never);
}
