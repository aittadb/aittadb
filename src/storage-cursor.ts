import { base64UrlDecode, base64UrlEncode } from "./crypto";
import type { AppConfig, StorageListPosition } from "./types";

type StorageKind = "records" | "files";

interface CursorPayload {
  v: 1;
  updatedAt: number;
  key: string;
}

const CURSOR_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_BYTES = 1536;
const MAX_TOKEN_LENGTH = 2048;
const KEY_DOMAIN = "aittadb-storage-cursor-aes-256-gcm-key-v1\0";
const AAD_DOMAIN = "aittadb-storage-cursor-aad-v1";

export async function encodeStorageCursor(
  kind: StorageKind,
  userId: string,
  clientId: string,
  position: StorageListPosition,
  config: AppConfig,
): Promise<string> {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    updatedAt: position.updatedAt,
    key: position.key,
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    aesGcmParameters(iv, kind, userId, clientId),
    await cursorKey(config),
    ownedBuffer(plaintext),
  );
  const token = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  token.set(iv);
  token.set(new Uint8Array(ciphertext), IV_BYTES);
  return base64UrlEncode(token);
}

export async function decodeStorageCursor(
  value: string,
  kind: StorageKind,
  userId: string,
  clientId: string,
  config: AppConfig,
): Promise<StorageListPosition | null> {
  if (!isCanonicalToken(value)) return null;

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
      aesGcmParameters(iv, kind, userId, clientId),
      await cursorKey(config),
      ownedBuffer(ciphertext),
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
    const parsed = JSON.parse(text) as unknown;
    if (!isCursorPayload(parsed)) return null;

    const canonical = JSON.stringify({
      v: CURSOR_VERSION,
      updatedAt: parsed.updatedAt,
      key: parsed.key,
    } satisfies CursorPayload);
    if (text !== canonical) return null;
    return { updatedAt: parsed.updatedAt, key: parsed.key };
  } catch {
    return null;
  }
}

async function cursorKey(config: AppConfig): Promise<CryptoKey> {
  const privateScalar = config.jwtPrivateJwk.d;
  if (!privateScalar) throw new Error("cursor_key_unavailable");
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
  kind: StorageKind,
  userId: string,
  clientId: string,
): AesGcmParams {
  const additionalData = new TextEncoder().encode(
    JSON.stringify([AAD_DOMAIN, kind, userId, clientId]),
  );
  return {
    name: "AES-GCM",
    iv: ownedBuffer(iv),
    additionalData: ownedBuffer(additionalData),
    tagLength: TAG_BYTES * 8,
  };
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    candidate.v !== CURSOR_VERSION ||
    !Number.isSafeInteger(candidate.updatedAt) ||
    Number(candidate.updatedAt) < 0 ||
    typeof candidate.key !== "string" ||
    candidate.key.length === 0 ||
    candidate.key.length > 240
  ) {
    return false;
  }
  for (const char of candidate.key) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return !candidate.key
    .split("/")
    .some((part) => part === "." || part === "..");
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
