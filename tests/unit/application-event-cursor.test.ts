import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_EVENT_CURSOR_TTL_SECONDS,
  decodeApplicationEventCursor,
  encodeApplicationEventCursor,
} from "../../src/application-event-cursor";
import { loadConfig } from "../../src/config";
import { base64UrlDecode, base64UrlEncode } from "../../src/crypto";
import {
  decodeStorageCursor,
  encodeStorageCursor,
} from "../../src/storage-cursor";
import { MemoryAuthStore } from "../../src/store/memory";
import type { AppConfig, ApplicationEvent } from "../../src/types";

const KEY_DOMAIN = "aittadb-application-event-cursor-aes-256-gcm-key-v1\0";
const AAD_DOMAIN = "aittadb-application-event-cursor-aad-v1";
const IV_BYTES = 12;
const NOW = 1_800_000_000;

test("event cursors preserve empty and nonempty deterministic resume checkpoints", async () => {
  const config = await testConfig();
  const principalId = "event-user";
  const clientId = "event-client";
  const emptyCursor = await encodeApplicationEventCursor(
    principalId,
    clientId,
    0,
    NOW,
    config,
  );
  const repeatedEmptyCursor = await encodeApplicationEventCursor(
    principalId,
    clientId,
    0,
    NOW,
    config,
  );

  assert.notEqual(emptyCursor, repeatedEmptyCursor);
  const emptyCheckpoint = { afterSequence: 0 };
  assert.deepEqual(
    await decodeApplicationEventCursor(
      emptyCursor,
      principalId,
      clientId,
      NOW,
      config,
    ),
    emptyCheckpoint,
  );
  assert.deepEqual(
    await decodeApplicationEventCursor(
      repeatedEmptyCursor,
      principalId,
      clientId,
      NOW,
      config,
    ),
    emptyCheckpoint,
  );

  const store = new MemoryAuthStore();
  store.applicationEvents.set("first", applicationEvent(7));
  store.applicationEvents.set("second", applicationEvent(11));
  const firstPage = await store.listApplicationEvents(
    principalId,
    clientId,
    emptyCheckpoint.afterSequence,
    1,
  );
  assert.deepEqual(
    firstPage.items.map((event) => event.sequence),
    [7],
  );
  const nextCursor = await encodeApplicationEventCursor(
    principalId,
    clientId,
    firstPage.items[0]!.sequence,
    NOW,
    config,
  );
  const nextCheckpoint = await decodeApplicationEventCursor(
    nextCursor,
    principalId,
    clientId,
    NOW,
    config,
  );
  assert.equal(nextCheckpoint?.afterSequence, 7);
  const secondPage = await store.listApplicationEvents(
    principalId,
    clientId,
    nextCheckpoint!.afterSequence,
    1,
  );
  assert.deepEqual(
    secondPage.items.map((event) => event.sequence),
    [11],
  );
});

test("event cursors encrypt sequence, expiry, namespace, and signing material", async () => {
  const config = await testConfig("event-cursor-confidentiality-key");
  const principalId = "d9a4dc84-2e88-4fe7-bdb1-4da0319557ae";
  const clientId = "client-confidentiality-evidence-4f24c15d";
  const sequence = 987_654_321;
  const cursor = await encodeApplicationEventCursor(
    principalId,
    clientId,
    sequence,
    NOW,
    config,
  );

  assert.deepEqual(
    await decodeApplicationEventCursor(
      cursor,
      principalId,
      clientId,
      NOW,
      config,
    ),
    { afterSequence: sequence },
  );
  const envelope = base64UrlDecode(cursor);
  const privateScalar = config.jwtPrivateJwk.d;
  assert.ok(privateScalar);
  for (const [label, sensitiveValue] of [
    ["event sequence", String(sequence)],
    ["expiry", String(NOW + APPLICATION_EVENT_CURSOR_TTL_SECONDS)],
    ["principal", principalId],
    ["client", clientId],
    ["issuer", config.issuerUrl],
    ["private signing scalar", privateScalar],
    ["signing key ID", config.jwtKeyId],
    ["sequence field name", "sequence"],
    ["expiry field name", "expiresAt"],
  ] as const) {
    assertCursorOmits(cursor, envelope, sensitiveValue, label);
  }
});

test("event cursor authentication binds resource, principal, client, issuer, and signing key", async () => {
  const config = await testConfig("event-cursor-key");
  const principalId = "user-a";
  const clientId = "client-a";
  const cursor = await encodeApplicationEventCursor(
    principalId,
    clientId,
    42,
    NOW,
    config,
  );

  assert.equal(
    await decodeApplicationEventCursor(cursor, "user-b", clientId, NOW, config),
    null,
  );
  assert.equal(
    await decodeApplicationEventCursor(
      cursor,
      principalId,
      "client-b",
      NOW,
      config,
    ),
    null,
  );

  const otherIssuer = loadConfig(
    {
      NODE_ENV: "test",
      ISSUER_URL: "https://other.example.test",
      JWT_KEY_ID: config.jwtKeyId,
      JWT_PRIVATE_JWK: JSON.stringify(config.jwtPrivateJwk),
    },
    "https://other.example.test",
  );
  assert.equal(
    await decodeApplicationEventCursor(
      cursor,
      principalId,
      clientId,
      NOW,
      otherIssuer,
    ),
    null,
  );

  const otherKeyId = loadConfig(
    {
      NODE_ENV: "test",
      ISSUER_URL: config.issuerUrl,
      JWT_KEY_ID: "rotated-key-id",
      JWT_PRIVATE_JWK: JSON.stringify(config.jwtPrivateJwk),
    },
    config.issuerUrl,
  );
  assert.equal(
    await decodeApplicationEventCursor(
      cursor,
      principalId,
      clientId,
      NOW,
      otherKeyId,
    ),
    null,
  );

  const rotatedKey = await testConfig("event-cursor-key");
  assert.notEqual(config.jwtPrivateJwk.d, rotatedKey.jwtPrivateJwk.d);
  assert.equal(
    await decodeApplicationEventCursor(
      cursor,
      principalId,
      clientId,
      NOW,
      rotatedKey,
    ),
    null,
  );

  const wrongResource = await encryptPayload(
    JSON.stringify({
      v: 1,
      sequence: 42,
      expiresAt: NOW + APPLICATION_EVENT_CURSOR_TTL_SECONDS,
    }),
    principalId,
    clientId,
    config,
    "storage-records",
  );
  assert.equal(
    await decodeApplicationEventCursor(
      wrongResource,
      principalId,
      clientId,
      NOW,
      config,
    ),
    null,
  );

  const storageCursor = await encodeStorageCursor(
    "records",
    principalId,
    clientId,
    { updatedAt: 42, key: "event" },
    config,
  );
  assert.equal(
    await decodeApplicationEventCursor(
      storageCursor,
      principalId,
      clientId,
      NOW,
      config,
    ),
    null,
  );
  assert.equal(
    await decodeStorageCursor(cursor, "records", principalId, clientId, config),
    null,
  );
});

test("event cursors expire at their exact bound and reject excessive lifetimes", async () => {
  const config = await testConfig();
  const cursor = await encodeApplicationEventCursor(
    "user-a",
    "client-a",
    1,
    NOW,
    config,
  );

  assert.deepEqual(
    await decodeApplicationEventCursor(
      cursor,
      "user-a",
      "client-a",
      NOW + APPLICATION_EVENT_CURSOR_TTL_SECONDS - 1,
      config,
    ),
    { afterSequence: 1 },
  );
  assert.equal(
    await decodeApplicationEventCursor(
      cursor,
      "user-a",
      "client-a",
      NOW + APPLICATION_EVENT_CURSOR_TTL_SECONDS,
      config,
    ),
    null,
  );

  const excessive = await encryptPayload(
    JSON.stringify({
      v: 1,
      sequence: 1,
      expiresAt: NOW + APPLICATION_EVENT_CURSOR_TTL_SECONDS + 1,
    }),
    "user-a",
    "client-a",
    config,
  );
  assert.equal(
    await decodeApplicationEventCursor(
      excessive,
      "user-a",
      "client-a",
      NOW,
      config,
    ),
    null,
  );
});

test("event cursors reject tampering, truncation, and noncanonical tokens", async () => {
  const config = await testConfig();
  const cursor = await encodeApplicationEventCursor(
    "user-a",
    "client-a",
    9,
    NOW,
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
    "A".repeat(343),
  ]) {
    assert.equal(
      await decodeApplicationEventCursor(
        invalid,
        "user-a",
        "client-a",
        NOW,
        config,
      ),
      null,
    );
  }
});

test("event cursors reject unsupported and malformed encrypted payloads", async () => {
  const config = await testConfig();
  const validExpiry = NOW + APPLICATION_EVENT_CURSOR_TTL_SECONDS;
  const payloads: readonly string[] = [
    JSON.stringify({ v: 2, sequence: 1, expiresAt: validExpiry }),
    JSON.stringify({ v: 1, sequence: "1", expiresAt: validExpiry }),
    JSON.stringify({ v: 1, sequence: -1, expiresAt: validExpiry }),
    JSON.stringify({ v: 1, sequence: 1.5, expiresAt: validExpiry }),
    JSON.stringify({
      v: 1,
      sequence: Number.MAX_SAFE_INTEGER + 1,
      expiresAt: validExpiry,
    }),
    JSON.stringify({ v: 1, sequence: 1, expiresAt: "later" }),
    JSON.stringify({ v: 1, sequence: 1, expiresAt: NOW }),
    JSON.stringify({
      v: 1,
      sequence: 1,
      expiresAt: validExpiry,
      extra: true,
    }),
    JSON.stringify({ sequence: 1, expiresAt: validExpiry, v: 1 }),
    JSON.stringify([1, validExpiry]),
    "{not-json",
  ];

  for (const payload of payloads) {
    const cursor = await encryptPayload(payload, "user-a", "client-a", config);
    assert.equal(
      await decodeApplicationEventCursor(
        cursor,
        "user-a",
        "client-a",
        NOW,
        config,
      ),
      null,
    );
  }
});

test("event cursor issuance and opening reject invalid context without weakening sequence zero", async () => {
  const config = await testConfig();
  for (const [principalId, clientId, sequence, now] of [
    ["", "client", 0, NOW],
    ["user", "client\nother", 0, NOW],
    ["user", "client", -1, NOW],
    ["user", "client", 1.5, NOW],
    ["user", "client", Number.MAX_SAFE_INTEGER + 1, NOW],
    ["user", "client", 0, -1],
    ["user", "client", 0, 1.5],
    [
      "user",
      "client",
      0,
      Number.MAX_SAFE_INTEGER - APPLICATION_EVENT_CURSOR_TTL_SECONDS + 1,
    ],
  ] as const) {
    await assert.rejects(
      encodeApplicationEventCursor(
        principalId,
        clientId,
        sequence,
        now,
        config,
      ),
      /application_event_(principal|client|cursor_input)_invalid/,
    );
  }

  const valid = await encodeApplicationEventCursor(
    "user",
    "client",
    0,
    NOW,
    config,
  );
  assert.equal(
    await decodeApplicationEventCursor(valid, "", "client", NOW, config),
    null,
  );
  assert.equal(
    await decodeApplicationEventCursor(valid, "user", "client", -1, config),
    null,
  );
});

async function testConfig(keyId = "event-cursor-test-key"): Promise<AppConfig> {
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
  principalId: string,
  clientId: string,
  config: AppConfig,
  resource = "events",
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
      resource,
      config.issuerUrl,
      config.jwtKeyId,
      principalId,
      clientId,
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
  const token = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  token.set(iv);
  token.set(new Uint8Array(ciphertext), iv.byteLength);
  return base64UrlEncode(token);
}

function applicationEvent(sequence: number): ApplicationEvent {
  const dataJson = JSON.stringify({ sequence });
  return {
    sequence,
    id: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    userId: "event-user",
    clientId: "event-client",
    type: "example.created",
    dataJson,
    dataBytes: new TextEncoder().encode(dataJson).byteLength,
    idempotencyKeyHash: null,
    requestHash: sequence.toString().padStart(43, "0"),
    createdAt: 100 + sequence,
    expiresAt: 200 + sequence,
  };
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

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
