import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeBoundedRecordCursor,
  encodeBoundedRecordCursor,
} from "../../src/bounded-record-cursor";
import { loadConfig } from "../../src/config";
import { base64UrlDecode, base64UrlEncode } from "../../src/crypto";
import { encodeStorageCursor } from "../../src/storage-cursor";
import type { AppConfig } from "../../src/types";

const KEY_DOMAIN = "aittadb-bounded-record-list-cursor-aes-256-gcm-key-v1\0";
const AAD_DOMAIN = "aittadb-bounded-record-list-cursor-aad-v1";
const RESOURCE = "bounded-record-list";
const IV_BYTES = 12;
const USER_ID = "d9a4dc84-2e88-4fe7-bdb1-4da0319557ae";
const CLIENT_ID = "3e5a4e11-5f9c-4d42-b6a7-7e0f8c8f3c21";
const COLLECTION = "settings";
const PAGE_SIZE = 25;

test("bounded record cursors round-trip and are URL-safe", async () => {
  const config = await testConfig();
  const cursor = await encodeBoundedRecordCursor(
    USER_ID,
    CLIENT_ID,
    COLLECTION,
    PAGE_SIZE,
    "record-010",
    config,
  );

  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.ok(cursor.length <= 2_048);
  assert.deepEqual(
    await decodeBoundedRecordCursor(
      cursor,
      USER_ID,
      CLIENT_ID,
      COLLECTION,
      PAGE_SIZE,
      config,
    ),
    { afterId: "record-010" },
  );
  assert.notEqual(
    cursor,
    await encodeBoundedRecordCursor(
      USER_ID,
      CLIENT_ID,
      COLLECTION,
      PAGE_SIZE,
      "record-010",
      config,
    ),
  );
});

test("cursor encryption binds the exact namespace, collection, and page size", async () => {
  const config = await testConfig();
  const cursor = await encodeBoundedRecordCursor(
    USER_ID,
    CLIENT_ID,
    COLLECTION,
    PAGE_SIZE,
    "private-record",
    config,
  );

  for (const context of [
    {
      userId: "other-user",
      clientId: CLIENT_ID,
      collection: COLLECTION,
      pageSize: PAGE_SIZE,
    },
    {
      userId: USER_ID,
      clientId: "other-client",
      collection: COLLECTION,
      pageSize: PAGE_SIZE,
    },
    {
      userId: USER_ID,
      clientId: CLIENT_ID,
      collection: "profiles",
      pageSize: PAGE_SIZE,
    },
    {
      userId: USER_ID,
      clientId: CLIENT_ID,
      collection: COLLECTION,
      pageSize: PAGE_SIZE + 1,
    },
  ]) {
    assert.equal(
      await decodeBoundedRecordCursor(
        cursor,
        context.userId,
        context.clientId,
        context.collection,
        context.pageSize,
        config,
      ),
      null,
    );
  }
});

test("cursor encryption uses a separate key domain and rejects key rotation", async () => {
  const config = await testConfig("bounded-cursor-key");
  const rotatedConfig = await testConfig("bounded-cursor-key");
  const cursor = await encodeBoundedRecordCursor(
    USER_ID,
    CLIENT_ID,
    COLLECTION,
    PAGE_SIZE,
    "rotation-check",
    config,
  );

  assert.notEqual(config.jwtPrivateJwk.d, rotatedConfig.jwtPrivateJwk.d);
  assert.equal(
    await decodeBoundedRecordCursor(
      cursor,
      USER_ID,
      CLIENT_ID,
      COLLECTION,
      PAGE_SIZE,
      rotatedConfig,
    ),
    null,
  );
  const legacyCursor = await encodeStorageCursor(
    "records",
    USER_ID,
    CLIENT_ID,
    { updatedAt: 42, key: "legacy-domain-check" },
    config,
  );
  assert.equal(
    await decodeBoundedRecordCursor(
      legacyCursor,
      USER_ID,
      CLIENT_ID,
      COLLECTION,
      PAGE_SIZE,
      config,
    ),
    null,
  );
});

test("tampered, truncated, noncanonical, and oversized cursors fail generically", async () => {
  const config = await testConfig();
  const cursor = await encodeBoundedRecordCursor(
    USER_ID,
    CLIENT_ID,
    COLLECTION,
    PAGE_SIZE,
    "tamper-check",
    config,
  );
  const tampered = base64UrlDecode(cursor);
  tampered[tampered.length - 1] ^= 1;

  for (const invalid of [
    "",
    base64UrlEncode(tampered),
    cursor.slice(0, -2),
    `${cursor}=`,
    `${cursor}.ignored`,
    "A",
    "A".repeat(2_049),
  ]) {
    assert.equal(
      await decodeBoundedRecordCursor(
        invalid,
        USER_ID,
        CLIENT_ID,
        COLLECTION,
        PAGE_SIZE,
        config,
      ),
      null,
    );
  }
});

test("malformed, noncanonical, and invalid-ID plaintext fails closed", async () => {
  const config = await testConfig();
  const payloads = [
    JSON.stringify({ v: 2, last_record_id: "record" }),
    JSON.stringify({ v: 1, last_record_id: "" }),
    JSON.stringify({ v: 1, last_record_id: "-record" }),
    JSON.stringify({ v: 1, last_record_id: "record-" }),
    JSON.stringify({ v: 1, last_record_id: "record/child" }),
    JSON.stringify({ v: 1, last_record_id: "record", extra: true }),
    JSON.stringify({ last_record_id: "record", v: 1 }),
    JSON.stringify([1, "record"]),
    "{not-json",
  ];

  for (const payload of payloads) {
    const cursor = await encryptPayload(payload, config);
    assert.equal(
      await decodeBoundedRecordCursor(
        cursor,
        USER_ID,
        CLIENT_ID,
        COLLECTION,
        PAGE_SIZE,
        config,
      ),
      null,
    );
  }
});

test("invalid input is rejected without exposing context or key material", async () => {
  const config = await testConfig("private-key-id");
  const privateScalar = config.jwtPrivateJwk.d;
  assert.ok(privateScalar);

  for (const [userId, clientId, collection, pageSize, afterId] of [
    ["", CLIENT_ID, COLLECTION, PAGE_SIZE, "sensitive-id"],
    [USER_ID, "client\nvalue", COLLECTION, PAGE_SIZE, "sensitive-id"],
    [USER_ID, CLIENT_ID, "BadCollection", PAGE_SIZE, "sensitive-id"],
    [USER_ID, CLIENT_ID, COLLECTION, 0, "sensitive-id"],
    [USER_ID, CLIENT_ID, COLLECTION, 101, "sensitive-id"],
    [USER_ID, CLIENT_ID, COLLECTION, PAGE_SIZE, ""],
    [USER_ID, CLIENT_ID, COLLECTION, PAGE_SIZE, "sensitive/id"],
  ] as const) {
    await assert.rejects(
      encodeBoundedRecordCursor(
        userId,
        clientId,
        collection,
        pageSize,
        afterId,
        config,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        for (const sensitive of [
          userId,
          clientId,
          collection,
          afterId,
          privateScalar,
          config.jwtKeyId,
        ]) {
          if (sensitive.length > 0) {
            assert.equal(error.message.includes(sensitive), false);
          }
        }
        return true;
      },
    );
  }
});

test("cursor ciphertext does not disclose identity, position, or signing material", async () => {
  const config = await testConfig("confidential-cursor-key");
  const afterId = "private-record-010";
  const cursor = await encodeBoundedRecordCursor(
    USER_ID,
    CLIENT_ID,
    COLLECTION,
    PAGE_SIZE,
    afterId,
    config,
  );
  const envelope = base64UrlDecode(cursor);
  const privateScalar = config.jwtPrivateJwk.d;
  assert.ok(privateScalar);

  for (const [label, sensitive] of [
    ["user UUID", USER_ID],
    ["client UUID", CLIENT_ID],
    ["collection", COLLECTION],
    ["last record ID", afterId],
    ["private signing scalar", privateScalar],
    ["signing key ID", config.jwtKeyId],
  ] as const) {
    assertCursorOmits(cursor, envelope, sensitive, label);
  }
});

async function testConfig(
  keyId = "bounded-record-cursor-test-key",
): Promise<AppConfig> {
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

async function encryptPayload(
  payload: string,
  config: AppConfig,
): Promise<string> {
  const scalar = config.jwtPrivateJwk.d;
  assert.ok(scalar);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    ownedBuffer(new TextEncoder().encode(`${KEY_DOMAIN}${scalar}`)),
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
    JSON.stringify([
      AAD_DOMAIN,
      RESOURCE,
      USER_ID,
      CLIENT_ID,
      COLLECTION,
      PAGE_SIZE,
    ]),
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: ownedBuffer(iv),
      additionalData: ownedBuffer(additionalData),
      tagLength: 128,
    },
    key,
    ownedBuffer(new TextEncoder().encode(payload)),
  );
  const token = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  token.set(iv);
  token.set(new Uint8Array(ciphertext), IV_BYTES);
  return base64UrlEncode(token);
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function assertCursorOmits(
  cursor: string,
  envelope: Uint8Array,
  sensitive: string,
  label: string,
): void {
  assert.equal(cursor.includes(sensitive), false, `cursor exposed ${label}`);
  assert.equal(
    cursor.includes(base64UrlEncode(new TextEncoder().encode(sensitive))),
    false,
    `cursor exposed encoded ${label}`,
  );
  assert.equal(
    includesBytes(envelope, sensitive),
    false,
    `cursor envelope exposed ${label}`,
  );
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
