import { assertApplicationEventNamespace } from "./application-events";
import { base64UrlDecode, base64UrlEncode } from "./crypto";
import type { AppConfig } from "./types";

export const APPLICATION_EVENT_CURSOR_TTL_SECONDS = 15 * 60;

export interface ApplicationEventCursorCheckpoint {
  afterSequence: number;
}

interface CursorPayload {
  v: 1;
  sequence: number;
  expiresAt: number;
}

const CURSOR_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_BYTES = 256;
const MAX_TOKEN_LENGTH = 342;
const KEY_DOMAIN = "aittadb-application-event-cursor-aes-256-gcm-key-v1\0";
const AAD_DOMAIN = "aittadb-application-event-cursor-aad-v1";
const RESOURCE = "events";

export async function encodeApplicationEventCursor(
  principalId: string,
  clientId: string,
  afterSequence: number,
  now: number,
  config: AppConfig,
): Promise<string> {
  assertCursorInput(principalId, clientId, afterSequence, now);
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    sequence: afterSequence,
    expiresAt: now + APPLICATION_EVENT_CURSOR_TTL_SECONDS,
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    aesGcmParameters(iv, principalId, clientId, config),
    await cursorKey(config),
    ownedBuffer(plaintext),
  );
  const token = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  token.set(iv);
  token.set(new Uint8Array(ciphertext), IV_BYTES);
  return base64UrlEncode(token);
}

export async function decodeApplicationEventCursor(
  value: string,
  principalId: string,
  clientId: string,
  now: number,
  config: AppConfig,
): Promise<ApplicationEventCursorCheckpoint | null> {
  if (
    !isCursorContext(principalId, clientId, now) ||
    !isCanonicalToken(value)
  ) {
    return null;
  }

  try {
    const token = base64UrlDecode(value);
    if (
      token.byteLength < IV_BYTES + TAG_BYTES + 2 ||
      token.byteLength > MAX_TOKEN_BYTES
    ) {
      return null;
    }

    const iv = token.slice(0, IV_BYTES);
    const ciphertext = token.slice(IV_BYTES);
    const decrypted = await crypto.subtle.decrypt(
      aesGcmParameters(iv, principalId, clientId, config),
      await cursorKey(config),
      ownedBuffer(ciphertext),
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
    const parsed = JSON.parse(text) as unknown;
    if (!isCursorPayload(parsed, now)) return null;

    const canonical = JSON.stringify({
      v: CURSOR_VERSION,
      sequence: parsed.sequence,
      expiresAt: parsed.expiresAt,
    } satisfies CursorPayload);
    if (text !== canonical) return null;
    return { afterSequence: parsed.sequence };
  } catch {
    return null;
  }
}

async function cursorKey(config: AppConfig): Promise<CryptoKey> {
  const privateScalar = config.jwtPrivateJwk.d;
  if (!privateScalar) throw new Error("application_event_cursor_unavailable");
  const material = new TextEncoder().encode(`${KEY_DOMAIN}${privateScalar}`);
  const digest = await crypto.subtle.digest("SHA-256", ownedBuffer(material));
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function aesGcmParameters(
  iv: Uint8Array,
  principalId: string,
  clientId: string,
  config: AppConfig,
): AesGcmParams {
  const additionalData = new TextEncoder().encode(
    JSON.stringify([
      AAD_DOMAIN,
      RESOURCE,
      config.issuerUrl,
      config.jwtKeyId,
      principalId,
      clientId,
    ]),
  );
  return {
    name: "AES-GCM",
    iv: ownedBuffer(iv),
    additionalData: ownedBuffer(additionalData),
    tagLength: TAG_BYTES * 8,
  };
}

function assertCursorInput(
  principalId: string,
  clientId: string,
  afterSequence: number,
  now: number,
): void {
  assertApplicationEventNamespace(principalId, clientId);
  if (
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0 ||
    !isSafeNow(now)
  ) {
    throw new RangeError("application_event_cursor_input_invalid");
  }
}

function isCursorContext(
  principalId: string,
  clientId: string,
  now: number,
): boolean {
  if (!isSafeNow(now)) return false;
  try {
    assertApplicationEventNamespace(principalId, clientId);
    return true;
  } catch {
    return false;
  }
}

function isSafeNow(now: number): boolean {
  return (
    Number.isSafeInteger(now) &&
    now >= 0 &&
    now <= Number.MAX_SAFE_INTEGER - APPLICATION_EVENT_CURSOR_TTL_SECONDS
  );
}

function isCursorPayload(value: unknown, now: number): value is CursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    candidate.v === CURSOR_VERSION &&
    Number.isSafeInteger(candidate.sequence) &&
    Number(candidate.sequence) >= 0 &&
    Number.isSafeInteger(candidate.expiresAt) &&
    Number(candidate.expiresAt) > now &&
    Number(candidate.expiresAt) <= now + APPLICATION_EVENT_CURSOR_TTL_SECONDS
  );
}

function isCanonicalToken(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_TOKEN_LENGTH ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return false;
  }
  try {
    const decoded = base64UrlDecode(value);
    return (
      decoded.byteLength <= MAX_TOKEN_BYTES &&
      base64UrlEncode(decoded) === value
    );
  } catch {
    return false;
  }
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
