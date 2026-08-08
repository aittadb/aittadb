import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { schemaTables } from "../../db/schema";
import { ACCOUNT_RECORD_PURGE_MAX_BATCH } from "../../src/store/account-record-purge";
import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  AuthStore,
  ClientView,
  StorageLimits,
  StorageRecord,
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

const TARGET_RECORD_COUNT = 237;
const PURGE_LIMIT = 37;

test("D1 and memory purge a large subject across clients in deterministic bounded batches", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const target = await createSubject(fixture.store, adapter.name, 1);
        const other = await createSubject(fixture.store, adapter.name, 2);
        const clients = await createClients(fixture.store, adapter.name);
        const targetRecords: StorageRecord[] = [];

        for (let index = 0; index < TARGET_RECORD_COUNT; index += 1) {
          const record = storageRecord(
            target,
            clients[index % clients.length]!.id,
            `target-${String(index).padStart(4, "0")}`,
            index,
          );
          targetRecords.push(record);
          assert.equal(
            await fixture.store.upsertStorageRecord(record, OPEN_LIMITS),
            true,
          );
        }
        for (let index = 0; index < 7; index += 1) {
          assert.equal(
            await fixture.store.upsertStorageRecord(
              storageRecord(other, clients[0]!.id, `other-${index}`, index),
              OPEN_LIMITS,
            ),
            true,
          );
        }

        await addFile(fixture.store, target, clients[0]!.id, "target-a", 11);
        await addFile(fixture.store, target, clients[1]!.id, "target-b", 13);
        await addFile(fixture.store, other, clients[2]!.id, "other", 17);
        assert.equal(
          await fixture.store.recordStorageFileOrphanRepair({
            userId: target,
            clientId: clients[0]!.id,
            r2Key: "unrelated-orphan-repair",
            createdAt: 500,
            updatedAt: 500,
          }),
          true,
        );
        await fixture.store.audit(
          "record_purge_control",
          { bounded: true },
          500,
        );
        assert.equal(
          await fixture.store.rateLimit("record-purge", 2, 60, 500),
          true,
        );
        await fixture.store.startAccountDeletionJob(target, 500);

        const cappedLimits = {
          ...OPEN_LIMITS,
          globalMaxItems: TARGET_RECORD_COUNT + 7 + 3,
        };
        const capacityProbe = storageRecord(
          other,
          clients[1]!.id,
          "capacity-probe",
          501,
        );
        assert.equal(
          await fixture.store.upsertStorageRecord(capacityProbe, cappedLimits),
          false,
        );

        const unrelatedBefore = await fixture.snapshotUnrelated();
        assert.deepEqual(await fixture.ownedRecordAccounting(target), {
          itemCount: TARGET_RECORD_COUNT,
          byteCount: targetRecords.reduce(
            (total, record) => total + Buffer.byteLength(record.valueJson),
            0,
          ),
        });

        const expectedOrder = [...targetRecords].sort(
          (left, right) =>
            left.clientId.localeCompare(right.clientId) ||
            left.key.localeCompare(right.key),
        );
        const batches = [
          await fixture.store.purgeAccountRecords(target, PURGE_LIMIT),
        ];
        assert.deepEqual(batches[0], {
          deletedCount: PURGE_LIMIT,
          done: false,
        });
        for (const deleted of expectedOrder.slice(0, PURGE_LIMIT)) {
          assert.equal(
            await fixture.store.getStorageRecord(
              deleted.userId,
              deleted.clientId,
              deleted.key,
            ),
            null,
          );
        }
        const firstRemaining = expectedOrder[PURGE_LIMIT]!;
        assert.ok(
          await fixture.store.getStorageRecord(
            firstRemaining.userId,
            firstRemaining.clientId,
            firstRemaining.key,
          ),
        );

        while (!batches.at(-1)!.done) {
          assert.ok(batches.length < 20);
          batches.push(
            await fixture.store.purgeAccountRecords(target, PURGE_LIMIT),
          );
        }
        assert.equal(
          batches.reduce((total, batch) => total + batch.deletedCount, 0),
          TARGET_RECORD_COUNT,
        );
        assert.ok(batches.every((batch) => batch.deletedCount <= PURGE_LIMIT));
        assert.deepEqual(batches.at(-1), { deletedCount: 15, done: true });
        assert.deepEqual(
          await fixture.store.purgeAccountRecords(target, PURGE_LIMIT),
          { deletedCount: 0, done: true },
        );
        assert.deepEqual(await fixture.ownedRecordAccounting(target), {
          itemCount: 0,
          byteCount: 0,
        });

        for (const record of targetRecords) {
          assert.equal(
            await fixture.store.getStorageRecord(
              record.userId,
              record.clientId,
              record.key,
            ),
            null,
          );
        }
        for (let index = 0; index < 7; index += 1) {
          assert.ok(
            await fixture.store.getStorageRecord(
              other,
              clients[0]!.id,
              `other-${index}`,
            ),
          );
        }

        assert.deepEqual(
          await fixture.store.getStorageUsage(target, clients[0]!.id),
          { itemCount: 1, byteCount: 11 },
        );
        assert.deepEqual(
          await fixture.store.getStorageUsage(target, clients[1]!.id),
          { itemCount: 1, byteCount: 13 },
        );
        assert.deepEqual(
          await fixture.store.getStorageUsage(target, clients[2]!.id),
          { itemCount: 0, byteCount: 0 },
        );
        assert.equal(
          await fixture.store.upsertStorageRecord(capacityProbe, cappedLimits),
          true,
        );
        await fixture.store.deleteStorageRecord(
          capacityProbe.userId,
          capacityProbe.clientId,
          capacityProbe.key,
        );
        assert.deepEqual(await fixture.snapshotUnrelated(), unrelatedBefore);
        assert.ok(await fixture.store.getUser(target));
        assert.equal(
          (await fixture.store.getAccountDeletionJob(target))?.state,
          "pending",
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("D1 and memory converge after an exact batch multiple and reject unsafe bounds", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const subject = await createSubject(fixture.store, adapter.name, 20);
        const otherSubject = await createSubject(
          fixture.store,
          adapter.name,
          21,
        );
        const [client] = await createClients(
          fixture.store,
          `${adapter.name}-bounds`,
          1,
        );
        for (let index = 0; index < 4; index += 1) {
          assert.equal(
            await fixture.store.upsertStorageRecord(
              storageRecord(subject, client!.id, `exact-${index}`, index),
              OPEN_LIMITS,
            ),
            true,
          );
        }
        await fixture.store.startAccountDeletionJob(otherSubject, 40);

        await assert.rejects(
          fixture.store.purgeAccountRecords(subject, 2),
          /account_record_purge_unavailable/,
        );
        assert.ok(
          await fixture.store.getStorageRecord(subject, client!.id, "exact-0"),
        );
        await fixture.store.startAccountDeletionJob(subject, 50);
        const claims = await fixture.store.claimAccountDeletionJobs(50, 30, 2);
        const claim = claims.find((candidate) => candidate.subject === subject);
        assert.ok(claim);
        assert.deepEqual(await fixture.store.purgeAccountRecords(subject, 2), {
          deletedCount: 2,
          done: false,
        });
        assert.deepEqual(await fixture.store.purgeAccountRecords(subject, 2), {
          deletedCount: 2,
          done: false,
        });
        assert.deepEqual(await fixture.store.purgeAccountRecords(subject, 2), {
          deletedCount: 0,
          done: true,
        });
        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            subject,
            claim.attempt,
            51,
          ),
          true,
        );
        assert.equal(await fixture.store.getUser(subject), null);
        await assert.rejects(
          fixture.store.purgeAccountRecords(
            "00000000-0000-4000-8000-000000000000",
            2,
          ),
          /account_record_purge_unavailable/,
        );

        await assert.rejects(
          fixture.store.purgeAccountRecords(subject, 0),
          /account_record_purge_limit_invalid/,
        );
        await assert.rejects(
          fixture.store.purgeAccountRecords(
            subject,
            ACCOUNT_RECORD_PURGE_MAX_BATCH + 1,
          ),
          /account_record_purge_limit_invalid/,
        );
        await assert.rejects(
          fixture.store.purgeAccountRecords("", 1),
          /account_record_purge_subject_invalid/,
        );
        await assert.rejects(
          fixture.store.purgeAccountRecords("x".repeat(129), 1),
          /account_record_purge_subject_invalid/,
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("D1 account record purge rolls back a failed batch and resumes safely", async () => {
  const sqlite = await migratedDatabase();
  const store = new D1AuthStore(sqliteD1(sqlite));
  try {
    const subject = await createSubject(store, "d1-failure", 1);
    const [client] = await createClients(store, "d1-failure", 1);
    for (const key of ["a", "b", "c"]) {
      assert.equal(
        await store.upsertStorageRecord(
          storageRecord(subject, client!.id, key, 1),
          OPEN_LIMITS,
        ),
        true,
      );
    }
    await store.startAccountDeletionJob(subject, 10);
    sqlite.exec(
      "CREATE TRIGGER fail_account_record_purge BEFORE DELETE ON storage_records WHEN OLD.key = 'b' BEGIN SELECT RAISE(ABORT, 'injected_record_purge_failure'); END",
    );

    await assert.rejects(
      store.purgeAccountRecords(subject, 3),
      /injected_record_purge_failure/,
    );
    for (const key of ["a", "b", "c"]) {
      assert.ok(await store.getStorageRecord(subject, client!.id, key));
    }

    sqlite.exec("DROP TRIGGER fail_account_record_purge");
    assert.deepEqual(await store.purgeAccountRecords(subject, 3), {
      deletedCount: 3,
      done: false,
    });
    assert.deepEqual(await store.purgeAccountRecords(subject, 3), {
      deletedCount: 0,
      done: true,
    });
  } finally {
    sqlite.close();
  }
});

test("D1 account record purge fails closed on an unsuccessful adapter result", async () => {
  const statement: D1PreparedStatement = {
    bind: () => statement,
    first: async <T>() =>
      ({
        subject: "00000000-0000-4000-8000-000000000001",
        state: "pending",
        attempt: 0,
        available_at: 1,
        created_at: 1,
        updated_at: 1,
        completed_at: null,
      }) as T,
    all: async () => ({ success: false }),
    run: async () => ({ success: false }),
  };
  const store = new D1AuthStore({ prepare: () => statement });
  await assert.rejects(
    store.purgeAccountRecords("00000000-0000-4000-8000-000000000001", 1),
    /account_record_purge_failed/,
  );
});

interface StoreFixture {
  store: AuthStore;
  close: () => void;
  snapshotUnrelated: () => Promise<Record<string, number>>;
  ownedRecordAccounting: (
    subject: string,
  ) => Promise<{ itemCount: number; byteCount: number }>;
}

function adapters(): Array<{
  name: string;
  create: () => Promise<StoreFixture>;
}> {
  return [
    {
      name: "memory",
      create: async () => {
        const store = new MemoryAuthStore();
        return {
          store,
          close: () => undefined,
          snapshotUnrelated: async () => ({
            users: store.users.size,
            clients: store.clients.size,
            devices: store.devices.size,
            authRequests: store.authRequests.size,
            authCodes: store.authCodes.size,
            consents: store.consents.size,
            families: store.families.size,
            refreshTokens: store.refreshTokens.size,
            revokedJtis: store.revokedJtis.size,
            deletionJobs: store.accountDeletionJobs.size,
            files: store.storageFiles.size,
            repairs: store.storageFileOrphanRepairs.size,
            counters: store.counters.size,
            adminSubmissions: store.adminOperationSubmissions.size,
            audits: store.audits.length,
            otherRecords: Array.from(store.storageRecords.values()).filter(
              (record) => !record.key.startsWith("target-"),
            ).length,
          }),
          ownedRecordAccounting: async (subject) => {
            const records = Array.from(store.storageRecords.values()).filter(
              (record) => record.userId === subject,
            );
            return {
              itemCount: records.length,
              byteCount: records.reduce(
                (total, record) => total + Buffer.byteLength(record.valueJson),
                0,
              ),
            };
          },
        };
      },
    },
    {
      name: "d1",
      create: async () => {
        const sqlite = await migratedDatabase();
        return {
          store: new D1AuthStore(sqliteD1(sqlite)),
          close: () => sqlite.close(),
          snapshotUnrelated: async () =>
            Object.fromEntries(
              schemaTables
                .filter((table) => table !== "storage_records")
                .map((table) => [
                  table,
                  Number(
                    sqlite
                      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
                      .get()?.count ?? 0,
                  ),
                ]),
            ),
          ownedRecordAccounting: async (subject) => {
            const row = sqlite
              .prepare(
                "SELECT COUNT(*) AS item_count, COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) AS byte_count FROM storage_records WHERE user_id = ?",
              )
              .get(subject);
            return {
              itemCount: Number(row?.item_count ?? 0),
              byteCount: Number(row?.byte_count ?? 0),
            };
          },
        };
      },
    },
  ];
}

async function createSubject(
  store: AuthStore,
  adapter: string,
  index: number,
): Promise<string> {
  return (
    await store.findOrCreateUser(
      {
        email: `${adapter}-${index}@example.test`,
        fullName: null,
        displayName: `User ${index}`,
      },
      index,
    )
  ).id;
}

async function createClients(
  store: AuthStore,
  adapter: string,
  count = 3,
): Promise<ClientView[]> {
  const clients: ClientView[] = [];
  for (let index = 0; index < count; index += 1) {
    clients.push(
      await store.createClient(
        {
          type: "public",
          name: `${adapter} client ${index}`,
          redirectUris: [],
          scopes: ["storage.read", "storage.write", "storage.delete"],
          origins: [],
        },
        null,
        100 + index,
      ),
    );
  }
  return clients;
}

function storageRecord(
  userId: string,
  clientId: string,
  key: string,
  index: number,
): StorageRecord {
  return {
    userId,
    clientId,
    key,
    valueJson: JSON.stringify({ index, payload: "x".repeat(index % 17) }),
    createdAt: 200 + index,
    updatedAt: 200 + index,
  };
}

async function addFile(
  store: AuthStore,
  userId: string,
  clientId: string,
  key: string,
  size: number,
): Promise<void> {
  assert.equal(
    await store.upsertStorageFileMetadata(
      {
        userId,
        clientId,
        key,
        r2Key: `r2-${key}`,
        contentType: "application/octet-stream",
        size,
        sha256: "0".repeat(64),
        createdAt: 400,
        updatedAt: 400,
      },
      null,
      OPEN_LIMITS,
    ),
    true,
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
