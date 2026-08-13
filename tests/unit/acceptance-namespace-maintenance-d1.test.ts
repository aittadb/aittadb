import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { sha256 } from "../../src/crypto";
import { D1AuthStore } from "../../src/store/d1";

const PREFIX = "proof-0123456789abcdef01234567-";

test("D1 acceptance maintenance purges one service record and receipt without crossing namespaces", async () => {
  const sqlite = await migratedDatabase();
  const store = new D1AuthStore(
    sqliteD1(sqlite, { receiptDeleteMetadataExtra: 1 }),
  );
  try {
    const owner = await createService(store, "Proof owner");
    const outsider = await createService(store, "Proof outsider");
    seedRecordAndReceipt(sqlite, owner.id, `${PREFIX}records`, "owner");
    seedRecordAndReceipt(sqlite, outsider.id, `${PREFIX}records`, "outsider");

    const result = await store.purgeAcceptanceBoundedServiceNamespace(
      { serviceClientId: owner.id, collectionPrefix: PREFIX },
      { actorSubjectHash: await sha256("test-administrator"), createdAt: 2 },
    );

    assert.deepEqual(result, {
      status: "completed",
      deletedRecords: 1,
      deletedReceipts: 1,
      remainingRecords: 0,
      remainingReceipts: 0,
    });
    assert.equal(
      await store.getBoundedStorageRecord(
        owner.id,
        owner.id,
        `${PREFIX}records`,
        "owner",
      ),
      null,
    );
    assert.ok(
      await store.getBoundedStorageRecord(
        outsider.id,
        outsider.id,
        `${PREFIX}records`,
        "outsider",
      ),
    );
  } finally {
    sqlite.close();
  }
});

test("D1 acceptance maintenance returns zero counts for a valid empty service prefix", async () => {
  const sqlite = await migratedDatabase();
  const store = new D1AuthStore(sqliteD1(sqlite));
  try {
    const owner = await createService(store, "Proof owner");
    const result = await store.purgeAcceptanceBoundedServiceNamespace(
      { serviceClientId: owner.id, collectionPrefix: PREFIX },
      { actorSubjectHash: await sha256("test-administrator"), createdAt: 2 },
    );
    assert.deepEqual(result, {
      status: "completed",
      deletedRecords: 0,
      deletedReceipts: 0,
      remainingRecords: 0,
      remainingReceipts: 0,
    });
  } finally {
    sqlite.close();
  }
});

test("D1 acceptance maintenance fails closed for an unavailable service namespace", async () => {
  const sqlite = await migratedDatabase();
  const store = new D1AuthStore(sqliteD1(sqlite));
  try {
    const result = await store.purgeAcceptanceBoundedServiceNamespace(
      {
        serviceClientId: "11111111-1111-4111-8111-111111111111",
        collectionPrefix: PREFIX,
      },
      { actorSubjectHash: await sha256("test-administrator"), createdAt: 2 },
    );
    assert.deepEqual(result, { status: "unavailable" });
  } finally {
    sqlite.close();
  }
});

async function createService(store: D1AuthStore, name: string) {
  return store.createClient(
    {
      type: "service",
      name,
      redirectUris: [],
      scopes: ["storage.read", "storage.write", "storage.delete"],
      origins: [],
    },
    "synthetic-service-secret-hash",
    1,
  );
}

function seedRecordAndReceipt(
  sqlite: DatabaseSync,
  clientId: string,
  collection: string,
  id: string,
): void {
  const valueJson = JSON.stringify({ disposable: true });
  const resultJson = JSON.stringify([
    {
      key: { collection, id },
      revision: 1,
      value: { disposable: true },
    },
  ]);
  const operationHash = `${id[0] ?? "a"}`.repeat(43);
  sqlite
    .prepare(
      "INSERT INTO bounded_storage_records (user_id, client_id, collection, record_id, value_json, value_bytes, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)",
    )
    .run(
      clientId,
      clientId,
      collection,
      id,
      valueJson,
      Buffer.byteLength(valueJson),
    );
  sqlite
    .prepare(
      "INSERT INTO bounded_storage_transaction_receipts (user_id, client_id, operation_id_hash, request_hash, attempt_hash, mutation_count, result_json, result_bytes, status, created_at, committed_at, expires_at, admission_class, collection_names_json) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'committed', 1, 1, 3601, 'ordinary', ?)",
    )
    .run(
      clientId,
      clientId,
      operationHash,
      "r".repeat(43),
      "t".repeat(43),
      resultJson,
      Buffer.byteLength(resultJson),
      JSON.stringify([collection]),
    );
  sqlite
    .prepare(
      "INSERT INTO bounded_storage_transaction_receipt_collections (user_id, client_id, operation_id_hash, collection) VALUES (?, ?, ?, ?)",
    )
    .run(clientId, clientId, operationHash, collection);
}

async function migratedDatabase(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../../db/migrations/", import.meta.url);
  for (const name of (await readdir(migrations))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    sqlite.exec(await readFile(new URL(name, migrations), "utf8"));
  }
  return sqlite;
}

function sqliteD1(
  database: DatabaseSync,
  options: Readonly<{ receiptDeleteMetadataExtra?: number }> = {},
): D1Database {
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
          return { success: true, meta: { changes: Number(result.changes) } };
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
          const preparedStatement = database.prepare(execution.query);
          if (isMaintenancePreflight(execution.query)) {
            return {
              success: true,
              results: preparedStatement.all(...execution.values) as T[],
            } as D1Result<T>;
          }
          const result = preparedStatement.run(...execution.values);
          const receiptDeleteExtra = execution.query.includes(
            "DELETE FROM bounded_storage_transaction_receipts",
          )
            ? (options.receiptDeleteMetadataExtra ?? 0)
            : 0;
          return {
            success: true,
            // D1 may include the receipt-collection cascade in mutation metadata.
            meta: { changes: Number(result.changes) + receiptDeleteExtra },
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

function isMaintenancePreflight(query: string): boolean {
  return query.includes(
    "SELECT\n  (SELECT COUNT(*) FROM eligible_service) AS eligible_service",
  );
}
