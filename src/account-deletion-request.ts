import { base64UrlDecode, base64UrlEncode } from "./crypto";
import type { AppConfig } from "./types";

export const ACCOUNT_DELETION_CONFIRMATION_PHRASE = "delete my account";
export const ACCOUNT_DELETION_CONFIRMATION_TTL_SECONDS = 10 * 60;
export const ACCOUNT_DELETION_REQUEST_MAX_BYTES = 1024;

const TOKEN_VERSION = "v1";
const PAYLOAD_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_LENGTH = 512;
const KEY_PURPOSE = "aittadb-account-deletion-confirmation-key-v1";
const AAD_PURPOSE = "aittadb-account-deletion-confirmation-v1";

interface AccountDeletionConfirmationPayload {
  v: 1;
  issuedAt: number;
  expiresAt: number;
}

export async function sealAccountDeletionConfirmation(
  subject: string,
  email: string,
  config: AppConfig,
  now: number,
): Promise<string> {
  assertConfirmationBinding(subject, email, now);
  const payload: AccountDeletionConfirmationPayload = {
    v: PAYLOAD_VERSION,
    issuedAt: now,
    expiresAt: now + ACCOUNT_DELETION_CONFIRMATION_TTL_SECONDS,
  };
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    encryptionParameters(iv, config.issuerUrl, subject, email),
    await confirmationKey(config),
    ownedBuffer(new TextEncoder().encode(JSON.stringify(payload))),
  );
  return `${TOKEN_VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(
    new Uint8Array(ciphertext),
  )}`;
}

export async function openAccountDeletionConfirmation(
  value: string,
  subject: string,
  email: string,
  config: AppConfig,
  now: number,
): Promise<boolean> {
  if (
    !isConfirmationBinding(subject, email, now) ||
    value.length === 0 ||
    value.length > MAX_TOKEN_LENGTH
  ) {
    return false;
  }
  const parts = value.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== TOKEN_VERSION ||
    !isCanonicalBase64Url(parts[1]!) ||
    !isCanonicalBase64Url(parts[2]!)
  ) {
    return false;
  }

  try {
    const iv = base64UrlDecode(parts[1]!);
    const ciphertext = base64UrlDecode(parts[2]!);
    if (iv.byteLength !== IV_BYTES || ciphertext.byteLength <= TAG_BYTES) {
      return false;
    }
    const plaintext = await crypto.subtle.decrypt(
      encryptionParameters(iv, config.issuerUrl, subject, email),
      await confirmationKey(config),
      ownedBuffer(ciphertext),
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const parsed = JSON.parse(text) as unknown;
    if (!isConfirmationPayload(parsed, now)) return false;
    return (
      text ===
      JSON.stringify({
        v: PAYLOAD_VERSION,
        issuedAt: parsed.issuedAt,
        expiresAt: parsed.expiresAt,
      } satisfies AccountDeletionConfirmationPayload)
    );
  } catch {
    return false;
  }
}

async function confirmationKey(config: AppConfig): Promise<CryptoKey> {
  const privateScalar = config.jwtPrivateJwk.d;
  if (!privateScalar)
    throw new Error("account_deletion_confirmation_unavailable");
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
      info: ownedBuffer(new TextEncoder().encode(KEY_PURPOSE)),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function encryptionParameters(
  iv: Uint8Array,
  issuer: string,
  subject: string,
  email: string,
): AesGcmParams {
  return {
    name: "AES-GCM",
    iv: ownedBuffer(iv),
    additionalData: ownedBuffer(
      new TextEncoder().encode(
        JSON.stringify([AAD_PURPOSE, issuer, subject, email]),
      ),
    ),
    tagLength: TAG_BYTES * 8,
  };
}

function isConfirmationPayload(
  value: unknown,
  now: number,
): value is AccountDeletionConfirmationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    Object.keys(payload).length === 3 &&
    payload.v === PAYLOAD_VERSION &&
    Number.isSafeInteger(payload.issuedAt) &&
    Number.isSafeInteger(payload.expiresAt) &&
    Number(payload.issuedAt) <= now &&
    Number(payload.expiresAt) > now &&
    Number(payload.expiresAt) ===
      Number(payload.issuedAt) + ACCOUNT_DELETION_CONFIRMATION_TTL_SECONDS
  );
}

function assertConfirmationBinding(
  subject: string,
  email: string,
  now: number,
): void {
  if (!isConfirmationBinding(subject, email, now)) {
    throw new Error("account_deletion_confirmation_binding_invalid");
  }
}

function isConfirmationBinding(
  subject: string,
  email: string,
  now: number,
): boolean {
  return (
    subject.length > 0 &&
    subject.length <= 128 &&
    !subject.includes("\0") &&
    email.length > 0 &&
    email.length <= 320 &&
    !email.includes("\0") &&
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
