import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { nowSeconds, sha256 } from "../../src/crypto";
import { createClientRegistration } from "../../src/oauth";
import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type { UpstreamIdentity } from "../../src/types";

const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USER_EMAIL = "user@example.test";

interface D1Hooks {
  beforeAll?: (query: string, values: unknown[]) => void | Promise<void>;
  afterAll?: (
    query: string,
    values: unknown[],
    results: unknown[],
  ) => void | Promise<void>;
}

interface AdapterCall {
  query: string;
  values: unknown[];
  operation: "all" | "first" | "run";
}

test("migrated D1 resolves concurrent first requests to one canonical user", async () => {
  const sqlite = await migratedDatabase();
  try {
    const requestCount = 8;
    let arrivals = 0;
    const candidates: string[] = [];
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new D1AuthStore(
      sqliteD1(sqlite, {
        async beforeAll(query, values) {
          if (!isUserResolution(query)) return;
          arrivals += 1;
          candidates.push(String(values[0]));
          if (arrivals === requestCount) release();
          await ready;
        },
      }),
    );

    const users = await Promise.all(
      Array.from({ length: requestCount }, () =>
        store.findOrCreateUser(identity("Concurrent User"), 100),
      ),
    );

    assert.equal(arrivals, requestCount);
    assert.equal(new Set(candidates).size, requestCount);
    for (const candidate of candidates)
      assert.match(candidate, USER_ID_PATTERN);
    assert.equal(new Set(users.map((user) => user.id)).size, 1);
    assert.match(users[0]!.id, USER_ID_PATTERN);
    assert.deepEqual(
      users.map(({ email, displayName, createdAt, updatedAt }) => ({
        email,
        displayName,
        createdAt,
        updatedAt,
      })),
      Array.from({ length: requestCount }, () => ({
        email: USER_EMAIL,
        displayName: "Concurrent User",
        createdAt: 100,
        updatedAt: 100,
      })),
    );
    assert.deepEqual(readUsers(sqlite), [
      {
        id: users[0]!.id,
        email: USER_EMAIL,
        display_name: "Concurrent User",
        created_at: 100,
        updated_at: 100,
      },
    ]);
  } finally {
    sqlite.close();
  }
});

test("migrated D1 repeats retain identity and creation metadata", async () => {
  const sqlite = await migratedDatabase();
  try {
    const store = new D1AuthStore(sqliteD1(sqlite));
    const created = await store.findOrCreateUser(identity("First Name"), 100);
    const repeated = await store.findOrCreateUser(
      identity("Updated Name"),
      200,
    );

    assert.equal(repeated.id, created.id);
    assert.deepEqual(repeated, {
      id: created.id,
      email: USER_EMAIL,
      displayName: "Updated Name",
      createdAt: 100,
      updatedAt: 200,
    });
    assert.deepEqual(readUsers(sqlite), [
      {
        id: created.id,
        email: USER_EMAIL,
        display_name: "Updated Name",
        created_at: 100,
        updated_at: 200,
      },
    ]);
  } finally {
    sqlite.close();
  }
});

test("D1 resolution is one prepared upsert with an exact returned row", async () => {
  const calls: AdapterCall[] = [];
  const returnedId = "f7c8d1c0-c57e-4f6b-a4c7-b2b783bc0c30";
  const store = new D1AuthStore(
    outcomeD1(
      {
        success: true,
        results: [
          {
            id: returnedId,
            email: USER_EMAIL,
            display_name: "Exact User",
            created_at: 10,
            updated_at: 20,
          },
        ],
      },
      calls,
    ),
  );

  assert.deepEqual(await store.findOrCreateUser(identity("Exact User"), 20), {
    id: returnedId,
    email: USER_EMAIL,
    displayName: "Exact User",
    createdAt: 10,
    updatedAt: 20,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.operation, "all");
  assert.match(calls[0]!.query, /^\s*INSERT INTO users/);
  assert.match(calls[0]!.query, /ON CONFLICT\(email\) DO UPDATE SET/);
  assert.match(
    calls[0]!.query,
    /RETURNING id, email, display_name, created_at, updated_at\s*$/,
  );
  assert.doesNotMatch(calls[0]!.query, /SELECT \* FROM users/);
  assert.match(String(calls[0]!.values[0]), USER_ID_PATTERN);
  assert.deepEqual(calls[0]!.values.slice(1), [USER_EMAIL, "Exact User", 20]);
});

test("D1 resolution rejects absent, unsuccessful, multiple, or malformed results", async () => {
  const valid = {
    id: "19f584f7-3a68-45d8-8748-ca0c21571f31",
    email: USER_EMAIL,
    display_name: "Test User",
    created_at: 10,
    updated_at: 20,
  };
  const outcomes: Array<{ name: string; value: unknown }> = [
    { name: "absent result", value: undefined },
    { name: "unsuccessful result", value: { success: false } },
    { name: "missing rows", value: { success: true } },
    { name: "zero rows", value: { success: true, results: [] } },
    {
      name: "multiple rows",
      value: { success: true, results: [valid, valid] },
    },
    { name: "null row", value: { success: true, results: [null] } },
    {
      name: "invalid UUID",
      value: { success: true, results: [{ ...valid, id: "not-a-uuid" }] },
    },
    {
      name: "wrong email",
      value: {
        success: true,
        results: [{ ...valid, email: "other@example.test" }],
      },
    },
    {
      name: "wrong display name",
      value: {
        success: true,
        results: [{ ...valid, display_name: "Other User" }],
      },
    },
    {
      name: "malformed creation time",
      value: {
        success: true,
        results: [{ ...valid, created_at: "10" }],
      },
    },
    {
      name: "wrong update time",
      value: { success: true, results: [{ ...valid, updated_at: 19 }] },
    },
  ];

  for (const outcome of outcomes) {
    const store = new D1AuthStore(outcomeD1(outcome.value));
    await assert.rejects(
      store.findOrCreateUser(identity("Test User"), 20),
      /user_resolution_failed/,
      outcome.name,
    );
  }
});

test("migrated D1 failure before commit leaves no user and retry creates one", async () => {
  const sqlite = await migratedDatabase();
  try {
    let failBeforeCommit = true;
    const store = new D1AuthStore(
      sqliteD1(sqlite, {
        beforeAll(query) {
          if (isUserResolution(query) && failBeforeCommit) {
            failBeforeCommit = false;
            throw new Error("injected_before_commit");
          }
        },
      }),
    );

    await assert.rejects(
      store.findOrCreateUser(identity("First Attempt"), 100),
      /injected_before_commit/,
    );
    assert.deepEqual(readUsers(sqlite), []);

    const retry = await store.findOrCreateUser(identity("Retry"), 200);
    assert.deepEqual(readUsers(sqlite), [
      {
        id: retry.id,
        email: USER_EMAIL,
        display_name: "Retry",
        created_at: 200,
        updated_at: 200,
      },
    ]);
  } finally {
    sqlite.close();
  }
});

test("migrated D1 retry after committed response uncertainty returns the committed UUID", async () => {
  const sqlite = await migratedDatabase();
  try {
    let failAfterCommit = true;
    let committedId: string | undefined;
    const store = new D1AuthStore(
      sqliteD1(sqlite, {
        afterAll(query, _values, results) {
          if (isUserResolution(query) && failAfterCommit) {
            failAfterCommit = false;
            committedId = String(
              (results[0] as { id?: unknown } | undefined)?.id,
            );
            throw new Error("injected_after_commit");
          }
        },
      }),
    );

    await assert.rejects(
      store.findOrCreateUser(identity("Uncertain"), 100),
      /injected_after_commit/,
    );
    assert.match(committedId ?? "", USER_ID_PATTERN);
    assert.deepEqual(readUsers(sqlite), [
      {
        id: committedId,
        email: USER_EMAIL,
        display_name: "Uncertain",
        created_at: 100,
        updated_at: 100,
      },
    ]);

    const retry = await store.findOrCreateUser(identity("Recovered"), 200);
    assert.equal(retry.id, committedId);
    assert.deepEqual(retry, {
      id: committedId,
      email: USER_EMAIL,
      displayName: "Recovered",
      createdAt: 100,
      updatedAt: 200,
    });
    assert.equal(readUsers(sqlite).length, 1);
  } finally {
    sqlite.close();
  }
});

test("memory resolution inserts synchronously and keeps one canonical user", async () => {
  const store = new MemoryAuthStore();
  const firstPromise = store.findOrCreateUser(identity("First Name"), 100);
  assert.equal(store.users.size, 1);
  assert.equal(store.usersByEmail.size, 1);
  const insertedId = store.usersByEmail.get(USER_EMAIL);
  assert.match(insertedId ?? "", USER_ID_PATTERN);

  const repeatedPromise = store.findOrCreateUser(identity("Updated Name"), 200);
  assert.equal(store.users.size, 1);
  assert.equal(store.usersByEmail.get(USER_EMAIL), insertedId);

  const [first, repeated] = await Promise.all([firstPromise, repeatedPromise]);
  assert.equal(first.id, insertedId);
  assert.equal(repeated.id, insertedId);
  assert.deepEqual(repeated, {
    id: insertedId,
    email: USER_EMAIL,
    displayName: "Updated Name",
    createdAt: 100,
    updatedAt: 200,
  });
  assert.deepEqual(await store.getUserByEmail(USER_EMAIL), repeated);
});

test("D1 and memory preserve exact case-sensitive email semantics", async () => {
  const sqlite = await migratedDatabase();
  try {
    const d1Store = new D1AuthStore(sqliteD1(sqlite));
    const memoryStore = new MemoryAuthStore();
    for (const store of [d1Store, memoryStore]) {
      const lower = await store.findOrCreateUser(identity("Lower"), 100);
      const caseVariant = await store.findOrCreateUser(
        identity("Case Variant", "User@example.test"),
        200,
      );
      assert.notEqual(caseVariant.id, lower.id);
      assert.equal(await store.countUsers(), 2);
    }
  } finally {
    sqlite.close();
  }
});

test("migrated D1 stores service clients as non-human principals", async () => {
  const sqlite = await migratedDatabase();
  try {
    const store = new D1AuthStore(sqliteD1(sqlite));
    const registration = await createClientRegistration(
      {
        type: "service",
        name: "Background worker",
        redirectUris: [],
        scopes: ["storage.read", "storage.write"],
        origins: [],
      },
      store,
      nowSeconds(),
    );

    assert.ok(registration.secret);
    assert.equal(
      await store.getClientSecretHash(registration.client.id),
      await sha256(registration.secret),
    );
    assert.equal(
      (await store.getClient(registration.client.id))?.type,
      "service",
    );
    assert.equal(await store.hasServicePrincipal(registration.client.id), true);
    assert.equal(await store.getUser(registration.client.id), null);
    assert.equal(await store.countUsers(), 0);
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT principal_type FROM users WHERE id = ? UNION ALL SELECT client_kind FROM oauth_clients WHERE id = ?",
        )
        .all(registration.client.id, registration.client.id)
        .map((row) => Object.values(row)[0]),
      ["service", "service"],
    );

    await store.findOrCreateUser(identity("Human User"), nowSeconds());
    assert.equal(await store.countUsers(), 1);
  } finally {
    sqlite.close();
  }
});

function identity(displayName: string, email = USER_EMAIL): UpstreamIdentity {
  return { email, fullName: displayName, displayName };
}

function isUserResolution(query: string): boolean {
  return /^\s*INSERT INTO users/.test(query);
}

function readUsers(sqlite: DatabaseSync): Array<Record<string, unknown>> {
  return sqlite
    .prepare(
      "SELECT id, email, display_name, created_at, updated_at FROM users ORDER BY email ASC",
    )
    .all()
    .map((row) => ({ ...row }));
}

function outcomeD1(outcome: unknown, calls: AdapterCall[] = []): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      let values: unknown[] = [];
      const statement: D1PreparedStatement = {
        bind(...nextValues: unknown[]): D1PreparedStatement {
          values = nextValues;
          return statement;
        },
        async all<T>(): Promise<D1Result<T>> {
          calls.push({ query, values, operation: "all" });
          return outcome as D1Result<T>;
        },
        async first<T>(): Promise<T | null> {
          calls.push({ query, values, operation: "first" });
          assert.fail("user resolution must not perform a separate read");
        },
        async run<T>(): Promise<D1Result<T>> {
          calls.push({ query, values, operation: "run" });
          assert.fail("user resolution must not perform a separate mutation");
        },
      };
      return statement;
    },
  };
}

function sqliteD1(database: DatabaseSync, hooks: D1Hooks = {}): D1Database {
  return {
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      database.exec("BEGIN");
      try {
        const results: D1Result<T>[] = [];
        for (const statement of statements)
          results.push(await statement.run<T>());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
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
          await hooks.beforeAll?.(query, values);
          const results = database.prepare(query).all(...values) as T[];
          await hooks.afterAll?.(query, values, results as unknown[]);
          return { success: true, results };
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

async function migratedDatabase(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../../db/migrations/", import.meta.url);
  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrationNames) {
    sqlite.exec(await readFile(new URL(name, migrationDirectory), "utf8"));
  }
  return sqlite;
}
