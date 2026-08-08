import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import {
  ACCOUNT_FILE_PURGE_BATCH_SIZE,
  purgeAccountFilesBatch,
} from "../../src/account-file-purge";
import { createClientRegistration } from "../../src/oauth";
import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  AuthStore,
  ClientView,
  StorageFileMetadata,
  StorageFileOrphanRepair,
  StorageLimits,
} from "../../src/types";
import { MemoryR2Bucket } from "../helpers";

const LARGE_FIXTURE_COUNT = ACCOUNT_FILE_PURGE_BATCH_SIZE * 2 + 7;
const OPEN_LIMITS: StorageLimits = {
  writesEnabled: true,
  globalMaxItems: 10_000,
  globalMaxBytes: 10_000_000,
  userMaxItems: 10_000,
  userMaxBytes: 10_000_000,
  namespaceMaxItems: 10_000,
  namespaceMaxBytes: 10_000_000,
};

class FaultBucket extends MemoryR2Bucket {
  deleteFailures = 0;
  deleteCalls = 0;

  override async delete(key: string): Promise<void> {
    this.deleteCalls += 1;
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1;
      throw new Error("injected_object_delete_failure");
    }
    await super.delete(key);
  }
}

class FaultMemoryStore extends MemoryAuthStore {
  completionFailures = 0;

  override async completeStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
  ): Promise<boolean> {
    if (this.completionFailures > 0) {
      this.completionFailures -= 1;
      throw new Error("injected_repair_completion_failure");
    }
    return super.completeStorageFileOrphanRepair(repair);
  }
}

test("bounded account file purge converges across client namespaces and preserves other subjects", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const clients = await createClients(fixture.store, adapter.name, 3);
        const target = await createSubject(
          fixture.store,
          `${adapter.name}-file-target`,
          1,
        );
        const control = await createSubject(
          fixture.store,
          `${adapter.name}-file-control`,
          2,
        );
        const targetFiles: StorageFileMetadata[] = [];
        const controlFiles: StorageFileMetadata[] = [];

        for (let index = 0; index < LARGE_FIXTURE_COUNT; index += 1) {
          const file = metadata(
            target,
            clients[index % clients.length]!.id,
            `target-${String(index).padStart(3, "0")}`,
            `physical/target-${String(index).padStart(3, "0")}`,
            index + 1,
          );
          targetFiles.push(file);
          await seedFile(fixture.store, fixture.bucket, file);
        }
        for (let index = 0; index < 5; index += 1) {
          const file = metadata(
            control,
            clients[index % clients.length]!.id,
            `control-${index}`,
            `physical/control-${index}`,
            10 + index,
          );
          controlFiles.push(file);
          await seedFile(fixture.store, fixture.bucket, file);
        }

        const sortedTarget = [...targetFiles].sort(
          (left, right) =>
            left.clientId.localeCompare(right.clientId) ||
            left.key.localeCompare(right.key) ||
            left.r2Key.localeCompare(right.r2Key),
        );
        const itemCeiling = targetFiles.length + controlFiles.length;
        const overCeiling = metadata(
          control,
          clients[0]!.id,
          "accounting-sentinel",
          "physical/accounting-sentinel",
          1,
        );
        assert.equal(
          await fixture.store.upsertStorageFileMetadata(overCeiling, null, {
            ...OPEN_LIMITS,
            globalMaxItems: itemCeiling,
          }),
          false,
        );

        await fixture.store.startAccountDeletionJob(target, 100);
        const [claim] = await fixture.store.claimAccountDeletionJobs(
          100,
          300,
          1,
        );
        assert.ok(claim);
        const first = await purgeAccountFilesBatch(
          fixture.store,
          fixture.bucket,
          target,
          claim.attempt,
          101,
        );
        assert.equal(first.staged, ACCOUNT_FILE_PURGE_BATCH_SIZE);
        assert.equal(first.examined, ACCOUNT_FILE_PURGE_BATCH_SIZE);
        assert.equal(first.resolved, ACCOUNT_FILE_PURGE_BATCH_SIZE);
        assert.equal(first.deferred, 0);
        assert.equal(first.complete, false);
        assert.equal(
          JSON.stringify(first).includes(sortedTarget[0]!.r2Key),
          false,
        );
        for (const file of sortedTarget.slice(
          0,
          ACCOUNT_FILE_PURGE_BATCH_SIZE,
        )) {
          assert.equal(
            await fixture.store.getStorageFileMetadata(
              file.userId,
              file.clientId,
              file.key,
            ),
            null,
          );
        }
        assert.ok(
          await fixture.store.getStorageFileMetadata(
            sortedTarget[ACCOUNT_FILE_PURGE_BATCH_SIZE]!.userId,
            sortedTarget[ACCOUNT_FILE_PURGE_BATCH_SIZE]!.clientId,
            sortedTarget[ACCOUNT_FILE_PURGE_BATCH_SIZE]!.key,
          ),
        );

        let result = first;
        let calls = 1;
        while (!result.complete) {
          result = await purgeAccountFilesBatch(
            fixture.store,
            fixture.bucket,
            target,
            claim.attempt,
            101 + calls,
          );
          assert.ok(result.staged <= ACCOUNT_FILE_PURGE_BATCH_SIZE);
          assert.ok(result.examined <= ACCOUNT_FILE_PURGE_BATCH_SIZE);
          calls += 1;
          assert.ok(calls < 10);
        }
        assert.equal(calls, 3);
        assert.equal(
          await fixture.store.hasStorageFilesForSubject(target),
          false,
        );
        assert.equal(
          await fixture.store.hasStorageFileOrphanRepairsForSubject(target),
          false,
        );
        for (const file of targetFiles) {
          assert.equal(await fixture.bucket.get(file.r2Key), null);
          assert.deepEqual(
            await fixture.store.getStorageUsage(file.userId, file.clientId),
            { itemCount: 0, byteCount: 0 },
          );
        }
        for (const file of controlFiles) {
          assert.ok(
            await fixture.store.getStorageFileMetadata(
              file.userId,
              file.clientId,
              file.key,
            ),
          );
          assert.ok(await fixture.bucket.get(file.r2Key));
        }
        assert.equal(
          await fixture.store.upsertStorageFileMetadata(overCeiling, null, {
            ...OPEN_LIMITS,
            globalMaxItems: itemCeiling,
          }),
          true,
        );
        await fixture.bucket.put(overCeiling.r2Key, "x");

        assert.deepEqual(
          await purgeAccountFilesBatch(
            fixture.store,
            fixture.bucket,
            target,
            claim.attempt,
            110,
          ),
          {
            staged: 0,
            examined: 0,
            resolved: 0,
            deferred: 0,
            complete: true,
          },
        );
        assert.equal(
          await fixture.store.completeAccountDeletionJob(
            target,
            claim.attempt,
            111,
          ),
          true,
        );
        assert.deepEqual(
          await purgeAccountFilesBatch(
            fixture.store,
            fixture.bucket,
            target,
            claim.attempt,
            112,
          ),
          {
            staged: 0,
            examined: 0,
            resolved: 0,
            deferred: 0,
            complete: true,
          },
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("a globally referenced object survives one subject's purge", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const [client] = await createClients(
          fixture.store,
          `${adapter.name}-shared`,
          1,
        );
        const target = await createSubject(
          fixture.store,
          `${adapter.name}-shared-target`,
          10,
        );
        const control = await createSubject(
          fixture.store,
          `${adapter.name}-shared-control`,
          11,
        );
        const physicalKey = "physical/shared-reference";
        const targetFile = metadata(
          target,
          client!.id,
          "target-shared",
          physicalKey,
          8,
        );
        const controlFile = metadata(
          control,
          client!.id,
          "control-shared",
          physicalKey,
          8,
        );
        await seedFile(fixture.store, fixture.bucket, targetFile);
        assert.equal(
          await fixture.store.upsertStorageFileMetadata(
            controlFile,
            null,
            OPEN_LIMITS,
          ),
          true,
        );
        await fixture.store.startAccountDeletionJob(target, 20);
        const [claim] = await fixture.store.claimAccountDeletionJobs(20, 30, 1);
        assert.ok(claim);

        const result = await purgeAccountFilesBatch(
          fixture.store,
          fixture.bucket,
          target,
          claim.attempt,
          21,
        );
        assert.equal(result.complete, true);
        assert.equal(result.resolved, 1);
        assert.equal((await fixture.bucket.get(physicalKey)) !== null, true);
        assert.ok(
          await fixture.store.getStorageFileMetadata(
            control,
            client!.id,
            controlFile.key,
          ),
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("missing account-deletion state rejects before D1 or R2 mutation", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const [client] = await createClients(
          fixture.store,
          `${adapter.name}-missing-job`,
          1,
        );
        const subject = await createSubject(
          fixture.store,
          `${adapter.name}-missing-job`,
          20,
        );
        const file = metadata(
          subject,
          client!.id,
          "protected",
          "physical/protected",
          4,
        );
        await seedFile(fixture.store, fixture.bucket, file);

        await assert.rejects(
          purgeAccountFilesBatch(fixture.store, fixture.bucket, subject, 1, 30),
          /account_file_purge_job_required/,
        );
        assert.ok(
          await fixture.store.getStorageFileMetadata(
            subject,
            client!.id,
            file.key,
          ),
        );
        assert.ok(await fixture.bucket.get(file.r2Key));
        assert.equal(fixture.bucket.deleteCalls, 0);
        assert.equal(
          (
            await fixture.store.listStorageFileOrphanRepairsForSubject(
              subject,
              2,
            )
          ).length,
          0,
        );
        assert.deepEqual(
          await fixture.store.stageAccountFilePurgeBatch(subject, 1, 30, 1),
          { selected: 0, staged: 0 },
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("stale claims and dirty completed tombstones fail before file mutation", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const [client] = await createClients(
          fixture.store,
          `${adapter.name}-claim-guard`,
          1,
        );
        const subject = await createSubject(
          fixture.store,
          `${adapter.name}-claim-guard`,
          25,
        );
        const file = metadata(
          subject,
          client!.id,
          "claim-protected",
          "physical/claim-protected",
          5,
        );
        await seedFile(fixture.store, fixture.bucket, file);
        await fixture.store.startAccountDeletionJob(subject, 30);
        const [claim] = await fixture.store.claimAccountDeletionJobs(30, 30, 1);
        assert.ok(claim);

        await assert.rejects(
          purgeAccountFilesBatch(
            fixture.store,
            fixture.bucket,
            subject,
            claim.attempt + 1,
            31,
          ),
          /account_file_purge_lease_invalid/,
        );
        await assert.rejects(
          purgeAccountFilesBatch(
            fixture.store,
            fixture.bucket,
            subject,
            claim.attempt,
            60,
          ),
          /account_file_purge_lease_invalid/,
        );
        assert.equal(
          await fixture.store.completeAccountDeletionJob(
            subject,
            claim.attempt,
            32,
          ),
          true,
        );
        await assert.rejects(
          purgeAccountFilesBatch(
            fixture.store,
            fixture.bucket,
            subject,
            claim.attempt,
            33,
          ),
          /account_file_purge_failed/,
        );
        assert.ok(
          await fixture.store.getStorageFileMetadata(
            subject,
            client!.id,
            file.key,
          ),
        );
        assert.ok(await fixture.bucket.get(file.r2Key));
        assert.equal(fixture.bucket.deleteCalls, 0);
      } finally {
        fixture.close();
      }
    });
  }
});

test("R2 and repair-completion failures remain queued and converge without key disclosure", async () => {
  const store = new FaultMemoryStore();
  const bucket = new FaultBucket();
  const [client] = await createClients(store, "repair-failure", 1);
  const subject = await createSubject(store, "repair-failure", 30);
  const file = metadata(
    subject,
    client!.id,
    "retryable",
    "physical/private-retry-key",
    9,
  );
  await seedFile(store, bucket, file);
  await store.startAccountDeletionJob(subject, 40);
  const [claim] = await store.claimAccountDeletionJobs(40, 100, 1);
  assert.ok(claim);

  bucket.deleteFailures = 1;
  const r2Failure = await purgeAccountFilesBatch(
    store,
    bucket,
    subject,
    claim.attempt,
    41,
  );
  assert.deepEqual(r2Failure, {
    staged: 1,
    examined: 1,
    resolved: 0,
    deferred: 1,
    complete: false,
  });
  assert.equal(JSON.stringify(r2Failure).includes(file.r2Key), false);
  assert.equal(
    await store.getStorageFileMetadata(subject, client!.id, file.key),
    null,
  );
  assert.ok(await bucket.get(file.r2Key));
  assert.deepEqual(await store.getStorageUsage(subject, client!.id), {
    itemCount: 0,
    byteCount: 0,
  });

  store.completionFailures = 1;
  const d1CompletionFailure = await purgeAccountFilesBatch(
    store,
    bucket,
    subject,
    claim.attempt,
    42,
  );
  assert.equal(d1CompletionFailure.deferred, 1);
  assert.equal(d1CompletionFailure.complete, false);
  assert.equal(await bucket.get(file.r2Key), null);
  assert.equal(
    (await store.listStorageFileOrphanRepairsForSubject(subject, 2)).length,
    1,
  );

  assert.deepEqual(
    await purgeAccountFilesBatch(store, bucket, subject, claim.attempt, 43),
    {
      staged: 0,
      examined: 1,
      resolved: 1,
      deferred: 0,
      complete: true,
    },
  );
});

test("transactional D1 staging rolls back and uncertain completion resumes safely", async () => {
  const sqlite = await migratedDatabase();
  const faults: BatchFaults = {};
  const store = new D1AuthStore(sqliteD1(sqlite, faults));
  const bucket = new FaultBucket();
  try {
    const [client] = await createClients(store, "d1-transaction", 1);
    const subject = await createSubject(store, "d1-transaction", 40);
    const file = metadata(
      subject,
      client!.id,
      "transactional",
      "physical/transactional-private",
      12,
    );
    await seedFile(store, bucket, file);
    await store.startAccountDeletionJob(subject, 50);
    const [claim] = await store.claimAccountDeletionJobs(50, 100, 1);
    assert.ok(claim);

    faults.failBeforeStatement = 1;
    await assert.rejects(
      purgeAccountFilesBatch(store, bucket, subject, claim.attempt, 51),
      /account_file_purge_failed/,
    );
    assert.ok(
      await store.getStorageFileMetadata(subject, client!.id, file.key),
    );
    assert.equal(
      (await store.listStorageFileOrphanRepairsForSubject(subject, 2)).length,
      0,
    );
    assert.ok(await bucket.get(file.r2Key));

    faults.failAfterCommit = true;
    await assert.rejects(
      purgeAccountFilesBatch(store, bucket, subject, claim.attempt, 52),
      /account_file_purge_failed/,
    );
    assert.equal(
      await store.getStorageFileMetadata(subject, client!.id, file.key),
      null,
    );
    assert.equal(
      (await store.listStorageFileOrphanRepairsForSubject(subject, 2)).length,
      1,
    );
    assert.ok(await bucket.get(file.r2Key));

    assert.deepEqual(
      await purgeAccountFilesBatch(store, bucket, subject, claim.attempt, 53),
      {
        staged: 0,
        examined: 1,
        resolved: 1,
        deferred: 0,
        complete: true,
      },
    );
    assert.equal(await bucket.get(file.r2Key), null);
    assert.deepEqual(await store.getStorageUsage(subject, client!.id), {
      itemCount: 0,
      byteCount: 0,
    });
  } finally {
    sqlite.close();
  }
});

test("account file purge remains internal and its failure model is documented", async () => {
  const [architecture, threatModel, privacy, selfHosting, openapi] =
    await Promise.all([
      readFile(new URL("../../docs/architecture.md", import.meta.url), "utf8"),
      readFile(new URL("../../docs/threat-model.md", import.meta.url), "utf8"),
      readFile(new URL("../../docs/privacy.md", import.meta.url), "utf8"),
      readFile(new URL("../../docs/self-hosting.md", import.meta.url), "utf8"),
      readFile(new URL("../../src/openapi.ts", import.meta.url), "utf8"),
    ]);
  assert.match(architecture, /account file purge/i);
  assert.match(architecture, /transactional D1 batch/i);
  assert.match(threatModel, /account file purge/i);
  assert.match(privacy, /bounded internal file purge/i);
  assert.match(selfHosting, /transactional batch/i);
  assert.doesNotMatch(openapi, /account[-_ ]file[-_ ]purge/i);
});

interface AdapterFixture {
  store: AuthStore;
  bucket: FaultBucket;
  close: () => void;
}

function adapters(): Array<{
  name: string;
  create: () => Promise<AdapterFixture>;
}> {
  return [
    {
      name: "memory",
      create: async () => ({
        store: new MemoryAuthStore(),
        bucket: new FaultBucket(),
        close: () => undefined,
      }),
    },
    {
      name: "d1",
      create: async () => {
        const sqlite = await migratedDatabase();
        return {
          store: new D1AuthStore(sqliteD1(sqlite)),
          bucket: new FaultBucket(),
          close: () => sqlite.close(),
        };
      },
    },
  ];
}

async function createSubject(
  store: AuthStore,
  prefix: string,
  index: number,
): Promise<string> {
  return (
    await store.findOrCreateUser(
      {
        email: `${prefix}-${index}@example.test`,
        fullName: null,
        displayName: `Subject ${index}`,
      },
      index,
    )
  ).id;
}

async function createClients(
  store: AuthStore,
  prefix: string,
  count: number,
): Promise<ClientView[]> {
  const clients: ClientView[] = [];
  for (let index = 0; index < count; index += 1) {
    clients.push(
      (
        await createClientRegistration(
          {
            type: "public",
            name: `${prefix} client ${index}`,
            redirectUris: [`https://${prefix}-${index}.example.test/callback`],
            scopes: ["storage.read", "storage.write", "storage.delete"],
            origins: [],
          },
          store,
          index + 1,
        )
      ).client,
    );
  }
  return clients;
}

function metadata(
  userId: string,
  clientId: string,
  key: string,
  r2Key: string,
  size: number,
): StorageFileMetadata {
  return {
    userId,
    clientId,
    key,
    r2Key,
    contentType: "application/octet-stream",
    size,
    sha256: key.padEnd(43, "x").slice(0, 43),
    createdAt: 1,
    updatedAt: 1,
  };
}

async function seedFile(
  store: AuthStore,
  bucket: FaultBucket,
  file: StorageFileMetadata,
): Promise<void> {
  assert.equal(
    await store.upsertStorageFileMetadata(file, null, OPEN_LIMITS),
    true,
  );
  await bucket.put(file.r2Key, new Uint8Array(file.size));
}

interface BatchFaults {
  failBeforeStatement?: number;
  failAfterCommit?: boolean;
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

function sqliteD1(
  database: DatabaseSync,
  faults: BatchFaults = {},
): D1Database {
  const prepared = new WeakMap<
    D1PreparedStatement,
    { query: string; values: SQLInputValue[] }
  >();
  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      const execution = { query, values: [] as SQLInputValue[] };
      const statement: D1PreparedStatement = {
        bind(...values: unknown[]): D1PreparedStatement {
          execution.values = values as SQLInputValue[];
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
      let committed = false;
      try {
        const results: D1Result<T>[] = [];
        for (let index = 0; index < statements.length; index += 1) {
          if (faults.failBeforeStatement === index) {
            faults.failBeforeStatement = undefined;
            throw new Error("injected_d1_batch_failure");
          }
          const execution = prepared.get(statements[index]!);
          assert.ok(execution);
          const result = database
            .prepare(execution.query)
            .run(...execution.values);
          results.push({
            success: true,
            meta: { changes: Number(result.changes) },
          });
        }
        database.exec("COMMIT");
        committed = true;
        if (faults.failAfterCommit) {
          faults.failAfterCommit = false;
          throw new Error("injected_d1_uncertain_result");
        }
        return results;
      } catch (error) {
        if (!committed) database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return db;
}
