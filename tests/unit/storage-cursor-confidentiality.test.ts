import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { base64UrlDecode, base64UrlEncode } from "../../src/crypto";
import {
  decodeStorageCursor,
  encodeStorageCursor,
} from "../../src/storage-cursor";
import type { AppConfig } from "../../src/types";

const KEY_DOMAIN = "aittadb-storage-cursor-aes-256-gcm-key-v1\0";
const AAD_DOMAIN = "aittadb-storage-cursor-aad-v1";
const IV_BYTES = 12;

test("encrypted storage cursor omits namespace, position, and signing secrets", async () => {
  const config = await testConfig("cursor-confidentiality-key");
  const kind = "records";
  const userId = "d9a4dc84-2e88-4fe7-bdb1-4da0319557ae";
  const clientId = "client-confidentiality-evidence-4f24c15d";
  const position = {
    updatedAt: 1_777_777_777,
    key: "private/path/customer-confidentiality-evidence.json",
  };
  const cursor = await encodeStorageCursor(
    kind,
    userId,
    clientId,
    position,
    config,
  );

  assert.deepEqual(
    await decodeStorageCursor(cursor, kind, userId, clientId, config),
    position,
  );
  const envelope = base64UrlDecode(cursor);
  const privateScalar = config.jwtPrivateJwk.d;
  const publicX = config.jwtPrivateJwk.x;
  const publicY = config.jwtPrivateJwk.y;
  assert.ok(privateScalar);
  assert.ok(publicX);
  assert.ok(publicY);
  for (const [label, sensitiveValue] of [
    ["logical key", position.key],
    ["timestamp", String(position.updatedAt)],
    ["local user UUID", userId],
    ["OAuth client ID", clientId],
    ["private signing scalar", privateScalar],
    ["public signing x-coordinate", publicX],
    ["public signing y-coordinate", publicY],
    ["signing key ID", config.jwtKeyId],
  ] as const) {
    assertCursorOmits(cursor, envelope, sensitiveValue, label);
  }
  assert.equal(includesBytes(envelope, "updatedAt"), false);
});

test("storage cursor authentication binds kind, user, and client", async () => {
  const config = await testConfig();
  const cursor = await encodeStorageCursor(
    "records",
    "user-a",
    "client-a",
    { updatedAt: 42, key: "alpha" },
    config,
  );

  assert.equal(
    await decodeStorageCursor(cursor, "files", "user-a", "client-a", config),
    null,
  );
  assert.equal(
    await decodeStorageCursor(cursor, "records", "user-b", "client-a", config),
    null,
  );
  assert.equal(
    await decodeStorageCursor(cursor, "records", "user-a", "client-b", config),
    null,
  );
});

test("private signing-key rotation immediately invalidates outstanding cursors", async () => {
  const originalConfig = await testConfig("cursor-key-before-rotation");
  const rotatedConfig = await testConfig("cursor-key-after-rotation");
  assert.notEqual(
    originalConfig.jwtPrivateJwk.d,
    rotatedConfig.jwtPrivateJwk.d,
  );
  const position = { updatedAt: 314_159_265, key: "rotation/evidence" };
  const originalCursor = await encodeStorageCursor(
    "records",
    "rotation-user",
    "rotation-client",
    position,
    originalConfig,
  );

  assert.deepEqual(
    await decodeStorageCursor(
      originalCursor,
      "records",
      "rotation-user",
      "rotation-client",
      originalConfig,
    ),
    position,
  );
  assert.equal(
    await decodeStorageCursor(
      originalCursor,
      "records",
      "rotation-user",
      "rotation-client",
      rotatedConfig,
    ),
    null,
  );

  const rotatedCursor = await encodeStorageCursor(
    "records",
    "rotation-user",
    "rotation-client",
    position,
    rotatedConfig,
  );
  assert.deepEqual(
    await decodeStorageCursor(
      rotatedCursor,
      "records",
      "rotation-user",
      "rotation-client",
      rotatedConfig,
    ),
    position,
  );
  assert.equal(
    await decodeStorageCursor(
      rotatedCursor,
      "records",
      "rotation-user",
      "rotation-client",
      originalConfig,
    ),
    null,
  );
});

test("storage cursor rejects tampering, truncation, and noncanonical base64url", async () => {
  const config = await testConfig();
  const cursor = await encodeStorageCursor(
    "files",
    "user-a",
    "client-a",
    { updatedAt: 99, key: "file.txt" },
    config,
  );
  const tamperedBytes = base64UrlDecode(cursor);
  tamperedBytes[tamperedBytes.length - 1] ^= 1;

  for (const invalid of [
    base64UrlEncode(tamperedBytes),
    cursor.slice(0, -2),
    `${cursor}=`,
    `${cursor}.ignored`,
    "A".repeat(2049),
  ]) {
    assert.equal(
      await decodeStorageCursor(invalid, "files", "user-a", "client-a", config),
      null,
    );
  }
});

test("storage cursor rejects unsupported and malformed encrypted payloads", async () => {
  const config = await testConfig();
  const payloads: readonly string[] = [
    JSON.stringify({ v: 2, updatedAt: 10, key: "alpha" }),
    JSON.stringify({ v: 1, updatedAt: "10", key: "alpha" }),
    JSON.stringify({ v: 1, updatedAt: -1, key: "alpha" }),
    JSON.stringify({ v: 1, updatedAt: 10, key: "" }),
    JSON.stringify({ v: 1, updatedAt: 10, key: "bad\nkey" }),
    JSON.stringify({ v: 1, updatedAt: 10, key: "alpha", extra: true }),
    JSON.stringify({ key: "alpha", updatedAt: 10, v: 1 }),
    "{not-json",
  ];

  for (const payload of payloads) {
    const cursor = await encryptPayload(
      payload,
      "records",
      "user-a",
      "client-a",
      config,
    );
    assert.equal(
      await decodeStorageCursor(
        cursor,
        "records",
        "user-a",
        "client-a",
        config,
      ),
      null,
    );
  }
});

async function testConfig(keyId = "cursor-test-key"): Promise<AppConfig> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const issuer = "https://aittadb.example.test";
  return loadConfig(
    {
      NODE_ENV: "test",
      ISSUER_URL: issuer,
      JWT_KEY_ID: keyId,
      JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
    },
    issuer,
  );
}

function assertCursorOmits(
  cursor: string,
  envelope: Uint8Array,
  sensitiveValue: string,
  label: string,
): void {
  assert.equal(
    cursor.includes(sensitiveValue),
    false,
    `cursor token exposed ${label}`,
  );
  assert.equal(
    cursor.includes(base64UrlEncode(new TextEncoder().encode(sensitiveValue))),
    false,
    `cursor token exposed encoded ${label}`,
  );
  assert.equal(
    includesBytes(envelope, sensitiveValue),
    false,
    `decoded cursor envelope exposed ${label}`,
  );
}

async function encryptPayload(
  payload: string,
  kind: "records" | "files",
  userId: string,
  clientId: string,
  config: AppConfig,
): Promise<string> {
  const scalar = config.jwtPrivateJwk.d;
  assert.ok(scalar);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${KEY_DOMAIN}${scalar}`),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const additionalData = new TextEncoder().encode(
    JSON.stringify([AAD_DOMAIN, kind, userId, clientId]),
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData,
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(payload),
  );
  const token = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  token.set(iv);
  token.set(new Uint8Array(ciphertext), iv.byteLength);
  return base64UrlEncode(token);
}

function includesBytes(haystack: Uint8Array, value: string): boolean {
  const needle = new TextEncoder().encode(value);
  outer: for (
    let start = 0;
    start <= haystack.length - needle.length;
    start += 1
  ) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}
