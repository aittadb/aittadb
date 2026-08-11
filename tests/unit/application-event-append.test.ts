import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  ApplicationEventAppendResult,
  ApplicationEventLimits,
  ApplicationEventInput,
  AuthStore,
  ClientView,
  LocalUser,
} from "../../src/types";
import { testEnv } from "../helpers";

const USER_ID = "event-user";
const CLIENT_ID = "event-client";
const FIRST_ID = "00000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_HASH = "i".repeat(43);
const REQUEST_HASH = "r".repeat(43);
const WIDE_LIMITS: ApplicationEventLimits = {
  globalMaxItems: 1_000,
  globalMaxBytes: 10_000_000,
  userMaxItems: 1_000,
  userMaxBytes: 10_000_000,
  namespaceMaxItems: 1_000,
  namespaceMaxBytes: 10_000_000,
};

test("event admission configuration has finite strict defaults", async () => {
  const env = await testEnv();
  const defaults = loadConfig(env, env.ISSUER_URL!);
  assert.deepEqual(defaults.eventLimits, {
    globalMaxItems: 10_000,
    globalMaxBytes: 256 * 1024 * 1024,
    userMaxItems: 1_000,
    userMaxBytes: 32 * 1024 * 1024,
    namespaceMaxItems: 500,
    namespaceMaxBytes: 16 * 1024 * 1024,
  });
  assert.equal(
    loadConfig({ ...env, EVENTS_NAMESPACE_MAX_ITEMS: "7" }, env.ISSUER_URL!)
      .eventLimits.namespaceMaxItems,
    7,
  );
  for (const value of ["0", "-1", "1.5", "unlimited"]) {
    assert.throws(
      () =>
        loadConfig({ ...env, EVENTS_GLOBAL_MAX_BYTES: value }, env.ISSUER_URL!),
      /Expected positive integer/,
      value,
    );
  }
});

test("D1 and memory append once, replay exactly, and reject conflicting reuse", async () => {
  const harnesses = await eventStores();
  try {
    for (const harness of harnesses) {
      const created = await append(harness.store);
      assert.equal(created.status, "created");
      assert.equal(created.status === "created" && created.event.id, FIRST_ID);

      const replayed = await append(harness.store, {
        ...eventInput(),
        id: "00000000-0000-4000-8000-000000000002",
      });
      assert.equal(replayed.status, "replayed");
      assert.equal(
        replayed.status === "replayed" && replayed.event.id,
        FIRST_ID,
      );

      const conflict = await append(harness.store, {
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
        const result = await append(harness.store, {
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
        append(harness.store),
        append(harness.store, {
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

test("D1 and memory enforce each event item ceiling without crossing namespaces", async () => {
  for (const dimension of ["namespace", "user", "global"] as const) {
    const harnesses = await eventStores();
    try {
      for (const harness of harnesses) {
        await harness.seedNamespace(USER_ID, "event-client-2");
        await harness.seedNamespace("event-user-2", "event-client-3");
        const limits = eventLimits(
          dimension === "namespace"
            ? { namespaceMaxItems: 1 }
            : dimension === "user"
              ? { userMaxItems: 1 }
              : { globalMaxItems: 1 },
        );
        assert.equal(
          (await append(harness.store, numberedEvent(101), limits)).status,
          "created",
        );
        const second =
          dimension === "namespace"
            ? numberedEvent(102)
            : dimension === "user"
              ? numberedEvent(102, USER_ID, "event-client-2")
              : numberedEvent(102, "event-user-2", "event-client-3");
        assert.deepEqual(await append(harness.store, second, limits), {
          status: "quota_exceeded",
        });

        const independent =
          dimension === "namespace"
            ? numberedEvent(103, USER_ID, "event-client-2")
            : dimension === "user"
              ? numberedEvent(103, "event-user-2", "event-client-3")
              : null;
        if (independent) {
          assert.equal(
            (await append(harness.store, independent, limits)).status,
            "created",
          );
        }
      }
    } finally {
      closeHarnesses(harnesses);
    }
  }
});

test("D1 and memory account exact UTF-8 bytes at every event ceiling", async () => {
  const payload = JSON.stringify({ message: "Hyvää" });
  const bytes = new TextEncoder().encode(payload).byteLength;
  assert.ok(bytes > payload.length);
  for (const dimension of ["namespace", "user", "global"] as const) {
    const harnesses = await eventStores();
    try {
      for (const harness of harnesses) {
        const limits = eventLimits(
          dimension === "namespace"
            ? { namespaceMaxBytes: bytes }
            : dimension === "user"
              ? { userMaxBytes: bytes }
              : { globalMaxBytes: bytes },
        );
        const first = {
          ...numberedEvent(111),
          dataJson: payload,
          dataBytes: bytes,
        };
        assert.equal(
          (await append(harness.store, first, limits)).status,
          "created",
        );
        assert.deepEqual(
          await append(
            harness.store,
            { ...first, id: eventId(112), idempotencyKeyHash: null },
            limits,
          ),
          { status: "quota_exceeded" },
        );
      }
    } finally {
      closeHarnesses(harnesses);
    }
  }
});

test("idempotent retry and conflict remain exact after quota is full", async () => {
  const harnesses = await eventStores();
  try {
    for (const harness of harnesses) {
      const limits = eventLimits({ namespaceMaxItems: 1 });
      assert.equal(
        (await append(harness.store, eventInput(), limits)).status,
        "created",
      );
      assert.equal(
        (
          await append(
            harness.store,
            { ...eventInput(), id: eventId(121) },
            limits,
          )
        ).status,
        "replayed",
      );
      assert.deepEqual(
        await append(
          harness.store,
          {
            ...eventInput(),
            id: eventId(122),
            requestHash: "x".repeat(43),
          },
          limits,
        ),
        { status: "conflict" },
      );
      assert.equal(await harness.count(), 1);
      assert.equal(
        (
          await harness.store.listApplicationEvents(
            USER_ID,
            CLIENT_ID,
            null,
            10,
          )
        ).items.length,
        1,
      );
    }
  } finally {
    closeHarnesses(harnesses);
  }
});

test("concurrent boundary attempts have one event admission winner", async () => {
  const harnesses = await eventStores();
  try {
    for (const harness of harnesses) {
      const limits = eventLimits({ namespaceMaxItems: 1 });
      const statuses = await Promise.all([
        append(harness.store, numberedEvent(131), limits),
        append(harness.store, numberedEvent(132), limits),
      ]);
      assert.deepEqual(statuses.map((result) => result.status).sort(), [
        "created",
        "quota_exceeded",
      ]);
      assert.equal(await harness.count(), 1);
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
        await append(harness.store, {
          ...eventInput(),
          userId: "missing-user",
        }),
        { status: "unavailable" },
      );
      assert.deepEqual(
        await append(harness.store, {
          ...eventInput(),
          clientId: "missing-client",
        }),
        { status: "unavailable" },
      );

      await harness.disableClient();
      assert.deepEqual(await append(harness.store), { status: "unavailable" });
      await harness.enableClient();
      await harness.startDeletion();
      assert.deepEqual(await append(harness.store), { status: "unavailable" });
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
      assert.equal((await append(harness.store)).status, "created");
      await harness.disableClient();
      assert.deepEqual(
        await append(harness.store, {
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
      store.appendApplicationEvent(
        { ...eventInput(), id: "not-an-id" },
        WIDE_LIMITS,
      ),
      /application_event_id_invalid/,
    );
    await assert.rejects(
      store.appendApplicationEvent(eventInput(), {
        ...WIDE_LIMITS,
        namespaceMaxItems: 0,
      }),
      /application_event_limits_invalid/,
    );
  }
  assert.equal(prepares, 0);
  assert.equal(memory.applicationEvents.size, 0);
});

test("D1 preserves admission-classifier failures", async () => {
  let prepares = 0;
  const d1 = new D1AuthStore({
    prepare(): D1PreparedStatement {
      prepares += 1;
      const statement: D1PreparedStatement = {
        bind(): D1PreparedStatement {
          return statement;
        },
        async first<T>(): Promise<T | null> {
          if (prepares === 1) return null;
          throw new Error("classifier_down");
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
    d1.appendApplicationEvent(
      { ...eventInput(), idempotencyKeyHash: null },
      WIDE_LIMITS,
    ),
    /classifier_down/,
  );
  assert.equal(prepares, 2);
});

test("D1 append starts with one conditional insert and preserves failures", async () => {
  const queries: string[] = [];
  const bindings: unknown[][] = [];
  const d1 = new D1AuthStore({
    prepare(query: string): D1PreparedStatement {
      queries.push(query);
      const statement: D1PreparedStatement = {
        bind(...values: unknown[]): D1PreparedStatement {
          bindings.push(values);
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
    d1.appendApplicationEvent(eventInput(), WIDE_LIMITS),
    /database_down/,
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /^\s*INSERT INTO application_events/);
  assert.match(queries[0]!, /ON CONFLICT DO NOTHING\s+RETURNING \*/);
  assert.match(queries[0]!, /disabled_at IS NULL/);
  assert.match(queries[0]!, /NOT EXISTS[\s\S]+account_deletion_jobs/);
  assert.match(queries[0]!, /COUNT\(\*\)[\s\S]+SUM\(data_bytes\)/);
  assert.equal(bindings[0]?.length, 16);
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
    d1.appendApplicationEvent(input, WIDE_LIMITS),
    /application_event_append_result_invalid/,
  );
});

interface StoreHarness {
  store: AuthStore;
  count(): Promise<number>;
  seedNamespace(userId: string, clientId: string): Promise<void>;
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
      async seedNamespace(userId: string, clientId: string): Promise<void> {
        sqlite
          .prepare(
            "INSERT OR IGNORE INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
          )
          .run(userId, `${userId}@example.test`, userId);
        sqlite
          .prepare(
            "INSERT OR IGNORE INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at) VALUES (?, 'public', ?, NULL, NULL, 1)",
          )
          .run(clientId, clientId);
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
      async seedNamespace(userId: string, clientId: string): Promise<void> {
        if (!memory.users.has(userId)) {
          const nextUser: LocalUser = {
            id: userId,
            email: `${userId}@example.test`,
            displayName: userId,
            createdAt: 1,
            updatedAt: 1,
          };
          memory.users.set(userId, nextUser);
          memory.usersByEmail.set(nextUser.email, userId);
        }
        if (!memory.clients.has(clientId)) {
          memory.clients.set(clientId, {
            id: clientId,
            type: "public",
            name: clientId,
            disabledAt: null,
            redirectUris: [],
            scopes: [],
            origins: [],
            createdAt: 1,
            secretHash: null,
          });
        }
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

function append(
  store: AuthStore,
  input: ApplicationEventInput = eventInput(),
  limits: ApplicationEventLimits = WIDE_LIMITS,
): Promise<ApplicationEventAppendResult> {
  return store.appendApplicationEvent(input, limits);
}

function eventLimits(
  overrides: Partial<ApplicationEventLimits>,
): ApplicationEventLimits {
  return { ...WIDE_LIMITS, ...overrides };
}

function eventId(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function numberedEvent(
  value: number,
  userId = USER_ID,
  clientId = CLIENT_ID,
): ApplicationEventInput {
  return {
    ...eventInput(),
    id: eventId(value),
    userId,
    clientId,
    idempotencyKeyHash: null,
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
