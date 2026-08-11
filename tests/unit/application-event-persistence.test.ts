import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  APPLICATION_EVENT_DEFAULT_RETENTION_SECONDS,
  APPLICATION_EVENT_MAX_DATA_BYTES,
  APPLICATION_EVENT_MAX_RETENTION_SECONDS,
  applicationEventExpiresAt,
  assertApplicationEvent,
  assertApplicationEventInput,
} from "../../src/application-events";
import type { ApplicationEventInput } from "../../src/types";

const USER_ID = "event-user";
const CLIENT_ID = "event-client";
const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_HASH = "i".repeat(43);
const REQUEST_HASH = "r".repeat(43);

test("application event contract accepts one bounded immutable value", () => {
  const input = eventInput();
  assert.doesNotThrow(() => assertApplicationEventInput(input));
  assert.doesNotThrow(() => assertApplicationEvent({ ...input, sequence: 1 }));
});

test("application event contract rejects malformed and unbounded values", () => {
  const oversized = JSON.stringify({ value: "x".repeat(65_536) });
  const cases: Array<[string, ApplicationEventInput]> = [
    ["id", { ...eventInput(), id: "00000000-0000-4000-8000-00000000000A" }],
    ["principal", { ...eventInput(), userId: "" }],
    ["principal", { ...eventInput(), userId: "user\nother" }],
    ["client", { ...eventInput(), clientId: "x".repeat(241) }],
    ["type", { ...eventInput(), type: "invalid type" }],
    ["type", { ...eventInput(), type: "x".repeat(129) }],
    ["data_size", { ...eventInput(), dataBytes: 1 }],
    [
      "data_size",
      { ...eventInput(), dataJson: oversized, dataBytes: utf8Bytes(oversized) },
    ],
    ["data", { ...eventInput(), dataJson: "[]", dataBytes: utf8Bytes("[]") }],
    ["data", { ...eventInput(), dataJson: "not-json", dataBytes: 8 }],
    ["idempotency_hash", { ...eventInput(), idempotencyKeyHash: "plaintext" }],
    ["request_hash", { ...eventInput(), requestHash: "+".repeat(43) }],
    ["time", { ...eventInput(), createdAt: -1 }],
    ["time", { ...eventInput(), expiresAt: 100 }],
    [
      "retention",
      {
        ...eventInput(),
        expiresAt: 100 + APPLICATION_EVENT_MAX_RETENTION_SECONDS + 1,
      },
    ],
  ];

  for (const [failure, input] of cases) {
    assert.throws(
      () => assertApplicationEventInput(input),
      new RegExp(`application_event_${failure}_invalid`),
    );
  }
  assert.throws(
    () => assertApplicationEvent({ ...eventInput(), sequence: 0 }),
    /application_event_sequence_invalid/,
  );
  assert.equal(APPLICATION_EVENT_MAX_DATA_BYTES, 65_536);
});

test("application event expiry applies one finite configured retention", () => {
  assert.equal(
    applicationEventExpiresAt(100, APPLICATION_EVENT_DEFAULT_RETENTION_SECONDS),
    100 + APPLICATION_EVENT_DEFAULT_RETENTION_SECONDS,
  );
  for (const [createdAt, retention] of [
    [-1, 1],
    [0, 0],
    [0, APPLICATION_EVENT_MAX_RETENTION_SECONDS + 1],
    [Number.MAX_SAFE_INTEGER, 1],
  ] as const) {
    assert.throws(
      () => applicationEventExpiresAt(createdAt, retention),
      /application_event_retention_invalid/,
    );
  }
});

test("application events migration has narrow immutable storage", async () => {
  const sqlite = await migratedDatabase();
  try {
    const columns = sqlite
      .prepare("PRAGMA table_info(application_events)")
      .all()
      .map((column) => String(column.name));
    assert.deepEqual(columns, [
      "sequence",
      "id",
      "user_id",
      "client_id",
      "event_type",
      "data_json",
      "data_bytes",
      "idempotency_key_hash",
      "request_hash",
      "created_at",
      "expires_at",
    ]);
    assert.equal(columns.includes("idempotency_key"), false);
    assert.equal(columns.includes("payload"), false);

    const indexes = new Set(
      sqlite
        .prepare("PRAGMA index_list(application_events)")
        .all()
        .map((index) => String(index.name)),
    );
    assert.equal(indexes.has("idx_application_events_owner_sequence"), true);
    assert.equal(indexes.has("idx_application_events_owner_id"), true);
    assert.equal(indexes.has("idx_application_events_expires_sequence"), true);

    const triggers = sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'application_events' ORDER BY name",
      )
      .all()
      .map((trigger) => String(trigger.name));
    assert.deepEqual(triggers, [
      "trg_application_events_active_subject_insert",
      "trg_application_events_immutable",
      "trg_application_events_retention_bound_insert",
    ]);
  } finally {
    sqlite.close();
  }
});

test("application events schema enforces ownership, uniqueness, and immutable rows", async () => {
  const sqlite = await migratedDatabase();
  try {
    seedNamespace(sqlite);
    insertEvent(sqlite, eventInput());
    insertEvent(sqlite, {
      ...eventInput(),
      id: "00000000-0000-4000-8000-000000000002",
      idempotencyKeyHash: null,
    });
    insertEvent(sqlite, {
      ...eventInput(),
      id: "00000000-0000-4000-8000-000000000003",
      idempotencyKeyHash: null,
    });

    const rows = sqlite
      .prepare(
        "SELECT sequence, id, idempotency_key_hash, request_hash FROM application_events ORDER BY sequence",
      )
      .all();
    assert.deepEqual(
      rows.map((row) => Number(row.sequence)),
      [1, 2, 3],
    );
    assert.equal(rows[0]?.idempotency_key_hash, IDEMPOTENCY_HASH);
    assert.equal(rows[0]?.request_hash, REQUEST_HASH);

    assert.throws(
      () =>
        insertEvent(sqlite, {
          ...eventInput(),
          id: "00000000-0000-4000-8000-000000000004",
        }),
      /constraint/i,
    );
    assert.throws(
      () =>
        sqlite
          .prepare("UPDATE application_events SET event_type = ? WHERE id = ?")
          .run("changed", EVENT_ID),
      /application_event_immutable/,
    );
    assert.throws(
      () =>
        insertEvent(sqlite, {
          ...eventInput(),
          id: "00000000-0000-4000-8000-000000000009",
          idempotencyKeyHash: null,
          expiresAt: 100 + APPLICATION_EVENT_MAX_RETENTION_SECONDS + 1,
        }),
      /application_event_retention_invalid/,
    );
    assert.throws(
      () =>
        insertEvent(sqlite, {
          ...eventInput(),
          id: "not-an-event-id",
          idempotencyKeyHash: null,
        }),
      /constraint/i,
    );
    assert.throws(
      () =>
        insertEvent(sqlite, {
          ...eventInput(),
          id: "00000000-0000-4000-8000-000000000005",
          userId: "missing-user",
          idempotencyKeyHash: null,
        }),
      /foreign key/i,
    );
  } finally {
    sqlite.close();
  }
});

test("application events schema rejects inactive subjects and invalid payload state", async () => {
  const sqlite = await migratedDatabase();
  try {
    seedNamespace(sqlite);
    sqlite
      .prepare(
        "INSERT INTO account_deletion_jobs (subject, state, attempt, available_at, created_at, updated_at, completed_at) VALUES (?, 'pending', 0, 10, 1, 1, NULL)",
      )
      .run(USER_ID);

    assert.throws(
      () => insertEvent(sqlite, eventInput()),
      /account_deletion_subject_inactive/,
    );
    assert.throws(
      () =>
        insertEvent(sqlite, {
          ...eventInput(),
          id: "00000000-0000-4000-8000-000000000006",
          userId: "active-user",
          dataJson: "[]",
          dataBytes: 2,
        }),
      /constraint/i,
    );
    assert.throws(
      () =>
        insertEvent(sqlite, {
          ...eventInput(),
          id: "00000000-0000-4000-8000-000000000007",
          userId: "active-user",
          dataBytes: 999,
        }),
      /constraint/i,
    );
  } finally {
    sqlite.close();
  }
});

function eventInput(): ApplicationEventInput {
  const dataJson = JSON.stringify({ message: "durable" });
  return {
    id: EVENT_ID,
    userId: USER_ID,
    clientId: CLIENT_ID,
    type: "example.created",
    dataJson,
    dataBytes: utf8Bytes(dataJson),
    idempotencyKeyHash: IDEMPOTENCY_HASH,
    requestHash: REQUEST_HASH,
    createdAt: 100,
    expiresAt: 200,
  };
}

function insertEvent(sqlite: DatabaseSync, input: ApplicationEventInput): void {
  sqlite
    .prepare(
      "INSERT INTO application_events (id, user_id, client_id, event_type, data_json, data_bytes, idempotency_key_hash, request_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.id,
      input.userId,
      input.clientId,
      input.type,
      input.dataJson,
      input.dataBytes,
      input.idempotencyKeyHash,
      input.requestHash,
      input.createdAt,
      input.expiresAt,
    );
}

function seedNamespace(sqlite: DatabaseSync): void {
  sqlite.exec(
    "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('event-user', 'event-user@example.test', 'Event User', 1, 1), ('active-user', 'active-user@example.test', 'Active User', 1, 1); INSERT INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at) VALUES ('event-client', 'public', 'Event Client', NULL, NULL, 1)",
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function migratedDatabase(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  const migrationUrl = new URL("../../db/migrations/", import.meta.url);
  const migrationNames = (await readdir(migrationUrl))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrationNames) {
    sqlite.exec(await readFile(new URL(name, migrationUrl), "utf8"));
  }
  sqlite.exec("PRAGMA foreign_keys = ON");
  return sqlite;
}
