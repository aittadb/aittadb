import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  AuthStore,
  BoundedStorageRecord,
  ClientView,
  StorageLimits,
} from "../../src/types";

const OPEN_LIMITS: StorageLimits = {
  writesEnabled: true,
  globalMaxItems: 10_000,
  globalMaxBytes: 1_000_000_000,
  userMaxItems: 10_000,
  userMaxBytes: 1_000_000_000,
  namespaceMaxItems: 10_000,
  namespaceMaxBytes: 1_000_000_000,
};

test("D1 and memory read stable bounded-record pages without crossing namespaces", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(fixture.store, `${adapter.name}-a`);
        const other = await createSubject(fixture.store, `${adapter.name}-b`);
        const primary = await createClient(fixture.store, `${adapter.name}-a`);
        const secondary = await createClient(
          fixture.store,
          `${adapter.name}-b`,
        );
        const expected: BoundedStorageRecord[] = [];
        for (let index = 0; index < 106; index += 1) {
          const record = boundedRecord(
            owner,
            primary.id,
            "positions",
            `record-${String(index).padStart(3, "0")}`,
            index + 1,
          );
          expected.push(record);
          await fixture.seed(record);
        }
        await fixture.seed(
          boundedRecord(owner, primary.id, "other", "record-000", 500),
        );
        await fixture.seed(
          boundedRecord(owner, secondary.id, "positions", "record-000", 501),
        );
        await fixture.seed(
          boundedRecord(other, primary.id, "positions", "record-000", 502),
        );

        assert.deepEqual(
          await fixture.store.getBoundedStorageRecord(
            owner,
            primary.id,
            "positions",
            "record-042",
          ),
          expected[42],
        );
        assert.equal(
          await fixture.store.getBoundedStorageRecord(
            other,
            primary.id,
            "positions",
            "record-042",
          ),
          null,
        );

        const first = await fixture.store.listBoundedStorageRecords(
          owner,
          primary.id,
          "positions",
          null,
          100,
        );
        assert.deepEqual(first, {
          items: expected.slice(0, 100),
          hasMore: true,
        });
        const second = await fixture.store.listBoundedStorageRecords(
          owner,
          primary.id,
          "positions",
          first.items.at(-1)!.id,
          100,
        );
        assert.deepEqual(second, {
          items: expected.slice(100),
          hasMore: false,
        });
        assert.deepEqual(
          await fixture
            .reconstruct()
            .listBoundedStorageRecords(
              owner,
              primary.id,
              "positions",
              "record-102",
              3,
            ),
          { items: expected.slice(103, 106), hasMore: false },
        );

        await assert.rejects(
          fixture.store.listBoundedStorageRecords(
            owner,
            primary.id,
            "positions",
            null,
            101,
          ),
          /bounded_storage_record_page_invalid/,
        );
        await assert.rejects(
          fixture.store.getBoundedStorageRecord(
            owner,
            primary.id,
            "Positions",
            "record-001",
          ),
          /bounded_storage_record_key_invalid/,
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("bounded records participate in every existing storage usage and quota boundary", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(
          fixture.store,
          `${adapter.name}-quota`,
        );
        const client = await createClient(
          fixture.store,
          `${adapter.name}-quota`,
        );
        const record = boundedRecord(
          owner,
          client.id,
          "items",
          "only-record",
          1,
        );
        await fixture.seed(record);
        assert.deepEqual(
          await fixture.store.getStorageUsage(owner, client.id),
          {
            itemCount: 1,
            byteCount: record.valueBytes,
          },
        );

        const oneItemOnly: StorageLimits = {
          ...OPEN_LIMITS,
          globalMaxItems: 1,
          userMaxItems: 1,
          namespaceMaxItems: 1,
        };
        assert.equal(
          await fixture.store.upsertStorageRecord(
            {
              userId: owner,
              clientId: client.id,
              key: "legacy",
              valueJson: JSON.stringify({ accepted: false }),
              createdAt: 20,
              updatedAt: 20,
            },
            oneItemOnly,
          ),
          false,
        );
        assert.equal(
          await fixture.store.upsertStorageFileMetadata(
            {
              userId: owner,
              clientId: client.id,
              key: "file",
              r2Key: "objects/test-file",
              contentType: "application/octet-stream",
              size: 1,
              sha256: "0".repeat(64),
              createdAt: 20,
              updatedAt: 20,
            },
            null,
            oneItemOnly,
          ),
          false,
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("account deletion purges bounded and legacy records before finalization", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(
          fixture.store,
          `${adapter.name}-delete`,
        );
        const client = await createClient(
          fixture.store,
          `${adapter.name}-delete`,
        );
        for (let index = 0; index < 4; index += 1) {
          await fixture.seed(
            boundedRecord(
              owner,
              client.id,
              "items",
              `bounded-${index}`,
              index + 1,
            ),
          );
        }
        for (let index = 0; index < 2; index += 1) {
          assert.equal(
            await fixture.store.upsertStorageRecord(
              {
                userId: owner,
                clientId: client.id,
                key: `legacy-${index}`,
                valueJson: JSON.stringify({ index }),
                createdAt: index + 1,
                updatedAt: index + 1,
              },
              OPEN_LIMITS,
            ),
            true,
          );
        }
        await fixture.store.startAccountDeletionJob(owner, 100);
        const claim = (
          await fixture.store.claimAccountDeletionJobs(100, 60, 1)
        )[0];
        assert.ok(claim);
        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            owner,
            claim.attempt,
            101,
          ),
          false,
        );
        assert.deepEqual(await fixture.store.purgeAccountRecords(owner, 3), {
          deletedCount: 3,
          done: false,
        });
        assert.deepEqual(await fixture.store.purgeAccountRecords(owner, 3), {
          deletedCount: 3,
          done: false,
        });
        assert.deepEqual(await fixture.store.purgeAccountRecords(owner, 3), {
          deletedCount: 0,
          done: true,
        });
        assert.deepEqual(
          await fixture.store.getStorageUsage(owner, client.id),
          {
            itemCount: 0,
            byteCount: 0,
          },
        );
        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            owner,
            claim.attempt,
            101,
          ),
          true,
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("bounded-record migration enforces shape, byte counts, revisions, and deletion guards", async () => {
  const sqlite = await migratedDatabase();
  try {
    sqlite.exec(
      "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('user', 'migration@example.test', 'Migration', 1, 1); INSERT INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at) VALUES ('client', 'public', 'Client', NULL, NULL, 1);",
    );
    insertBoundedRow(sqlite, "valid", "record-1", '{"ok":true}', 1);
    assert.equal(
      Number(
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM bounded_storage_records")
          .get()?.count,
      ),
      1,
    );
    assert.throws(() =>
      insertBoundedRow(sqlite, "Invalid", "record-2", '{"ok":true}', 1),
    );
    assert.throws(() =>
      insertBoundedRow(sqlite, "valid", "record-", '{"ok":true}', 1),
    );
    assert.throws(() => insertBoundedRow(sqlite, "valid", "record-2", "[]", 1));
    assert.throws(() =>
      insertBoundedRow(sqlite, "valid", "record-2", '{"ok":true}', 0),
    );
    assert.throws(() =>
      sqlite
        .prepare(
          "INSERT INTO bounded_storage_records (user_id, client_id, collection, record_id, value_json, value_bytes, revision, created_at, updated_at) VALUES ('user', 'client', 'valid', 'record-2', '{\"ok\":true}', 1, 1, 1, 1)",
        )
        .run(),
    );
    sqlite.exec(
      "INSERT INTO account_deletion_jobs (subject, state, attempt, available_at, created_at, updated_at, completed_at) VALUES ('user', 'pending', 0, 2, 2, 2, NULL)",
    );
    assert.throws(() =>
      insertBoundedRow(sqlite, "valid", "record-3", '{"ok":true}', 1),
    );
    assert.throws(() =>
      sqlite
        .prepare(
          "UPDATE account_deletion_jobs SET state = 'completed' WHERE subject = 'user'",
        )
        .run(),
    );
  } finally {
    sqlite.close();
  }
});

test("bounded-record reads fail closed on malformed persisted adapter rows", async () => {
  const malformed = {
    user_id: "user",
    client_id: "client",
    collection: "items",
    record_id: "record-1",
    value_json: '{"private":"value"}',
    value_bytes: 1,
    revision: 1,
    created_at: 1,
    updated_at: 1,
  };
  const statement: D1PreparedStatement = {
    bind: () => statement,
    first: async <T>() => malformed as T,
    all: async <T>() => ({ success: true, results: [malformed as T] }),
    run: async () => ({ success: false }),
  };
  const store = new D1AuthStore({ prepare: () => statement });
  await assert.rejects(
    store.getBoundedStorageRecord("user", "client", "items", "record-1"),
    /bounded_storage_record_row_invalid/,
  );
  await assert.rejects(
    store.listBoundedStorageRecords("user", "client", "items", null, 10),
    /bounded_storage_record_row_invalid/,
  );
});

interface Fixture {
  store: AuthStore;
  seed(record: BoundedStorageRecord): Promise<void>;
  reconstruct(): AuthStore;
  close(): void;
}

function adapters(): Array<{
  name: string;
  create(): Promise<Fixture>;
}> {
  return [
    {
      name: "memory",
      async create() {
        const store = new MemoryAuthStore();
        return {
          store,
          async seed(record) {
            store.boundedStorageRecords.set(
              JSON.stringify([
                record.userId,
                record.clientId,
                record.collection,
                record.id,
              ]),
              { ...record },
            );
          },
          reconstruct: () => store,
          close: () => undefined,
        };
      },
    },
    {
      name: "d1",
      async create() {
        const sqlite = await migratedDatabase();
        const d1 = sqliteD1(sqlite);
        return {
          store: new D1AuthStore(d1),
          async seed(record) {
            sqlite
              .prepare(
                "INSERT INTO bounded_storage_records (user_id, client_id, collection, record_id, value_json, value_bytes, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              )
              .run(
                record.userId,
                record.clientId,
                record.collection,
                record.id,
                record.valueJson,
                record.valueBytes,
                record.revision,
                record.createdAt,
                record.updatedAt,
              );
          },
          reconstruct: () => new D1AuthStore(d1),
          close: () => sqlite.close(),
        };
      },
    },
  ];
}

async function createSubject(store: AuthStore, name: string): Promise<string> {
  return (
    await store.findOrCreateUser(
      {
        email: `${name}@example.test`,
        fullName: null,
        displayName: name,
      },
      1,
    )
  ).id;
}

async function createClient(
  store: AuthStore,
  name: string,
): Promise<ClientView> {
  return store.createClient(
    {
      type: "public",
      name,
      redirectUris: [],
      scopes: ["storage.read", "storage.write", "storage.delete"],
      origins: [],
    },
    null,
    1,
  );
}

function boundedRecord(
  userId: string,
  clientId: string,
  collection: string,
  id: string,
  revision: number,
): BoundedStorageRecord {
  const valueJson = JSON.stringify({ id, revision });
  return {
    userId,
    clientId,
    collection,
    id,
    valueJson,
    valueBytes: new TextEncoder().encode(valueJson).byteLength,
    revision,
    createdAt: revision,
    updatedAt: revision,
  };
}

function insertBoundedRow(
  sqlite: DatabaseSync,
  collection: string,
  id: string,
  valueJson: string,
  revision: number,
): void {
  sqlite
    .prepare(
      "INSERT INTO bounded_storage_records (user_id, client_id, collection, record_id, value_json, value_bytes, revision, created_at, updated_at) VALUES ('user', 'client', ?, ?, ?, ?, ?, 1, 1)",
    )
    .run(
      collection,
      id,
      valueJson,
      new TextEncoder().encode(valueJson).byteLength,
      revision,
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
  return sqlite;
}

function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = new WeakMap<
    D1PreparedStatement,
    { query: string; values: SQLInputValue[] }
  >();
  return {
    prepare(query: string): D1PreparedStatement {
      const execution = { query, values: [] as SQLInputValue[] };
      const statement: D1PreparedStatement = {
        bind(...nextValues: unknown[]): D1PreparedStatement {
          execution.values = nextValues as SQLInputValue[];
          return statement;
        },
        async first<T>(): Promise<T | null> {
          return (
            (database.prepare(query).get(...execution.values) as
              | T
              | undefined) ?? null
          );
        },
        async all<T>(): Promise<D1Result<T>> {
          return {
            success: true,
            results: database.prepare(query).all(...execution.values) as T[],
          };
        },
        async run<T>(): Promise<D1Result<T>> {
          const result = database.prepare(query).run(...execution.values);
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          };
        },
      };
      prepared.set(statement, execution);
      return statement;
    },
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => {
          const execution = prepared.get(statement);
          assert.ok(execution);
          const result = database
            .prepare(execution.query)
            .run(...execution.values);
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          } as D1Result<T>;
        });
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
