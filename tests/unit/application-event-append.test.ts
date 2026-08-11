import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  ApplicationEventInput,
  AuthStore,
  ClientView,
  LocalUser,
} from "../../src/types";

const USER_ID = "event-user";
const CLIENT_ID = "event-client";
const FIRST_ID = "00000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_HASH = "i".repeat(43);
const REQUEST_HASH = "r".repeat(43);

test("D1 and memory append once, replay exactly, and reject conflicting reuse", async () => {
  const harnesses = await eventStores();
  try {
    for (const harness of harnesses) {
      const created = await harness.store.appendApplicationEvent(eventInput());
      assert.equal(created.status, "created");
      assert.equal(created.status === "created" && created.event.id, FIRST_ID);

      const replayed = await harness.store.appendApplicationEvent({
        ...eventInput(),
        id: "00000000-0000-4000-8000-000000000002",
      });
      assert.equal(replayed.status, "replayed");
      assert.equal(
        replayed.status === "replayed" && replayed.event.id,
        FIRST_ID,
      );

      const conflict = await harness.store.appendApplicationEvent({
        ...eventInput(),
        id: "00000000-0000-4000-8000-000000000003",
        requestHash: "c".repeat(43),
      });
      assert.deepEqual(conflict, { status: "conflict" });
      assert.equal(await harness.count(), 1);

      if (created.status === "created") created.event.type = "mutated.result";
      assert.equal(
        (await harness.store.getApplicationEvent(USER_ID, CLIENT_ID, FIRST_ID))
          ?.type,
        "example.created",
      );
    }
  } finally {
    closeHarnesses(harnesses);
  }
});

test("append without an idempotency hash creates independent events", async () => {
  const harnesses = await eventStores();
  try {
    for (const harness of harnesses) {
      for (const id of [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
      ]) {
        const result = await harness.store.appendApplicationEvent({
          ...eventInput(),
          id,
          idempotencyKeyHash: null,
        });
        assert.equal(result.status, "created");
      }
      assert.equal(await harness.count(), 2);
      const page = await harness.store.listApplicationEvents(
        USER_ID,
        CLIENT_ID,
        null,
        10,
      );
      assert.deepEqual(
        page.items.map((event) => event.sequence),
        [1, 2],
      );
    }
  } finally {
    closeHarnesses(harnesses);
  }
});

test("concurrent equal appends have one created result and one replay", async () => {
  const harnesses = await eventStores();
  try {
    for (const harness of harnesses) {
      const results = await Promise.all([
        harness.store.appendApplicationEvent(eventInput()),
        harness.store.appendApplicationEvent({
          ...eventInput(),
          id: "00000000-0000-4000-8000-000000000022",
        }),
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), [
        "created",
        "replayed",
      ]);
      assert.equal(await harness.count(), 1);
      const ids = results.flatMap((result) =>
        result.status === "created" || result.status === "replayed"
          ? [result.event.id]
          : [],
      );
      assert.equal(new Set(ids).size, 1);
    }
  } finally {
    closeHarnesses(harnesses);
  }
});

test("missing, disabled, and deleting ownership returns unavailable", async () => {
  const harnesses = await eventStores();
  try {
    for (const harness of harnesses) {
      assert.deepEqual(
        await harness.store.appendApplicationEvent({
          ...eventInput(),
          userId: "missing-user",
        }),
        { status: "unavailable" },
      );
      assert.deepEqual(
        await harness.store.appendApplicationEvent({
          ...eventInput(),
          clientId: "missing-client",
        }),
        { status: "unavailable" },
      );

      await harness.disableClient();
      assert.deepEqual(
        await harness.store.appendApplicationEvent(eventInput()),
        { status: "unavailable" },
      );
      await harness.enableClient();
      await harness.startDeletion();
      assert.deepEqual(
        await harness.store.appendApplicationEvent(eventInput()),
        { status: "unavailable" },
      );
      assert.equal(await harness.count(), 0);
    }
  } finally {
    closeHarnesses(harnesses);
  }
});

test("a disabled client cannot replay an event created while active", async () => {
  const harnesses = await eventStores();
  try {
    for (const harness of harnesses) {
      assert.equal(
        (await harness.store.appendApplicationEvent(eventInput())).status,
        "created",
      );
      await harness.disableClient();
      assert.deepEqual(
        await harness.store.appendApplicationEvent({
          ...eventInput(),
          id: "00000000-0000-4000-8000-000000000032",
        }),
        { status: "unavailable" },
      );
      assert.equal(await harness.count(), 1);
    }
  } finally {
    closeHarnesses(harnesses);
  }
});

test("malformed append input fails before repository access", async () => {
  let prepares = 0;
  const d1 = new D1AuthStore({
    prepare(): D1PreparedStatement {
      prepares += 1;
      throw new Error("unexpected_prepare");
    },
  });
  const memory = new MemoryAuthStore();
  for (const store of [d1, memory]) {
    await assert.rejects(
      store.appendApplicationEvent({ ...eventInput(), id: "not-an-id" }),
      /application_event_id_invalid/,
    );
  }
  assert.equal(prepares, 0);
  assert.equal(memory.applicationEvents.size, 0);
});

test("D1 append starts with one conditional insert and preserves failures", async () => {
  const queries: string[] = [];
  const d1 = new D1AuthStore({
    prepare(query: string): D1PreparedStatement {
      queries.push(query);
      const statement: D1PreparedStatement = {
        bind(): D1PreparedStatement {
          return statement;
        },
        async first<T>(): Promise<T | null> {
          throw new Error("database_down");
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
    d1.appendApplicationEvent(eventInput()),
    /database_down/,
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /^\s*INSERT INTO application_events/);
  assert.match(queries[0]!, /ON CONFLICT DO NOTHING\s+RETURNING \*/);
  assert.match(queries[0]!, /disabled_at IS NULL/);
  assert.match(queries[0]!, /NOT EXISTS[\s\S]+account_deletion_jobs/);
});

test("D1 append rejects a valid but mismatched returned row", async () => {
  const input = eventInput();
  const mismatched = {
    sequence: 1,
    id: input.id,
    user_id: "other-user",
    client_id: input.clientId,
    event_type: input.type,
    data_json: input.dataJson,
    data_bytes: input.dataBytes,
    idempotency_key_hash: input.idempotencyKeyHash,
    request_hash: input.requestHash,
    created_at: input.createdAt,
    expires_at: input.expiresAt,
  };
  const d1 = new D1AuthStore({
    prepare(): D1PreparedStatement {
      const statement: D1PreparedStatement = {
        bind(): D1PreparedStatement {
          return statement;
        },
        async first<T>(): Promise<T | null> {
          return mismatched as T;
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
    d1.appendApplicationEvent(input),
    /application_event_append_result_invalid/,
  );
});

interface StoreHarness {
  store: AuthStore;
  count(): Promise<number>;
  disableClient(): Promise<void>;
  enableClient(): Promise<void>;
  startDeletion(): Promise<void>;
  close(): void;
}

async function eventStores(): Promise<StoreHarness[]> {
  const sqlite = await migratedDatabase();
  seedD1(sqlite);
  const d1Store = new D1AuthStore(sqliteD1(sqlite));

  const memory = new MemoryAuthStore();
  const user: LocalUser = {
    id: USER_ID,
    email: "event-user@example.test",
    displayName: "Event User",
    createdAt: 1,
    updatedAt: 1,
  };
  const client: ClientView & { secretHash: string | null } = {
    id: CLIENT_ID,
    type: "public",
    name: "Event Client",
    disabledAt: null,
    redirectUris: [],
    scopes: [],
    origins: [],
    createdAt: 1,
    secretHash: null,
  };
  memory.users.set(user.id, user);
  memory.usersByEmail.set(user.email, user.id);
  memory.clients.set(client.id, client);

  return [
    {
      store: d1Store,
      async count(): Promise<number> {
        return Number(
          sqlite
            .prepare("SELECT COUNT(*) AS count FROM application_events")
            .get()?.count ?? 0,
        );
      },
      async disableClient(): Promise<void> {
        sqlite
          .prepare("UPDATE oauth_clients SET disabled_at = 10 WHERE id = ?")
          .run(CLIENT_ID);
      },
      async enableClient(): Promise<void> {
        sqlite
          .prepare("UPDATE oauth_clients SET disabled_at = NULL WHERE id = ?")
          .run(CLIENT_ID);
      },
      async startDeletion(): Promise<void> {
        sqlite
          .prepare(
            "INSERT INTO account_deletion_jobs (subject, state, attempt, available_at, created_at, updated_at, completed_at) VALUES (?, 'pending', 0, 10, 1, 1, NULL)",
          )
          .run(USER_ID);
      },
      close(): void {
        sqlite.close();
      },
    },
    {
      store: memory,
      async count(): Promise<number> {
        return memory.applicationEvents.size;
      },
      async disableClient(): Promise<void> {
        memory.clients.get(CLIENT_ID)!.disabledAt = 10;
      },
      async enableClient(): Promise<void> {
        memory.clients.get(CLIENT_ID)!.disabledAt = null;
      },
      async startDeletion(): Promise<void> {
        await memory.startAccountDeletionJob(USER_ID, 1);
      },
      close(): void {},
    },
  ];
}

function closeHarnesses(harnesses: StoreHarness[]): void {
  for (const harness of harnesses) harness.close();
}

function eventInput(): ApplicationEventInput {
  const dataJson = JSON.stringify({ message: "append" });
  return {
    id: FIRST_ID,
    userId: USER_ID,
    clientId: CLIENT_ID,
    type: "example.created",
    dataJson,
    dataBytes: new TextEncoder().encode(dataJson).byteLength,
    idempotencyKeyHash: IDEMPOTENCY_HASH,
    requestHash: REQUEST_HASH,
    createdAt: 100,
    expiresAt: 200,
  };
}

function seedD1(sqlite: DatabaseSync): void {
  sqlite.exec(
    "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('event-user', 'event-user@example.test', 'Event User', 1, 1); INSERT INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at) VALUES ('event-client', 'public', 'Event Client', NULL, NULL, 1)",
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
