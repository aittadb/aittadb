import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { openApiSpec } from "../../src/openapi";
import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type { StorageFileOrphanRepair } from "../../src/types";

test("orphan-repair migration stores only internal physical repair metadata", async () => {
  const sqlite = await migratedDatabase();
  try {
    const columns = sqlite
      .prepare("PRAGMA table_info(storage_file_orphan_repairs)")
      .all()
      .map((column) => String(column.name));
    assert.deepEqual(columns, [
      "r2_key",
      "user_id",
      "client_id",
      "created_at",
      "updated_at",
    ]);
    assert.equal(columns.includes("key"), false);
    assert.equal(columns.includes("content"), false);
    assert.equal(columns.includes("error"), false);
    assert.equal(columns.includes("credential"), false);

    const indexSql = String(
      sqlite
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE name = 'idx_storage_file_orphan_repairs_created_at'",
        )
        .get()?.sql ?? "",
    );
    assert.match(indexSql, /created_at, r2_key/);
  } finally {
    sqlite.close();
  }
});

test("D1 orphan-repair recording deduplicates and rejects tenant reassignment", async () => {
  const sqlite = await migratedDatabase();
  try {
    const store = new D1AuthStore(sqliteD1(sqlite));
    const first = repair("user-a", "client-a", "physical/object-a", 10);
    assert.equal(await store.recordStorageFileOrphanRepair(first), true);
    assert.equal(
      await store.recordStorageFileOrphanRepair({
        ...first,
        createdAt: 20,
        updatedAt: 20,
      }),
      true,
    );
    assert.equal(
      await store.recordStorageFileOrphanRepair(
        repair("user-b", "client-b", first.r2Key, 30),
      ),
      false,
    );

    const rows = sqlite
      .prepare("SELECT * FROM storage_file_orphan_repairs")
      .all();
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { ...rows[0] },
      {
        r2_key: first.r2Key,
        user_id: "user-a",
        client_id: "client-a",
        created_at: 10,
        updated_at: 20,
      },
    );
  } finally {
    sqlite.close();
  }
});

test("memory orphan-repair recording has D1-equivalent deduplication", async () => {
  const store = new MemoryAuthStore();
  const first = repair("user-a", "client-a", "physical/object-a", 10);
  assert.equal(await store.recordStorageFileOrphanRepair(first), true);
  assert.equal(
    await store.recordStorageFileOrphanRepair({
      ...first,
      createdAt: 20,
      updatedAt: 20,
    }),
    true,
  );
  assert.equal(
    await store.recordStorageFileOrphanRepair(
      repair("user-b", "client-b", first.r2Key, 30),
    ),
    false,
  );
  assert.deepEqual(Array.from(store.storageFileOrphanRepairs.values()), [
    { ...first, updatedAt: 20 },
  ]);
});

test("orphan-repair state has no caller-facing OpenAPI contract", () => {
  const specification = JSON.stringify(openApiSpec);
  assert.doesNotMatch(specification, /storage_file_orphan_repairs/);
  assert.doesNotMatch(specification, /storageFileOrphanRepair/);
  assert.doesNotMatch(specification, /r2_key/);
});

function repair(
  userId: string,
  clientId: string,
  r2Key: string,
  recordedAt: number,
): StorageFileOrphanRepair {
  return {
    userId,
    clientId,
    r2Key,
    createdAt: recordedAt,
    updatedAt: recordedAt,
  };
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
