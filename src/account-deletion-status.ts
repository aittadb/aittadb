import { base64UrlDecode, base64UrlEncode } from "./crypto";
import { parseCookies } from "./http";
import type { AccountDeletionJobState, AppConfig } from "./types";

export const ACCOUNT_DELETION_STATUS_COOKIE_NAME =
  "aittadb_account_deletion_status";
export const ACCOUNT_DELETION_STATUS_TTL_SECONDS = 7 * 24 * 60 * 60;

const HANDLE_VERSION = "v1";
const PAYLOAD_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_HANDLE_LENGTH = 512;
const KEY_PURPOSE = "aittadb-account-deletion-status-key-v1";
const AAD_PURPOSE = "aittadb-account-deletion-status-v1";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AccountDeletionPublicStatus =
  | "pending"
  | "running"
  | "retry"
  | "completed";

interface AccountDeletionStatusPayload {
  v: 1;
  subject: string;
  issuedAt: number;
  expiresAt: number;
}

export interface OpenedAccountDeletionStatus {
  subject: string;
}

export function accountDeletionStatusCookie(value: string): string {
  return `${ACCOUNT_DELETION_STATUS_COOKIE_NAME}=${value}; Path=/account/deletion; HttpOnly; Secure; SameSite=Lax; Max-Age=${ACCOUNT_DELETION_STATUS_TTL_SECONDS}`;
}

export function readAccountDeletionStatusHandle(
  request: Request,
): string | null {
  return parseCookies(request).get(ACCOUNT_DELETION_STATUS_COOKIE_NAME) ?? null;
}

export function accountDeletionPublicStatus(
  state: AccountDeletionJobState,
): AccountDeletionPublicStatus {
  return state === "retryable" ? "retry" : state;
}

export async function sealAccountDeletionStatus(
  subject: string,
  email: string,
  config: AppConfig,
  now: number,
): Promise<string> {
  assertStatusBinding(subject, email, config.jwtKeyId, now);
  const payload: AccountDeletionStatusPayload = {
    v: PAYLOAD_VERSION,
    subject,
    issuedAt: now,
    expiresAt: now + ACCOUNT_DELETION_STATUS_TTL_SECONDS,
  };
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    encryptionParameters(iv, config, email),
    await statusKey(config),
    ownedBuffer(new TextEncoder().encode(JSON.stringify(payload))),
  );
  return `${HANDLE_VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(
    new Uint8Array(ciphertext),
  )}`;
}

export async function openAccountDeletionStatus(
  value: string,
  email: string,
  config: AppConfig,
  now: number,
): Promise<OpenedAccountDeletionStatus | null> {
  if (
    !isStatusContext(email, config.jwtKeyId, now) ||
    value.length === 0 ||
    value.length > MAX_HANDLE_LENGTH
  ) {
    return null;
  }
  const parts = value.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== HANDLE_VERSION ||
    !isCanonicalBase64Url(parts[1]!) ||
    !isCanonicalBase64Url(parts[2]!)
  ) {
    return null;
  }

  try {
    const iv = base64UrlDecode(parts[1]!);
    const ciphertext = base64UrlDecode(parts[2]!);
    if (iv.byteLength !== IV_BYTES || ciphertext.byteLength <= TAG_BYTES) {
      return null;
    }
    const plaintext = await crypto.subtle.decrypt(
      encryptionParameters(iv, config, email),
      await statusKey(config),
      ownedBuffer(ciphertext),
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const parsed = JSON.parse(text) as unknown;
    if (!isStatusPayload(parsed, now)) return null;
    if (
      text !==
      JSON.stringify({
        v: PAYLOAD_VERSION,
        subject: parsed.subject,
        issuedAt: parsed.issuedAt,
        expiresAt: parsed.expiresAt,
      } satisfies AccountDeletionStatusPayload)
    ) {
      return null;
    }
    return { subject: parsed.subject };
  } catch {
    return null;
  }
}

async function statusKey(config: AppConfig): Promise<CryptoKey> {
  const privateScalar = config.jwtPrivateJwk.d;
  if (!privateScalar) throw new Error("account_deletion_status_unavailable");
  const material = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(base64UrlDecode(privateScalar)),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ownedBuffer(new TextEncoder().encode(config.issuerUrl)),
      info: ownedBuffer(
        new TextEncoder().encode(
          JSON.stringify([KEY_PURPOSE, config.jwtKeyId]),
        ),
      ),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function encryptionParameters(
  iv: Uint8Array,
  config: AppConfig,
  email: string,
): AesGcmParams {
  return {
    name: "AES-GCM",
    iv: ownedBuffer(iv),
    additionalData: ownedBuffer(
      new TextEncoder().encode(
        JSON.stringify([AAD_PURPOSE, config.issuerUrl, config.jwtKeyId, email]),
      ),
    ),
    tagLength: TAG_BYTES * 8,
  };
}

function isStatusPayload(
  value: unknown,
  now: number,
): value is AccountDeletionStatusPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    Object.keys(payload).length === 4 &&
    payload.v === PAYLOAD_VERSION &&
    typeof payload.subject === "string" &&
    UUID_V4_PATTERN.test(payload.subject) &&
    Number.isSafeInteger(payload.issuedAt) &&
    Number(payload.issuedAt) >= 0 &&
    Number(payload.issuedAt) <= now &&
    Number.isSafeInteger(payload.expiresAt) &&
    Number(payload.expiresAt) > now &&
    Number(payload.expiresAt) ===
      Number(payload.issuedAt) + ACCOUNT_DELETION_STATUS_TTL_SECONDS
  );
}

function assertStatusBinding(
  subject: string,
  email: string,
  keyId: string,
  now: number,
): void {
  if (!UUID_V4_PATTERN.test(subject) || !isStatusContext(email, keyId, now)) {
    throw new Error("account_deletion_status_binding_invalid");
  }
}

function isStatusContext(email: string, keyId: string, now: number): boolean {
  return (
    email.length > 0 &&
    email.length <= 320 &&
    !email.includes("\0") &&
    keyId.length > 0 &&
    keyId.length <= 128 &&
    !keyId.includes("\0") &&
    Number.isSafeInteger(now) &&
    now >= 0
  );
}

function isCanonicalBase64Url(value: string): boolean {
  if (
    value.length === 0 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return false;
  }
  try {
    return base64UrlEncode(base64UrlDecode(value)) === value;
  } catch {
    return false;
  }
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
