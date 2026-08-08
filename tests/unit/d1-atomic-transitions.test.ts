import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { D1AuthStore } from "../../src/store/d1";
import type { AuthorizationRequest } from "../../src/types";

interface Call {
  query: string;
  values: unknown[];
  operation: "all" | "first" | "run";
}

type Executor = (call: Call) => unknown;

function fakeDatabase(execute: Executor): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      let values: unknown[] = [];
      const statement: D1PreparedStatement = {
        bind(...nextValues: unknown[]): D1PreparedStatement {
          values = nextValues;
          return statement;
        },
        async all<T>(): Promise<D1Result<T>> {
          return execute({ query, values, operation: "all" }) as D1Result<T>;
        },
        async first<T>(): Promise<T | null> {
          return execute({ query, values, operation: "first" }) as T | null;
        },
        async run<T>(): Promise<D1Result<T>> {
          return execute({ query, values, operation: "run" }) as D1Result<T>;
        },
      };
      return statement;
    },
  };
}

test("D1 one-time transitions fail closed unless exactly one row changes", async () => {
  const calls: Call[] = [];
  const store = new D1AuthStore(
    fakeDatabase((call) => {
      calls.push(call);
      if (call.operation === "run")
        return { success: true, meta: { changes: 0 } };
      assert.fail(
        "a failed compare-and-set must not read or mint a credential",
      );
    }),
  );

  assert.equal(
    await store.transitionAuthorizationRequest(
      "request",
      "approved",
      "user",
      10,
    ),
    false,
  );
  assert.equal(
    await store.transitionDeviceGrant("user-code", "approved", "user", 10),
    null,
  );
  assert.equal(await store.consumeDeviceGrant("device", "client", 10), null);
  assert.equal(
    await store.consumeAuthorizationCode(
      "code",
      "client",
      "https://client/cb",
      10,
    ),
    null,
  );

  assert.equal(calls.length, 4);
  assert.match(calls[0]!.query, /status = 'pending' AND expires_at > \?/);
  assert.match(calls[1]!.query, /status = 'pending' AND expires_at > \?/);
  assert.match(calls[2]!.query, /client_id = \? AND status = 'approved'/);
  assert.match(
    calls[3]!.query,
    /client_id = \? AND redirect_uri = \?.*consumed_at IS NULL.*expires_at > \?/,
  );
  assert.deepEqual(calls[3]!.values, [
    10,
    "code",
    "client",
    "https://client/cb",
    10,
  ]);
});

test("D1 authorization requests have one terminal winner against migrated SQL", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const name of [
      "0001_initial.sql",
      "0002_browser_session_client.sql",
      "0003_browser_session_openid.sql",
      "0004_security_indexes.sql",
      "0005_admin_submission_results.sql",
    ]) {
      sqlite.exec(
        await readFile(
          new URL(`../../db/migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    }
    const store = new D1AuthStore(sqliteD1(sqlite));
    const sequential = authorizationRequest("sequential");
    await store.createAuthorizationRequest(sequential);
    assert.equal(
      await store.transitionAuthorizationRequest(
        sequential.id,
        "approved",
        "user-approved",
        10,
      ),
      true,
    );
    assert.equal(
      await store.transitionAuthorizationRequest(
        sequential.id,
        "denied",
        null,
        10,
      ),
      false,
    );
    assert.deepEqual(await store.getAuthorizationRequest(sequential.id), {
      ...sequential,
      status: "approved",
      userId: "user-approved",
    });

    const concurrent = authorizationRequest("concurrent");
    await store.createAuthorizationRequest(concurrent);
    const results = await Promise.all([
      store.transitionAuthorizationRequest(
        concurrent.id,
        "approved",
        "user-concurrent",
        10,
      ),
      store.transitionAuthorizationRequest(concurrent.id, "denied", null, 10),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const stored = await store.getAuthorizationRequest(concurrent.id);
    assert.ok(stored);
    assert.notEqual(stored.status, "pending");
    assert.equal(
      await store.transitionAuthorizationRequest(
        concurrent.id,
        "approved",
        "different-user",
        10,
      ),
      false,
    );
    assert.equal(
      await store.transitionAuthorizationRequest(
        concurrent.id,
        "denied",
        null,
        10,
      ),
      false,
    );
  } finally {
    sqlite.close();
  }
});

test("D1 admin submissions gate mutation and result replay atomically", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const name of [
      "0001_initial.sql",
      "0002_browser_session_client.sql",
      "0003_browser_session_openid.sql",
      "0004_security_indexes.sql",
      "0005_admin_submission_results.sql",
    ]) {
      sqlite.exec(
        await readFile(
          new URL(`../../db/migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    }
    sqlite.exec(
      "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('user', 'admin@example.test', 'Admin', 1, 1)",
    );
    const store = new D1AuthStore(sqliteD1(sqlite));
    const claims = await Promise.all([
      store.claimAdminOperationSubmission("submission-hash", "user", 10, 20),
      store.claimAdminOperationSubmission("submission-hash", "user", 10, 20),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(
      await store.consumeAdminOperationResult(
        "submission-hash",
        "different-user",
        11,
      ),
      false,
    );
    const resultReads = await Promise.all([
      store.consumeAdminOperationResult("submission-hash", "user", 11),
      store.consumeAdminOperationResult("submission-hash", "user", 11),
    ]);
    assert.equal(resultReads.filter(Boolean).length, 1);
    assert.deepEqual(
      {
        ...sqlite
          .prepare(
            "SELECT token_hash, user_id, expires_at, result_consumed_at FROM admin_operation_submissions",
          )
          .get(),
      },
      {
        token_hash: "submission-hash",
        user_id: "user",
        expires_at: 20,
        result_consumed_at: 11,
      },
    );
    const columns = sqlite
      .prepare("PRAGMA table_info(admin_operation_submissions)")
      .all()
      .map((column) => String(column.name));
    assert.equal(
      columns.some((name) => /secret|plaintext|value/.test(name)),
      false,
    );
  } finally {
    sqlite.close();
  }
});

test("D1 device compare-and-set returns only the row changed by the winner", async () => {
  const calls: Call[] = [];
  const store = new D1AuthStore(
    fakeDatabase((call) => {
      calls.push(call);
      if (call.operation === "run")
        return { success: true, meta: { changes: 1 } };
      if (call.operation === "first") {
        return {
          id: "grant",
          device_code_hash: "device",
          user_code_hash: "user-code",
          user_code_display: "ABCD-EFGH",
          client_id: "client",
          scope: "openid",
          status: "used",
          user_id: "user",
          created_at: 1,
          expires_at: 20,
          interval_seconds: 5,
          last_poll_at: 10,
          slow_down_count: 0,
        };
      }
      assert.fail("unexpected D1 operation");
    }),
  );

  const consumed = await store.consumeDeviceGrant("device", "client", 10);
  assert.equal(consumed?.status, "used");
  assert.equal(consumed?.userId, "user");
  assert.deepEqual(
    calls.map((call) => call.operation),
    ["run", "first"],
  );
  assert.deepEqual(calls[0]!.values, ["device", "client", 10]);
});

test("D1 polling metadata updates cannot restore a stale grant status", async () => {
  let call: Call | undefined;
  const store = new D1AuthStore(
    fakeDatabase((nextCall) => {
      call = nextCall;
      return { success: true, meta: { changes: 1 } };
    }),
  );

  await store.updateDeviceGrant({
    id: "grant",
    deviceCodeHash: "device",
    userCodeHash: "user-code",
    userCodeDisplay: "ABCD-EFGH",
    clientId: "client",
    scope: "openid",
    status: "approved",
    userId: "user",
    createdAt: 1,
    expiresAt: 20,
    intervalSeconds: 5,
    lastPollAt: 10,
    slowDownCount: 2,
  });

  assert.ok(call);
  assert.equal(
    call.query,
    "UPDATE device_grants SET last_poll_at = ?, slow_down_count = ? WHERE id = ?",
  );
  assert.deepEqual(call.values, [10, 2, "grant"]);
  assert.doesNotMatch(call.query, /status|user_id/);
});

test("D1 refresh reuse races revoke the bound token family", async () => {
  const calls: Call[] = [];
  let joinedRead = 0;
  const store = new D1AuthStore(
    fakeDatabase((call) => {
      calls.push(call);
      if (
        call.operation === "first" &&
        /JOIN refresh_token_families/.test(call.query)
      ) {
        joinedRead += 1;
        return {
          id: "refresh",
          family_id: "family",
          token_hash: "hash",
          user_id: "user",
          client_id: "client",
          scope: "openid offline_access",
          expires_at: 100,
          used_at: joinedRead === 1 ? null : 11,
          revoked_at: null,
          family_status: "active",
        };
      }
      if (call.operation === "run" && /SET used_at/.test(call.query)) {
        return { success: true, meta: { changes: 0 } };
      }
      if (call.operation === "run")
        return { success: true, meta: { changes: 1 } };
      assert.fail(`unexpected D1 operation: ${call.query}`);
    }),
  );

  assert.equal(await store.consumeRefreshToken("hash", "client", 10), null);
  const revocations = calls.filter(
    (call) =>
      call.operation === "run" &&
      /SET status = 'revoked'|SET revoked_at/.test(call.query),
  );
  assert.equal(revocations.length, 2);
  assert.deepEqual(revocations[0]!.values, ["family"]);
  assert.deepEqual(revocations[1]!.values, [10, "family"]);
  assert.ok(
    calls.some(
      (call) =>
        /SET used_at/.test(call.query) &&
        /used_at IS NULL/.test(call.query) &&
        /status = 'active'/.test(call.query),
    ),
  );
});

function authorizationRequest(id: string): AuthorizationRequest {
  return {
    id,
    clientId: "client",
    redirectUri: "https://client.example.test/callback",
    scope: "openid",
    state: "state",
    nonce: null,
    codeChallenge: "A".repeat(43),
    createdAt: 1,
    expiresAt: 20,
    userId: null,
    status: "pending",
  };
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
