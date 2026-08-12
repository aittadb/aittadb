import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import type {
  BoundedRecordMutation,
  BoundedRecordTransactionCommand,
} from "../../src/bounded-record-protocol";
import { parseBoundedStorageTransactionResult } from "../../src/bounded-record-transaction";
import { sha256 } from "../../src/crypto";
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

test("bounded transactions atomically preserve order and durable idempotency", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(fixture.store, `${adapter.name}-tx`);
        const client = await createClient(fixture.store, `${adapter.name}-tx`);
        await fixture.seed(record(owner, client.id, "items", "old", 3));
        await fixture.seed(record(owner, client.id, "items", "checked", 3));
        await fixture.seed(record(owner, client.id, "items", "gone", 2));
        const tx = command("mixed-operation", [
          put("items", "new", null, { state: "created", rank: 1 }),
          check("items", "checked", 3),
          remove("items", "gone", 2),
          put("items", "old", 3, { state: "replaced", rank: 2 }),
        ]);

        const created = await fixture.store.transactBoundedStorageRecords(
          owner,
          client.id,
          tx,
          OPEN_LIMITS,
          100,
        );
        assert.equal(created.status, "created");
        if (created.status !== "created") return;
        assert.deepEqual(created.records, [
          protocolRecord("items", "new", 1, { state: "created", rank: 1 }),
          protocolRecord("items", "checked", 3, {
            id: "checked",
            revision: 3,
          }),
          null,
          protocolRecord("items", "old", 4, { state: "replaced", rank: 2 }),
        ]);
        assert.equal(
          await fixture.store.getBoundedStorageRecord(
            owner,
            client.id,
            "items",
            "gone",
          ),
          null,
        );

        const canonicalRetry = command("mixed-operation", [
          put("items", "new", null, { rank: 1, state: "created" }),
          check("items", "checked", 3),
          remove("items", "gone", 2),
          put("items", "old", 3, { rank: 2, state: "replaced" }),
        ]);
        const replayed = await fixture
          .reconstruct()
          .transactBoundedStorageRecords(
            owner,
            client.id,
            canonicalRetry,
            OPEN_LIMITS,
            101,
          );
        assert.deepEqual(replayed, {
          status: "replayed",
          records: created.records,
        });
        assert.deepEqual(
          await fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            command("mixed-operation", [check("items", "old", 4)]),
            OPEN_LIMITS,
            102,
          ),
          { status: "conflict" },
        );
        assert.equal(await fixture.receiptCount(owner), 1);
        assert.equal(
          await fixture.hasPlaintextOperationId("mixed-operation"),
          false,
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("persisted transaction results fail closed on malformed semantics", () => {
  const tx = command("malformed-result", [
    put("items", "record", null, { accepted: true }),
  ]);
  assert.throws(
    () => parseBoundedStorageTransactionResult("[null]", tx),
    /bounded_storage_transaction_result_invalid/,
  );
  assert.throws(
    () =>
      parseBoundedStorageTransactionResult(
        JSON.stringify([
          {
            key: { collection: "items", id: "record" },
            revision: 2,
            value: { accepted: true },
          },
        ]),
        tx,
      ),
    /bounded_storage_transaction_result_invalid/,
  );
  assert.throws(
    () =>
      parseBoundedStorageTransactionResult(
        JSON.stringify([
          {
            key: { collection: "items", id: "record" },
            revision: 1,
            value: { accepted: true },
            internal: "not-accepted",
          },
        ]),
        tx,
      ),
    /bounded_storage_transaction_result_invalid/,
  );
});

test("bounded transactions reject stale state and roll quota failure back without receipts", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(
          fixture.store,
          `${adapter.name}-failure`,
        );
        const client = await createClient(
          fixture.store,
          `${adapter.name}-failure`,
        );
        await fixture.seed(record(owner, client.id, "items", "existing", 2));

        assert.deepEqual(
          await fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            command("create-conflict", [
              put("items", "existing", null, { rejected: true }),
            ]),
            OPEN_LIMITS,
            20,
          ),
          { status: "conflict" },
        );
        assert.deepEqual(
          await fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            command("stale", [
              put("items", "existing", 1, { rejected: true }),
              put("items", "would-leak", null, { rejected: true }),
            ]),
            OPEN_LIMITS,
            21,
          ),
          { status: "precondition_failed" },
        );
        assert.equal(
          await fixture.store.getBoundedStorageRecord(
            owner,
            client.id,
            "items",
            "would-leak",
          ),
          null,
        );

        const oneRecord: StorageLimits = {
          ...OPEN_LIMITS,
          globalMaxItems: 1,
          userMaxItems: 1,
          namespaceMaxItems: 1,
        };
        const funded = await fixture.store.transactBoundedStorageRecords(
          owner,
          client.id,
          command("delete-funds-put", [
            remove("items", "existing", 2),
            put("items", "replacement", null, { accepted: true }),
          ]),
          oneRecord,
          22,
        );
        assert.equal(funded.status, "created");
        assert.deepEqual(
          await fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            command("quota-failure", [
              put("items", "second", null, { rejected: true }),
            ]),
            oneRecord,
            23,
          ),
          { status: "quota_exceeded" },
        );
        assert.equal(
          await fixture.store.getBoundedStorageRecord(
            owner,
            client.id,
            "items",
            "second",
          ),
          null,
        );
        assert.equal(await fixture.receiptCount(owner), 1);
      } finally {
        fixture.close();
      }
    });
  }
});

test("bounded transactions enforce active namespaces, write switch, and receipt ceilings", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(
          fixture.store,
          `${adapter.name}-auth`,
        );
        const client = await createClient(
          fixture.store,
          `${adapter.name}-auth`,
        );
        const other = await createClient(
          fixture.store,
          `${adapter.name}-other`,
        );
        const create = command("write-disabled", [
          put("items", "record", null, { private: "not-stored" }),
        ]);
        assert.deepEqual(
          await fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            create,
            { ...OPEN_LIMITS, writesEnabled: false },
            30,
          ),
          { status: "unavailable" },
        );
        await fixture.store.setClientDisabled(client.id, 31);
        assert.deepEqual(
          await fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            create,
            OPEN_LIMITS,
            31,
          ),
          { status: "unavailable" },
        );
        await fixture.store.setClientDisabled(client.id, null);

        const receiptOne: StorageLimits = {
          ...OPEN_LIMITS,
          globalMaxItems: 1,
          userMaxItems: 1,
          namespaceMaxItems: 1,
        };
        assert.equal(
          (
            await fixture.store.transactBoundedStorageRecords(
              owner,
              client.id,
              command("receipt-one", [check("items", "missing", null)]),
              receiptOne,
              32,
            )
          ).status,
          "created",
        );
        assert.deepEqual(
          await fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            command("receipt-two", [check("items", "missing", null)]),
            receiptOne,
            33,
          ),
          { status: "quota_exceeded" },
        );
        assert.equal(
          (
            await fixture.store.transactBoundedStorageRecords(
              owner,
              other.id,
              command("other-namespace", [check("items", "missing", null)]),
              OPEN_LIMITS,
              34,
            )
          ).status,
          "created",
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("concurrent exact requests have one durable winner", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(
          fixture.store,
          `${adapter.name}-concurrent`,
        );
        const client = await createClient(
          fixture.store,
          `${adapter.name}-concurrent`,
        );
        const tx = command("concurrent", [
          put("items", "record", null, { stable: true }),
        ]);
        const results = await Promise.all([
          fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            tx,
            OPEN_LIMITS,
            40,
          ),
          fixture
            .reconstruct()
            .transactBoundedStorageRecords(
              owner,
              client.id,
              tx,
              OPEN_LIMITS,
              40,
            ),
        ]);
        assert.deepEqual(results.map((result) => result.status).sort(), [
          "created",
          "replayed",
        ]);
        assert.equal(await fixture.receiptCount(owner), 1);
      } finally {
        fixture.close();
      }
    });
  }
});

test("service clients transact only in their isolated non-human namespace", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const service = await fixture.store.createClient(
          {
            type: "service",
            name: `${adapter.name}-service`,
            redirectUris: [],
            scopes: ["storage.read", "storage.write", "storage.delete"],
            origins: [],
          },
          "synthetic-secret-hash",
          1,
        );
        assert.equal(
          (
            await fixture.store.transactBoundedStorageRecords(
              service.id,
              service.id,
              command("service-write", [
                put("service-data", "record", null, { isolated: true }),
              ]),
              OPEN_LIMITS,
              45,
            )
          ).status,
          "created",
        );
        assert.ok(
          await fixture.store.getBoundedStorageRecord(
            service.id,
            service.id,
            "service-data",
            "record",
          ),
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("D1 recovers an exact result after committed response loss", async () => {
  const fixture = await createD1Fixture();
  try {
    const owner = await createSubject(fixture.store, "d1-response-loss");
    const client = await createClient(fixture.store, "d1-response-loss");
    fixture.controls.throwAfterCommit = true;
    const tx = command("response-loss", [
      put("items", "record", null, { durable: true }),
    ]);
    assert.deepEqual(
      await fixture.store.transactBoundedStorageRecords(
        owner,
        client.id,
        tx,
        OPEN_LIMITS,
        50,
      ),
      { status: "unavailable" },
    );
    assert.equal(
      (
        await fixture
          .reconstruct()
          .transactBoundedStorageRecords(owner, client.id, tx, OPEN_LIMITS, 51)
      ).status,
      "replayed",
    );
    assert.equal(await fixture.receiptCount(owner), 1);
  } finally {
    fixture.close();
  }
});

test("D1 rolls records and receipt back after an injected mutation failure", async () => {
  const fixture = await createD1Fixture();
  try {
    const owner = await createSubject(fixture.store, "d1-rollback");
    const client = await createClient(fixture.store, "d1-rollback");
    fixture.controls.failBatchIndex = 3;
    assert.deepEqual(
      await fixture.store.transactBoundedStorageRecords(
        owner,
        client.id,
        command("injected-failure", [
          put("items", "first", null, { stored: false }),
          put("items", "second", null, { stored: false }),
        ]),
        OPEN_LIMITS,
        60,
      ),
      { status: "unavailable" },
    );
    assert.equal(await fixture.receiptCount(owner), 0);
    assert.equal(
      await fixture.store.getBoundedStorageRecord(
        owner,
        client.id,
        "items",
        "first",
      ),
      null,
    );
  } finally {
    fixture.close();
  }
});

test("account deletion purges durable transaction receipts before finalization", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(
          fixture.store,
          `${adapter.name}-delete-receipt`,
        );
        const client = await createClient(
          fixture.store,
          `${adapter.name}-delete-receipt`,
        );
        assert.equal(
          (
            await fixture.store.transactBoundedStorageRecords(
              owner,
              client.id,
              command("deletion-receipt", [
                put("items", "record", null, { remove: true }),
              ]),
              OPEN_LIMITS,
              70,
            )
          ).status,
          "created",
        );
        await fixture.store.startAccountDeletionJob(owner, 71);
        const claim = (
          await fixture.store.claimAccountDeletionJobs(71, 60, 1)
        )[0];
        assert.ok(claim);
        assert.equal(
          await fixture.store.finalizeAccountDeletion(owner, claim.attempt, 72),
          false,
        );
        assert.deepEqual(await fixture.store.purgeAccountRecords(owner, 1), {
          deletedCount: 1,
          done: false,
        });
        assert.deepEqual(await fixture.store.purgeAccountRecords(owner, 1), {
          deletedCount: 1,
          done: false,
        });
        assert.deepEqual(await fixture.store.purgeAccountRecords(owner, 1), {
          deletedCount: 0,
          done: true,
        });
        assert.equal(await fixture.receiptCount(owner), 0);
      } finally {
        fixture.close();
      }
    });
  }
});

interface Fixture {
  store: AuthStore;
  seed(record: BoundedStorageRecord): Promise<void>;
  reconstruct(): AuthStore;
  receiptCount(subject: string): Promise<number>;
  hasPlaintextOperationId(operationId: string): Promise<boolean>;
  close(): void;
}

interface D1Controls {
  failBatchIndex: number | null;
  throwAfterCommit: boolean;
}

interface D1Fixture extends Fixture {
  controls: D1Controls;
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
          async seed(value) {
            store.boundedStorageRecords.set(
              JSON.stringify([
                value.userId,
                value.clientId,
                value.collection,
                value.id,
              ]),
              { ...value },
            );
          },
          reconstruct: () => store,
          async receiptCount(subject) {
            return Array.from(
              store.boundedStorageTransactionReceipts.values(),
            ).filter((receipt) => receipt.userId === subject).length;
          },
          async hasPlaintextOperationId(operationId) {
            return Array.from(
              store.boundedStorageTransactionReceipts.keys(),
            ).some((key) => key.includes(operationId));
          },
          close: () => undefined,
        };
      },
    },
    { name: "d1", create: createD1Fixture },
  ];
}

async function createD1Fixture(): Promise<D1Fixture> {
  const sqlite = await migratedDatabase();
  const controls: D1Controls = {
    failBatchIndex: null,
    throwAfterCommit: false,
  };
  const d1 = sqliteD1(sqlite, controls);
  return {
    store: new D1AuthStore(d1),
    controls,
    async seed(value) {
      sqlite
        .prepare(
          "INSERT INTO bounded_storage_records (user_id, client_id, collection, record_id, value_json, value_bytes, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          value.userId,
          value.clientId,
          value.collection,
          value.id,
          value.valueJson,
          value.valueBytes,
          value.revision,
          value.createdAt,
          value.updatedAt,
        );
    },
    reconstruct: () => new D1AuthStore(d1),
    async receiptCount(subject) {
      return Number(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM bounded_storage_transaction_receipts WHERE user_id = ?",
          )
          .get(subject)?.count ?? 0,
      );
    },
    async hasPlaintextOperationId(operationId) {
      const hash = await sha256(operationId);
      const rows = sqlite
        .prepare(
          "SELECT operation_id_hash, request_hash, attempt_hash FROM bounded_storage_transaction_receipts",
        )
        .all();
      return rows.some(
        (row) =>
          row.operation_id_hash === operationId ||
          row.request_hash === operationId ||
          row.attempt_hash === operationId ||
          row.operation_id_hash !== hash,
      );
    },
    close: () => sqlite.close(),
  };
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

function command(
  operationId: string,
  mutations: readonly BoundedRecordMutation[],
): BoundedRecordTransactionCommand {
  return { transaction: { operation_id: operationId, mutations } };
}

function put(
  collection: string,
  id: string,
  expectedRevision: number | null,
  value: Record<string, string | number | boolean>,
): BoundedRecordMutation {
  return {
    type: "put",
    key: { collection, id },
    expected_revision: expectedRevision,
    value,
  };
}

function remove(
  collection: string,
  id: string,
  expectedRevision: number,
): BoundedRecordMutation {
  return {
    type: "delete",
    key: { collection, id },
    expected_revision: expectedRevision,
  };
}

function check(
  collection: string,
  id: string,
  expectedRevision: number | null,
): BoundedRecordMutation {
  return {
    type: "check",
    key: { collection, id },
    expected_revision: expectedRevision,
  };
}

function protocolRecord(
  collection: string,
  id: string,
  revision: number,
  value: Record<string, string | number | boolean>,
) {
  return { key: { collection, id }, revision, value };
}

function record(
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

async function migratedDatabase(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrationUrl = new URL("../../db/migrations/", import.meta.url);
  const names = (await readdir(migrationUrl))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of names) {
    sqlite.exec(await readFile(new URL(name, migrationUrl), "utf8"));
  }
  return sqlite;
}

function sqliteD1(database: DatabaseSync, controls: D1Controls): D1Database {
  const prepared = new WeakMap<
    D1PreparedStatement,
    { query: string; values: SQLInputValue[] }
  >();
  return {
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
      try {
        const results = statements.map((statement, index) => {
          if (controls.failBatchIndex === index) {
            controls.failBatchIndex = null;
            throw new Error("injected_batch_failure");
          }
          const execution = prepared.get(statement);
          assert.ok(execution);
          const sqliteStatement = database.prepare(execution.query);
          if (sqliteStatement.columns().length > 0) {
            return {
              success: true,
              results: sqliteStatement.all(...execution.values) as T[],
              meta: { changes: 0 },
            } as D1Result<T>;
          }
          const result = sqliteStatement.run(...execution.values);
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          } as D1Result<T>;
        });
        database.exec("COMMIT");
        if (controls.throwAfterCommit) {
          controls.throwAfterCommit = false;
          throw new Error("injected_response_loss");
        }
        return results;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
