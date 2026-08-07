import assert from "node:assert/strict";
import test from "node:test";

import { D1AuthStore } from "../../src/store/d1";

const COUNT_USERS_SQL = "SELECT COUNT(*) AS identity_count FROM users";

test("D1 countUsers prepares one aggregate query and returns only its number", async () => {
  const preparedQueries: string[] = [];
  let firstCalls = 0;

  const statement: D1PreparedStatement = {
    bind(): D1PreparedStatement {
      assert.fail("the aggregate query must not bind caller-controlled values");
    },
    async all<T>(): Promise<D1Result<T>> {
      assert.fail("countUsers must not fetch a row collection");
    },
    async first<T>(): Promise<T | null> {
      firstCalls += 1;
      return {
        identity_count: "37",
        email: "must-not-escape@example.test",
        deployment_secret: "must-not-escape",
      } as unknown as T;
    },
    async run<T>(): Promise<D1Result<T>> {
      assert.fail("countUsers must not execute a mutating statement");
    },
  };

  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      preparedQueries.push(query);
      return statement;
    },
  };

  const result = await new D1AuthStore(db).countUsers();

  assert.deepEqual(preparedQueries, [COUNT_USERS_SQL]);
  assert.equal(firstCalls, 1);
  assert.equal(result, 37);
  assert.equal(typeof result, "number");
});
