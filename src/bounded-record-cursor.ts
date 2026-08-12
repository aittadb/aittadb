import {
  BOUNDED_RECORD_MAX_CURSOR_LENGTH,
  BOUNDED_RECORD_MAX_PAGE_SIZE,
  decodeBoundedRecordKey,
} from "./bounded-record-protocol";
import { base64UrlDecode, base64UrlEncode } from "./crypto";
import type { AppConfig } from "./types";

export interface BoundedRecordCursorPosition {
  afterId: string;
}

const CURSOR_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_BYTES = 1536;
const KEY_DOMAIN = "aittadb-bounded-record-list-cursor-aes-256-gcm-key-v1\0";
const AAD_DOMAIN = "aittadb-bounded-record-list-cursor-aad-v1";
const RESOURCE = "bounded-record-list";
const NAMESPACE_MAX_LENGTH = 240;

interface CursorPayload {
  v: 1;
  last_record_id: string;
}

export async function encodeBoundedRecordCursor(
  userId: string,
  clientId: string,
  collection: string,
  pageSize: number,
  afterId: string,
  config: AppConfig,
): Promise<string> {
  assertCursorContext(userId, clientId, collection, pageSize);
  const lastRecordId = validRecordId(afterId);
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    last_record_id: lastRecordId,
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    aesGcmParameters(iv, userId, clientId, collection, pageSize),
    await cursorKey(config),
    ownedBuffer(plaintext),
  );
  const token = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  token.set(iv);
  token.set(new Uint8Array(ciphertext), IV_BYTES);
  const encoded = base64UrlEncode(token);
  if (encoded.length > BOUNDED_RECORD_MAX_CURSOR_LENGTH) {
    throw new RangeError("bounded_record_cursor_output_invalid");
  }
  return encoded;
}

export async function decodeBoundedRecordCursor(
  value: string,
  userId: string,
  clientId: string,
  collection: string,
  pageSize: number,
  config: AppConfig,
): Promise<BoundedRecordCursorPosition | null> {
  if (
    !isCursorContext(userId, clientId, collection, pageSize) ||
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
      aesGcmParameters(iv, userId, clientId, collection, pageSize),
      await cursorKey(config),
      ownedBuffer(ciphertext),
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
    const parsed = JSON.parse(text) as unknown;
    if (!isCursorPayload(parsed)) return null;

    const canonical = JSON.stringify({
      v: CURSOR_VERSION,
      last_record_id: parsed.last_record_id,
    } satisfies CursorPayload);
    if (text !== canonical) return null;
    return { afterId: parsed.last_record_id };
  } catch {
    return null;
  }
}

async function cursorKey(config: AppConfig): Promise<CryptoKey> {
  const privateScalar = config.jwtPrivateJwk.d;
  if (!privateScalar) throw new Error("bounded_record_cursor_unavailable");
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
  userId: string,
  clientId: string,
  collection: string,
  pageSize: number,
): AesGcmParams {
  const additionalData = new TextEncoder().encode(
    JSON.stringify([
      AAD_DOMAIN,
      RESOURCE,
      userId,
      clientId,
      collection,
      pageSize,
    ]),
  );
  return {
    name: "AES-GCM",
    iv: ownedBuffer(iv),
    additionalData: ownedBuffer(additionalData),
    tagLength: TAG_BYTES * 8,
  };
}

function assertCursorContext(
  userId: string,
  clientId: string,
  collection: string,
  pageSize: number,
): void {
  if (!isCursorContext(userId, clientId, collection, pageSize)) {
    throw new RangeError("bounded_record_cursor_input_invalid");
  }
}

function isCursorContext(
  userId: string,
  clientId: string,
  collection: string,
  pageSize: number,
): boolean {
  return (
    isNamespacePart(userId) &&
    isNamespacePart(clientId) &&
    isCollection(collection) &&
    Number.isSafeInteger(pageSize) &&
    pageSize >= 1 &&
    pageSize <= BOUNDED_RECORD_MAX_PAGE_SIZE
  );
}

function isNamespacePart(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > NAMESPACE_MAX_LENGTH) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  return true;
}

function isCollection(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    decodeBoundedRecordKey({ collection: value, id: "cursor-boundary" });
    return true;
  } catch {
    return false;
  }
}

function validRecordId(value: unknown): string {
  if (typeof value !== "string") {
    throw new RangeError("bounded_record_cursor_input_invalid");
  }
  try {
    return decodeBoundedRecordKey({
      collection: "cursor",
      id: value,
    }).id;
  } catch {
    throw new RangeError("bounded_record_cursor_input_invalid");
  }
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2 ||
    candidate.v !== CURSOR_VERSION ||
    typeof candidate.last_record_id !== "string"
  ) {
    return false;
  }
  try {
    validRecordId(candidate.last_record_id);
    return true;
  } catch {
    return false;
  }
}

function isCanonicalToken(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > BOUNDED_RECORD_MAX_CURSOR_LENGTH ||
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
