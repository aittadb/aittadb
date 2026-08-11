import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import {
  APPLICATION_EVENT_CLEANUP_BATCH_SIZE,
  APPLICATION_EVENT_DEFAULT_RETENTION_SECONDS,
  APPLICATION_EVENT_MAX_RETENTION_SECONDS,
} from "../../src/application-events";
import { loadConfig } from "../../src/config";
import { createAittaDBWithStore } from "../../src/handler";
import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type { ApplicationEvent } from "../../src/types";
import { testEnv } from "../helpers";

const NOW = 1_000;
const USER = "event-user";
const OTHER_USER = "other-event-user";
const CLIENT = "event-client";
const OTHER_CLIENT = "other-event-client";

test("event retention configuration has a safe finite default and maximum", async () => {
  const env = await testEnv();
  assert.equal(
    loadConfig(env, env.ISSUER_URL!).eventRetentionSeconds,
    APPLICATION_EVENT_DEFAULT_RETENTION_SECONDS,
  );
  assert.equal(
    loadConfig({ ...env, EVENT_RETENTION_SECONDS: "3600" }, env.ISSUER_URL!)
      .eventRetentionSeconds,
    3_600,
  );
  assert.equal(
    loadConfig(
      {
        ...env,
        EVENT_RETENTION_SECONDS: String(
          APPLICATION_EVENT_MAX_RETENTION_SECONDS,
        ),
      },
      env.ISSUER_URL!,
    ).eventRetentionSeconds,
    APPLICATION_EVENT_MAX_RETENTION_SECONDS,
  );

  for (const value of ["0", "-1", "1.5", "one-day"]) {
    assert.throws(
      () =>
        loadConfig({ ...env, EVENT_RETENTION_SECONDS: value }, env.ISSUER_URL!),
      /Expected positive integer/,
    );
  }
  assert.throws(
    () =>
      loadConfig(
        {
          ...env,
          EVENT_RETENTION_SECONDS: String(
            APPLICATION_EVENT_MAX_RETENTION_SECONDS + 1,
          ),
        },
        env.ISSUER_URL!,
      ),
    /EVENT_RETENTION_SECONDS must not exceed 31536000/,
  );
});

test("memory cleanup deletes only the oldest finite expired event batch", async () => {
  const store = new MemoryAuthStore();
  seedEvents(store.applicationEvents);

  const first = await store.cleanup(NOW);
  assert.deepEqual(first["application-events"], {
    status: "verified",
    deletedCount: APPLICATION_EVENT_CLEANUP_BATCH_SIZE,
    limit: APPLICATION_EVENT_CLEANUP_BATCH_SIZE,
  });
  assert.deepEqual(eventExpiries(store.applicationEvents), [501, 2_000, 2_001]);

  const second = await store.cleanup(NOW);
  assert.equal(second["application-events"].deletedCount, 1);
  assert.deepEqual(eventExpiries(store.applicationEvents), [2_000, 2_001]);

  const third = await store.cleanup(NOW);
  assert.equal(third["application-events"].deletedCount, 0);
  assert.deepEqual(
    (await store.listApplicationEvents(USER, CLIENT, null, 100)).items.map(
      (event) => event.expiresAt,
    ),
    [2_000],
  );
  assert.deepEqual(
    (
      await store.listApplicationEvents(OTHER_USER, OTHER_CLIENT, null, 100)
    ).items.map((event) => event.expiresAt),
    [2_001],
  );
});

test("D1 cleanup deletes the indexed oldest finite batch with verified counts", async () => {
  const sqlite = await migratedDatabase();
  try {
    seedD1Namespaces(sqlite);
    const events = new Map<string, ApplicationEvent>();
    seedEvents(events);
    for (const event of events.values()) insertEvent(sqlite, event);

    const plan = sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT sequence FROM application_events WHERE expires_at <= ? ORDER BY expires_at ASC, sequence ASC LIMIT ?",
      )
      .all(NOW, APPLICATION_EVENT_CLEANUP_BATCH_SIZE)
      .map((row) => String(row.detail))
      .join(" ");
    assert.match(plan, /idx_application_events_expires_sequence/);

    const store = new D1AuthStore(sqliteD1(sqlite));
    const first = await store.cleanup(NOW);
    assert.deepEqual(first["application-events"], {
      status: "verified",
      deletedCount: APPLICATION_EVENT_CLEANUP_BATCH_SIZE,
      limit: APPLICATION_EVENT_CLEANUP_BATCH_SIZE,
    });
    assert.deepEqual(d1EventExpiries(sqlite), [501, 2_000, 2_001]);

    const second = await store.cleanup(NOW);
    assert.equal(second["application-events"].deletedCount, 1);
    const third = await store.cleanup(NOW);
    assert.equal(third["application-events"].deletedCount, 0);
    assert.deepEqual(d1EventExpiries(sqlite), [2_000, 2_001]);

    assert.deepEqual(
      (await store.listApplicationEvents(USER, CLIENT, null, 100)).items.map(
        (event) => event.expiresAt,
      ),
      [2_000],
    );
    assert.deepEqual(
      (
        await store.listApplicationEvents(OTHER_USER, OTHER_CLIENT, null, 100)
      ).items.map((event) => event.expiresAt),
      [2_001],
    );
  } finally {
    sqlite.close();
  }
});

test("an ordinary durable request schedules one bounded retention pass", async () => {
  const store = new MemoryAuthStore();
  const expired = applicationEvent(1, 1, USER, CLIENT);
  store.applicationEvents.set(expired.id, expired);
  const env = await testEnv({ BUCKET: undefined });
  const scheduled: Array<Promise<unknown>> = [];
  const app = createAittaDBWithStore(
    env,
    store,
    loadConfig(env, env.ISSUER_URL!),
    {
      waitUntil(promise): void {
        scheduled.push(promise);
      },
    },
  );

  const response = await app.fetch(
    new Request(`${env.ISSUER_URL}/statistics`, {
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(response?.status, 200);
  assert.equal(scheduled.length, 1);
  await Promise.all(scheduled);
  assert.equal(store.applicationEvents.size, 0);
});

function seedEvents(events: Map<string, ApplicationEvent>): void {
  for (let expiresAt = 501; expiresAt >= 1; expiresAt -= 1) {
    const sequence = 502 - expiresAt;
    const event = applicationEvent(sequence, expiresAt, USER, CLIENT);
    events.set(event.id, event);
  }
  for (const event of [
    applicationEvent(600, 2_000, USER, CLIENT),
    applicationEvent(601, 2_001, OTHER_USER, OTHER_CLIENT),
  ]) {
    events.set(event.id, event);
  }
}

function applicationEvent(
  sequence: number,
  expiresAt: number,
  userId: string,
  clientId: string,
): ApplicationEvent {
  const dataJson = JSON.stringify({ sequence });
  return {
    sequence,
    id: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`,
    userId,
    clientId,
    type: "test.event",
    dataJson,
    dataBytes: new TextEncoder().encode(dataJson).byteLength,
    idempotencyKeyHash: null,
    requestHash: "r".repeat(43),
    createdAt: 0,
    expiresAt,
  };
}

function eventExpiries(events: Map<string, ApplicationEvent>): number[] {
  return Array.from(events.values())
    .map((event) => event.expiresAt)
    .sort((left, right) => left - right);
}

function d1EventExpiries(sqlite: DatabaseSync): number[] {
  return sqlite
    .prepare("SELECT expires_at FROM application_events ORDER BY expires_at")
    .all()
    .map((row) => Number(row.expires_at));
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

function seedD1Namespaces(sqlite: DatabaseSync): void {
  sqlite.exec(
    "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('event-user', 'event-user@example.test', 'Event User', 1, 1), ('other-event-user', 'other-event-user@example.test', 'Other Event User', 1, 1); INSERT INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at) VALUES ('event-client', 'public', 'Event Client', NULL, NULL, 1), ('other-event-client', 'public', 'Other Event Client', NULL, NULL, 1)",
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
