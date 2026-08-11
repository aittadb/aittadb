import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type { ApplicationEvent } from "../../src/types";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";

test("D1 and memory retrieve one exact event as defensive values", async () => {
  const sqlite = await migratedDatabase();
  try {
    seedNamespace(sqlite);
    const event = applicationEvent();
    insertEvent(sqlite, event);
    const memory = new MemoryAuthStore();
    memory.applicationEvents.set(event.id, { ...event });
    const stores = [new D1AuthStore(sqliteD1(sqlite)), memory];

    for (const store of stores) {
      const found = await store.getApplicationEvent(
        "event-user",
        "event-client",
        EVENT_ID,
      );
      assert.deepEqual(found, event);
      assert.ok(found);
      found.type = "mutated.result";
      assert.equal(
        (
          await store.getApplicationEvent(
            "event-user",
            "event-client",
            EVENT_ID,
          )
        )?.type,
        "example.created",
      );
    }
  } finally {
    sqlite.close();
  }
});

test("missing and foreign event lookups are indistinguishable", async () => {
  const sqlite = await migratedDatabase();
  try {
    seedNamespace(sqlite);
    const event = applicationEvent();
    insertEvent(sqlite, event);
    const memory = new MemoryAuthStore();
    memory.applicationEvents.set(event.id, { ...event });
    const stores = [new D1AuthStore(sqliteD1(sqlite)), memory];

    for (const store of stores) {
      assert.equal(
        await store.getApplicationEvent(
          "event-user",
          "event-client",
          "00000000-0000-4000-8000-000000000099",
        ),
        null,
      );
      assert.equal(
        await store.getApplicationEvent("other-user", "event-client", EVENT_ID),
        null,
      );
      assert.equal(
        await store.getApplicationEvent("event-user", "other-client", EVENT_ID),
        null,
      );
    }
  } finally {
    sqlite.close();
  }
});

test("malformed lookup values fail before repository access", async () => {
  let prepares = 0;
  const d1 = new D1AuthStore({
    prepare(): D1PreparedStatement {
      prepares += 1;
      throw new Error("unexpected_prepare");
    },
  });
  const stores = [d1, new MemoryAuthStore()];
  const cases = [
    ["", "event-client", EVENT_ID],
    ["event-user", "client\nother", EVENT_ID],
    ["event-user", "event-client", "not-an-event-id"],
    ["event-user", "event-client", "00000000-0000-4000-8000-00000000000A"],
  ] as const;

  for (const store of stores) {
    for (const [userId, clientId, id] of cases) {
      await assert.rejects(
        store.getApplicationEvent(userId, clientId, id),
        /application_event_(principal|client|id)_invalid/,
      );
    }
  }
  assert.equal(prepares, 0);
});

test("point lookup fails closed on malformed persisted rows", async () => {
  const malformed = { ...applicationEvent(), sequence: 0 };
  const memory = new MemoryAuthStore();
  memory.applicationEvents.set(malformed.id, malformed);
  await assert.rejects(
    memory.getApplicationEvent("event-user", "event-client", EVENT_ID),
    /application_event_sequence_invalid/,
  );

  const d1 = new D1AuthStore({
    prepare(): D1PreparedStatement {
      const statement: D1PreparedStatement = {
        bind(): D1PreparedStatement {
          return statement;
        },
        async first<T>(): Promise<T | null> {
          return { sequence: "not-an-integer" } as T;
        },
        async all<T>(): Promise<D1Result<T>> {
          return { success: true, results: [] };
        },
        async run<T>(): Promise<D1Result<T>> {
          return { success: true };
        },
      };
      return statement;
    },
  });
  await assert.rejects(
    d1.getApplicationEvent("event-user", "event-client", EVENT_ID),
    /application_event_row_invalid/,
  );
});

function applicationEvent(): ApplicationEvent {
  const dataJson = JSON.stringify({ message: "owned" });
  return {
    sequence: 1,
    id: EVENT_ID,
    userId: "event-user",
    clientId: "event-client",
    type: "example.created",
    dataJson,
    dataBytes: new TextEncoder().encode(dataJson).byteLength,
    idempotencyKeyHash: null,
    requestHash: "r".repeat(43),
    createdAt: 100,
    expiresAt: 200,
  };
}

function insertEvent(sqlite: DatabaseSync, event: ApplicationEvent): void {
  sqlite
    .prepare(
      "INSERT INTO application_events (sequence, id, user_id, client_id, event_type, data_json, data_bytes, idempotency_key_hash, request_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      event.sequence,
      event.id,
      event.userId,
      event.clientId,
      event.type,
      event.dataJson,
      event.dataBytes,
      event.idempotencyKeyHash,
      event.requestHash,
      event.createdAt,
      event.expiresAt,
    );
}

function seedNamespace(sqlite: DatabaseSync): void {
  sqlite.exec(
    "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('event-user', 'event-user@example.test', 'Event User', 1, 1), ('other-user', 'other-user@example.test', 'Other User', 1, 1); INSERT INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at) VALUES ('event-client', 'public', 'Event Client', NULL, NULL, 1), ('other-client', 'public', 'Other Client', NULL, NULL, 1)",
  );
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

function sqliteD1(database: DatabaseSync): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      let values: SQLInputValue[] = [];
      const statement: D1PreparedStatement = {
        bind(...nextValues: unknown[]): D1PreparedStatement {
          values = nextValues as SQLInputValue[];
          return statement;
        },
        async first<T>(): Promise<T | null> {
          return (
            (database.prepare(query).get(...values) as T | undefined) ?? null
          );
        },
        async all<T>(): Promise<D1Result<T>> {
          return {
            success: true,
            results: database.prepare(query).all(...values) as T[],
          };
        },
        async run<T>(): Promise<D1Result<T>> {
          const result = database.prepare(query).run(...values);
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          };
        },
      };
      return statement;
    },
  };
}
