import test from "node:test";
import assert from "node:assert/strict";
import { D1AuthStore } from "../../src/store/d1";

test("D1 storage reads and deletes always bind user and client ownership", async () => {
  const calls: Array<{
    query: string;
    values: unknown[];
    operation: "all" | "first" | "run";
  }> = [];
  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      let values: unknown[] = [];
      const statement: D1PreparedStatement = {
        bind(...nextValues: unknown[]): D1PreparedStatement {
          values = nextValues;
          return statement;
        },
        async all<T>(): Promise<D1Result<T>> {
          calls.push({ query, values, operation: "all" });
          return { success: true, results: [] };
        },
        async first<T>(): Promise<T | null> {
          calls.push({ query, values, operation: "first" });
          return null;
        },
        async run<T>(): Promise<D1Result<T>> {
          calls.push({ query, values, operation: "run" });
          return { success: true, results: [] };
        },
      };
      return statement;
    },
  };
  const store = new D1AuthStore(db);

  await store.listStorageRecords("user-a", "client-a");
  await store.getStorageRecord("user-a", "client-a", "record-key");
  await store.deleteStorageRecord("user-a", "client-a", "record-key");
  await store.listStorageFiles("user-a", "client-a");
  await store.getStorageFileMetadata("user-a", "client-a", "file-key");
  await store.deleteStorageFileMetadata("user-a", "client-a", "file-key");

  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.match(call.query, /WHERE user_id = \? AND client_id = \?/);
    assert.deepEqual(call.values.slice(0, 2), ["user-a", "client-a"]);
  }
  assert.deepEqual(
    calls.filter((call) => call.values.length === 3).map((call) => call.values),
    [
      ["user-a", "client-a", "record-key"],
      ["user-a", "client-a", "record-key"],
      ["user-a", "client-a", "file-key"],
      ["user-a", "client-a", "file-key"],
    ],
  );
});
