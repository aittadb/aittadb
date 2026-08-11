import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type { ApplicationEvent } from "../../src/types";

test("D1 and memory event pages are bounded, ordered, and resumable", async () => {
  const sqlite = await migratedDatabase();
  try {
    seedNamespaces(sqlite);
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const d1 = new D1AuthStore(sqliteD1(sqlite, calls));
    const memory = new MemoryAuthStore();
    const events = [
      applicationEvent(3),
      applicationEvent(1),
      applicationEvent(2),
      applicationEvent(4, "other-user", "event-client"),
      applicationEvent(5, "event-user", "other-client"),
    ];
    for (const event of events) {
      insertEvent(sqlite, event);
      memory.applicationEvents.set(event.id, { ...event });
    }

    for (const store of [d1, memory]) {
      const first = await store.listApplicationEvents(
        "event-user",
        "event-client",
        null,
        2,
      );
      assert.deepEqual(
        first.items.map((event) => event.sequence),
        [1, 2],
      );
      assert.equal(first.hasMore, true);

      first.items[0]!.type = "mutated.result";
      const repeated = await store.listApplicationEvents(
        "event-user",
        "event-client",
        0,
        2,
      );
      assert.equal(repeated.items[0]?.type, "example.created");

      const second = await store.listApplicationEvents(
        "event-user",
        "event-client",
        2,
        2,
      );
      assert.deepEqual(
        second.items.map((event) => event.sequence),
        [3],
      );
      assert.equal(second.hasMore, false);
      assert.deepEqual(
        await store.listApplicationEvents("event-user", "event-client", 3, 2),
        { items: [], hasMore: false },
      );
    }

    assert.equal(
      calls.every((call) => /ORDER BY sequence ASC LIMIT \?/.test(call.query)),
      true,
    );
    assert.equal(
      calls.some((call) => call.values.at(-1) === 3),
      true,
    );
  } finally {
    sqlite.close();
  }
});

test("D1 and memory event pages apply one exact type before bounding the page", async () => {
  const sqlite = await migratedDatabase();
  try {
    seedNamespaces(sqlite);
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const stores = [
      new D1AuthStore(sqliteD1(sqlite, calls)),
      new MemoryAuthStore(),
    ];
    const events = [
      applicationEvent(1, "event-user", "event-client", "invoice.created"),
      applicationEvent(2, "event-user", "event-client", "invoice.paid"),
      applicationEvent(3, "event-user", "event-client", "invoice.created"),
      applicationEvent(4, "event-user", "event-client", "invoice.created"),
    ];
    for (const event of events) {
      insertEvent(sqlite, event);
      (stores[1] as MemoryAuthStore).applicationEvents.set(event.id, {
        ...event,
      });
    }

    for (const store of stores) {
      const first = await store.listApplicationEvents(
        "event-user",
        "event-client",
        null,
        2,
        "invoice.created",
      );
      assert.deepEqual(
        first.items.map((event) => event.sequence),
        [1, 3],
      );
      assert.equal(first.hasMore, true);
      const second = await store.listApplicationEvents(
        "event-user",
        "event-client",
        3,
        2,
        "invoice.created",
      );
      assert.deepEqual(
        second.items.map((event) => event.sequence),
        [4],
      );
      assert.equal(second.hasMore, false);
    }

    assert.equal(
      calls.some(
        (call) =>
          /event_type = \?/.test(call.query) &&
          call.values.includes("invoice.created"),
      ),
      true,
    );
    const indexColumns = sqlite
      .prepare("PRAGMA index_info(idx_application_events_owner_type_sequence)")
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      indexColumns.map((column) => column.name),
      ["user_id", "client_id", "event_type", "sequence"],
    );
  } finally {
    sqlite.close();
  }
});

test("event pages never cross principal or client namespaces", async () => {
  const sqlite = await migratedDatabase();
  try {
    seedNamespaces(sqlite);
    const d1 = new D1AuthStore(sqliteD1(sqlite));
    const memory = new MemoryAuthStore();
    const events = [
      applicationEvent(1),
      applicationEvent(2, "other-user", "event-client"),
      applicationEvent(3, "event-user", "other-client"),
    ];
    for (const event of events) {
      insertEvent(sqlite, event);
      memory.applicationEvents.set(event.id, { ...event });
    }

    for (const store of [d1, memory]) {
      const owned = await store.listApplicationEvents(
        "event-user",
        "event-client",
        null,
        10,
      );
      assert.deepEqual(
        owned.items.map((event) => event.sequence),
        [1],
      );
      assert.deepEqual(
        (
          await store.listApplicationEvents(
            "other-user",
            "event-client",
            null,
            10,
          )
        ).items.map((event) => event.sequence),
        [2],
      );
      assert.deepEqual(
        (
          await store.listApplicationEvents(
            "event-user",
            "other-client",
            null,
            10,
          )
        ).items.map((event) => event.sequence),
        [3],
      );
    }
  } finally {
    sqlite.close();
  }
});

test("event page inputs fail before either repository reads state", async () => {
  const sqlite = await migratedDatabase();
  try {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const stores = [
      new D1AuthStore(sqliteD1(sqlite, calls)),
      new MemoryAuthStore(),
    ];
    const invalid: Array<[string, string, number | null, number]> = [
      ["", "client", null, 1],
      ["user", "client\nother", null, 1],
      ["user", "client", -1, 1],
      ["user", "client", 1.5, 1],
      ["user", "client", null, 0],
      ["user", "client", null, 101],
    ];
    for (const store of stores) {
      for (const [userId, clientId, after, limit] of invalid) {
        await assert.rejects(
          store.listApplicationEvents(userId, clientId, after, limit),
          /application_event_(principal|client|page)_invalid/,
        );
      }
      for (const type of ["", "bad type", "a".repeat(129)]) {
        await assert.rejects(
          store.listApplicationEvents("user", "client", null, 1, type),
          /application_event_type_invalid/,
        );
      }
    }
    assert.deepEqual(calls, []);
  } finally {
    sqlite.close();
  }
});

test("event page repositories fail closed on malformed persisted values", async () => {
  const malformed = { ...applicationEvent(1), sequence: 0 };
  const memory = new MemoryAuthStore();
  memory.applicationEvents.set(malformed.id, malformed);
  await assert.rejects(
    memory.listApplicationEvents("event-user", "event-client", null, 1),
    /application_event_sequence_invalid/,
  );

  const d1 = new D1AuthStore({
    prepare(): D1PreparedStatement {
      const statement: D1PreparedStatement = {
        bind(): D1PreparedStatement {
          return statement;
        },
        async first<T>(): Promise<T | null> {
          return null;
        },
        async all<T>(): Promise<D1Result<T>> {
          return {
            success: true,
            results: [{ sequence: "not-an-integer" }] as T[],
          };
        },
        async run<T>(): Promise<D1Result<T>> {
          return { success: true };
        },
      };
      return statement;
    },
  });
  await assert.rejects(
    d1.listApplicationEvents("event-user", "event-client", null, 1),
    /application_event_row_invalid/,
  );
});

function applicationEvent(
  sequence: number,
  userId = "event-user",
  clientId = "event-client",
  type = "example.created",
): ApplicationEvent {
  const dataJson = JSON.stringify({ sequence });
  return {
    sequence,
    id: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    userId,
    clientId,
    type,
    dataJson,
    dataBytes: new TextEncoder().encode(dataJson).byteLength,
    idempotencyKeyHash: null,
    requestHash: sequence.toString().padStart(43, "0"),
    createdAt: 100 + sequence,
    expiresAt: 200 + sequence,
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

function seedNamespaces(sqlite: DatabaseSync): void {
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

function sqliteD1(
  database: DatabaseSync,
  calls: Array<{ query: string; values: unknown[] }> = [],
): D1Database {
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
          calls.push({ query, values: [...values] });
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
