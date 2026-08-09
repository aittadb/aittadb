import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { loadConfig } from "../../src/config";
import {
  decodeStorageCursor,
  encodeStorageCursor,
} from "../../src/storage-cursor";
import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  StorageFileMetadata,
  StorageLimits,
  StorageRecord,
} from "../../src/types";
import { testEnv } from "../helpers";

const TIGHT_LIMITS: StorageLimits = {
  writesEnabled: true,
  globalMaxItems: 2,
  globalMaxBytes: 64,
  userMaxItems: 2,
  userMaxBytes: 64,
  namespaceMaxItems: 1,
  namespaceMaxBytes: 32,
};

test("storage configuration has finite defaults and a strict kill switch", async () => {
  const env = await testEnv();
  const defaults = loadConfig(env, env.ISSUER_URL!);
  assert.equal(defaults.storageLimits.writesEnabled, true);
  assert.equal(defaults.storageLimits.namespaceMaxItems, 500);
  assert.equal(defaults.storageLimits.namespaceMaxBytes, 50 * 1024 * 1024);
  assert.equal(defaults.storageDefaultPageSize, 50);
  assert.equal(defaults.storageMaxPageSize, 100);

  const disabled = loadConfig(
    { ...env, STORAGE_WRITES_ENABLED: "false" },
    env.ISSUER_URL!,
  );
  assert.equal(disabled.storageLimits.writesEnabled, false);
  assert.throws(
    () =>
      loadConfig(
        { ...env, STORAGE_WRITES_ENABLED: "sometimes" },
        env.ISSUER_URL!,
      ),
    /Expected boolean/,
  );
  assert.throws(
    () =>
      loadConfig(
        { ...env, STORAGE_READ_RATE_LIMIT: "12requests" },
        env.ISSUER_URL!,
      ),
    /Expected positive integer/,
  );
  assert.throws(
    () =>
      loadConfig(
        {
          ...env,
          STORAGE_DEFAULT_PAGE_SIZE: "101",
          STORAGE_MAX_PAGE_SIZE: "100",
        },
        env.ISSUER_URL!,
      ),
    /must not exceed/,
  );
});

test("memory storage enforces namespace item and byte limits while deletes free capacity", async () => {
  const store = new MemoryAuthStore();
  const first = record("user", "client", "first", '"12345678"');
  assert.equal(await store.upsertStorageRecord(first, TIGHT_LIMITS), true);
  assert.equal(
    await store.upsertStorageRecord(
      record("user", "client", "second", '"x"'),
      TIGHT_LIMITS,
    ),
    false,
  );
  assert.equal(
    await store.upsertStorageRecord(
      record("user", "other-client", "other", '"12345678"'),
      TIGHT_LIMITS,
    ),
    true,
  );
  assert.equal(
    await store.upsertStorageRecord(
      record("other-user", "client", "global", '"x"'),
      TIGHT_LIMITS,
    ),
    false,
  );
  await store.deleteStorageRecord("user", "client", "first");
  assert.equal(
    await store.upsertStorageRecord(
      record("other-user", "client", "global", '"x"'),
      TIGHT_LIMITS,
    ),
    true,
  );
});

test("storage cursors are tamper-resistant and bound to kind, user, and client", async () => {
  const env = await testEnv();
  const config = loadConfig(env, env.ISSUER_URL!);
  const cursor = await encodeStorageCursor(
    "records",
    "user-a",
    "client-a",
    { updatedAt: 10, key: "alpha" },
    config,
  );
  assert.deepEqual(
    await decodeStorageCursor(cursor, "records", "user-a", "client-a", config),
    { updatedAt: 10, key: "alpha" },
  );
  assert.equal(
    await decodeStorageCursor(
      `${cursor.slice(0, -1)}x`,
      "records",
      "user-a",
      "client-a",
      config,
    ),
    null,
  );
  assert.equal(
    await decodeStorageCursor(cursor, "files", "user-a", "client-a", config),
    null,
  );
  assert.equal(
    await decodeStorageCursor(cursor, "records", "user-b", "client-a", config),
    null,
  );
});

test("D1 quota check and upsert have one concurrent winner", async () => {
  const database = await migratedDatabase();
  database.sqlite.exec(
    "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('user', 'user@example.test', 'User', 1, 1); INSERT INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at) VALUES ('client', 'public', 'Client', NULL, NULL, 1);",
  );
  const store = new D1AuthStore(database.d1);
  const limits = { ...TIGHT_LIMITS, globalMaxItems: 1, userMaxItems: 1 };
  const outcomes = await Promise.all([
    store.upsertStorageRecord(record("user", "client", "a", '"a"'), limits),
    store.upsertStorageRecord(record("user", "client", "b", '"b"'), limits),
  ]);
  assert.deepEqual(outcomes.sort(), [false, true]);
  assert.equal(
    Number(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM storage_records")
        .get()?.count,
    ),
    1,
  );
  database.sqlite.close();
});

test("D1 file quotas include records and file pagination is deterministic", async () => {
  const database = await migratedDatabase();
  database.sqlite.exec(
    "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('user', 'user@example.test', 'User', 1, 1); INSERT INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at) VALUES ('client', 'public', 'Client', NULL, NULL, 1);",
  );
  const store = new D1AuthStore(database.d1);
  const limits = {
    ...TIGHT_LIMITS,
    globalMaxItems: 2,
    userMaxItems: 2,
    namespaceMaxItems: 2,
  };
  assert.equal(
    await store.upsertStorageRecord(
      record("user", "client", "record", '"record"'),
      limits,
    ),
    true,
  );
  const outcomes = await Promise.all([
    store.upsertStorageFileMetadata(
      file("user", "client", "alpha", 2, 10),
      null,
      limits,
    ),
    store.upsertStorageFileMetadata(
      file("user", "client", "beta", 2, 10),
      null,
      limits,
    ),
  ]);
  assert.deepEqual(outcomes.sort(), [false, true]);

  await store.deleteStorageRecord("user", "client", "record");
  assert.equal(
    await store.upsertStorageFileMetadata(
      file("user", "client", "gamma", 3, 10),
      null,
      limits,
    ),
    true,
  );
  const first = await store.listStorageFiles("user", "client", null, 1);
  assert.equal(first.items.length, 1);
  assert.equal(first.hasMore, true);
  const second = await store.listStorageFiles(
    "user",
    "client",
    { updatedAt: first.items[0]!.updatedAt, key: first.items[0]!.key },
    1,
  );
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0]!.key, first.items[0]!.key);
  database.sqlite.close();
});

test("D1 file metadata mutations compare the observed physical object key", async () => {
  const database = await migratedDatabase();
  database.sqlite.exec(
    "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('user', 'user@example.test', 'User', 1, 1); INSERT INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at) VALUES ('client', 'public', 'Client', NULL, NULL, 1);",
  );
  const store = new D1AuthStore(database.d1);
  const initial = file("user", "client", "same-key", 2, 10);
  const replacement = {
    ...file("user", "client", "same-key", 3, 11),
    r2Key: "r2/replacement",
  };

  assert.equal(
    await store.upsertStorageFileMetadata(initial, null, TIGHT_LIMITS),
    true,
  );
  assert.equal(
    await store.upsertStorageFileMetadata(replacement, null, TIGHT_LIMITS),
    false,
  );
  assert.equal(
    await store.upsertStorageFileMetadata(
      replacement,
      initial.r2Key,
      TIGHT_LIMITS,
    ),
    true,
  );
  assert.equal(
    await store.deleteStorageFileMetadata(
      "user",
      "client",
      "same-key",
      initial.r2Key,
    ),
    false,
  );
  assert.equal(
    await store.deleteStorageFileMetadata(
      "user",
      "client",
      "same-key",
      replacement.r2Key,
    ),
    true,
  );
  database.sqlite.close();
});

test("D1 rate increments are atomic under concurrent calls", async () => {
  const database = await migratedDatabase();
  const store = new D1AuthStore(database.d1);
  const outcomes = await Promise.all(
    Array.from({ length: 12 }, () => store.rateLimit("same-key", 5, 60, 10)),
  );
  assert.equal(outcomes.filter(Boolean).length, 5);
  assert.equal(
    Number(
      database.sqlite
        .prepare("SELECT count FROM rate_limit_counters WHERE key = 'same-key'")
        .get()?.count,
    ),
    12,
  );
  database.sqlite.close();
});

test("D1 rate counters fail closed at their durable row ceiling", async () => {
  const database = await migratedDatabase();
  database.sqlite.exec(`
    WITH RECURSIVE counters(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM counters WHERE value < 10000
    )
    INSERT INTO rate_limit_counters (key, count, window_start)
    SELECT 'counter-' || value, 1, 10 FROM counters;
  `);
  const store = new D1AuthStore(database.d1);
  assert.equal(await store.rateLimit("new-counter", 5, 60, 10), false);
  assert.equal(await store.rateLimit("counter-1", 5, 60, 10), true);
  assert.equal(
    Number(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM rate_limit_counters")
        .get()?.count,
    ),
    10_000,
  );
  database.sqlite.close();
});

test("D1 cleanup removes expired OAuth state in bounded batches", async () => {
  const database = await migratedDatabase();
  const insert = database.sqlite.prepare(
    "INSERT INTO authorization_requests (id, client_id, redirect_uri, scope, state, nonce, code_challenge, created_at, expires_at, user_id, status) VALUES (?, 'client', 'https://client.example/cb', 'openid', NULL, NULL, 'challenge', 1, 2, NULL, 'pending')",
  );
  for (let index = 0; index < 550; index += 1) insert.run(`request-${index}`);
  database.sqlite.exec(`
    INSERT INTO authorization_codes (code_hash, auth_request_id, client_id, redirect_uri, user_id, scope, nonce, expires_at, consumed_at) VALUES
      ('expired-code', 'expired-parent', 'client', 'https://client.example/cb', 'user', 'openid', NULL, 2, NULL),
      ('live-code', 'live-parent', 'client', 'https://client.example/cb', 'user', 'openid', NULL, 20, NULL);
    INSERT INTO device_grants (id, device_code_hash, user_code_hash, user_code_display, client_id, scope, status, user_id, created_at, expires_at, interval_seconds, last_poll_at, slow_down_count) VALUES
      ('expired-device', 'expired-device-hash', 'expired-user-hash', '', 'client', 'openid', 'pending', NULL, 1, 2, 5, NULL, 0),
      ('live-device', 'live-device-hash', 'live-user-hash', '', 'client', 'openid', 'pending', NULL, 1, 20, 5, NULL, 0);
    INSERT INTO refresh_token_families (id, user_id, client_id, status, created_at) VALUES
      ('expired-family', 'user', 'client', 'active', -4000),
      ('live-family', 'user', 'client', 'active', 1);
    INSERT INTO refresh_tokens (id, family_id, token_hash, user_id, client_id, scope, expires_at, used_at, revoked_at) VALUES
      ('expired-token', 'expired-family', 'expired-token-hash', 'user', 'client', 'openid', 2, NULL, NULL),
      ('live-token', 'live-family', 'live-token-hash', 'user', 'client', 'openid', 20, NULL, NULL);
    INSERT INTO revoked_access_tokens (jti, expires_at, revoked_at) VALUES
      ('expired-jti', 2, 1),
      ('live-jti', 20, 1);
    INSERT INTO audit_events (type, data_json, created_at) VALUES
      ('expired-audit', '{}', -8000000),
      ('live-audit', '{}', 9);
    INSERT INTO rate_limit_counters (key, count, window_start) VALUES
      ('expired-counter', 1, -100000),
      ('live-counter', 1, 9);
  `);
  const cleanup = await new D1AuthStore(database.d1).cleanup(10);
  assert.deepEqual(cleanup["authorization-requests"], {
    status: "verified",
    deletedCount: 500,
    limit: 500,
  });
  assert.deepEqual(cleanup["authorization-codes"], {
    status: "verified",
    deletedCount: 1,
    limit: 500,
  });
  assert.equal(
    Number(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM authorization_requests")
        .get()?.count,
    ),
    50,
  );
  assert.deepEqual(
    database.sqlite
      .prepare("SELECT code_hash FROM authorization_codes ORDER BY code_hash")
      .all()
      .map((row) => row.code_hash),
    ["live-code"],
  );
  assert.deepEqual(
    database.sqlite
      .prepare("SELECT id FROM device_grants ORDER BY id")
      .all()
      .map((row) => row.id),
    ["live-device"],
  );
  assert.deepEqual(
    database.sqlite
      .prepare("SELECT id FROM refresh_token_families ORDER BY id")
      .all()
      .map((row) => row.id),
    ["live-family"],
  );
  assert.deepEqual(
    database.sqlite
      .prepare("SELECT id FROM refresh_tokens ORDER BY id")
      .all()
      .map((row) => row.id),
    ["live-token"],
  );
  assert.deepEqual(
    database.sqlite
      .prepare("SELECT jti FROM revoked_access_tokens ORDER BY jti")
      .all()
      .map((row) => row.jti),
    ["live-jti"],
  );
  assert.deepEqual(
    database.sqlite
      .prepare("SELECT type FROM audit_events ORDER BY type")
      .all()
      .map((row) => row.type),
    ["live-audit"],
  );
  assert.deepEqual(
    database.sqlite
      .prepare("SELECT key FROM rate_limit_counters ORDER BY key")
      .all()
      .map((row) => row.key),
    ["live-counter"],
  );
  database.sqlite.close();
});

test("every bounded D1 cleanup query has an explicit deterministic order", async () => {
  const database = await migratedDatabase();
  const prepared: string[] = [];
  const observedD1: D1Database = {
    prepare(query: string): D1PreparedStatement {
      prepared.push(query);
      return database.d1.prepare(query);
    },
  };

  await new D1AuthStore(observedD1).cleanup(10_000_000);

  const cleanupQueries = prepared.filter((query) =>
    query.startsWith("DELETE FROM"),
  );
  assert.equal(cleanupQueries.length, 10);
  for (const pattern of [
    /DELETE FROM storage_file_write_fences .* ORDER BY fence\.expires_at ASC, fence\.r2_key ASC LIMIT \?\)/,
    /DELETE FROM authorization_codes .* ORDER BY expires_at ASC, rowid ASC LIMIT \?\)/,
    /DELETE FROM authorization_requests .* ORDER BY ar\.expires_at ASC, ar\.rowid ASC LIMIT \?\)/,
    /DELETE FROM device_grants .* ORDER BY expires_at ASC, rowid ASC LIMIT \?\)/,
    /DELETE FROM refresh_tokens .* ORDER BY expires_at ASC, rowid ASC LIMIT \?\)/,
    /DELETE FROM refresh_token_families .* ORDER BY rtf\.created_at ASC, rtf\.rowid ASC LIMIT \?\)/,
    /DELETE FROM revoked_access_tokens .* ORDER BY expires_at ASC, rowid ASC LIMIT \?\)/,
    /DELETE FROM audit_events .* ORDER BY created_at ASC, rowid ASC LIMIT \?\)/,
    /DELETE FROM rate_limit_counters .* ORDER BY window_start ASC, rowid ASC LIMIT \?\)/,
    /DELETE FROM admin_operation_submissions .* ORDER BY expires_at ASC, rowid ASC LIMIT \?\)/,
  ]) {
    assert.equal(
      cleanupQueries.some((query) => pattern.test(query)),
      true,
      `Missing deterministic cleanup query matching ${pattern}`,
    );
  }
  database.sqlite.close();
});

test("D1 cleanup selects the oldest eligible 500 rows in every category", async (t) => {
  const now = 10_000_000;
  const cases = [
    {
      name: "authorization codes",
      insert: `
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501
        )
        INSERT INTO authorization_codes
          (code_hash, auth_request_id, client_id, redirect_uri, user_id, scope, nonce, expires_at, consumed_at)
        SELECT 'code-' || value, 'request-' || value, 'client', 'https://client.example/cb',
          'user', 'openid', NULL, value, NULL
        FROM sequence ORDER BY value DESC;
      `,
      select: "SELECT code_hash AS value FROM authorization_codes",
      expected: "code-501",
    },
    {
      name: "authorization requests",
      insert: `
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501
        )
        INSERT INTO authorization_requests
          (id, client_id, redirect_uri, scope, state, nonce, code_challenge, created_at, expires_at, user_id, status)
        SELECT 'request-' || value, 'client', 'https://client.example/cb', 'openid',
          NULL, NULL, 'challenge', 0, value, NULL, 'pending'
        FROM sequence ORDER BY value DESC;
      `,
      select: "SELECT id AS value FROM authorization_requests",
      expected: "request-501",
    },
    {
      name: "device grants",
      insert: `
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501
        )
        INSERT INTO device_grants
          (id, device_code_hash, user_code_hash, user_code_display, client_id, scope, status,
           user_id, created_at, expires_at, interval_seconds, last_poll_at, slow_down_count)
        SELECT 'grant-' || value, 'device-' || value, 'user-code-' || value, '', 'client',
          'openid', 'pending', NULL, 0, value, 5, NULL, 0
        FROM sequence ORDER BY value DESC;
      `,
      select: "SELECT id AS value FROM device_grants",
      expected: "grant-501",
    },
    {
      name: "refresh tokens",
      insert: `
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501
        )
        INSERT INTO refresh_token_families (id, user_id, client_id, status, created_at)
        SELECT 'family-' || value, 'user', 'client', 'active', ${now}
        FROM sequence ORDER BY value DESC;
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501
        )
        INSERT INTO refresh_tokens
          (id, family_id, token_hash, user_id, client_id, scope, expires_at, used_at, revoked_at)
        SELECT 'token-' || value, 'family-' || value, 'token-hash-' || value, 'user',
          'client', 'openid', value, NULL, NULL
        FROM sequence ORDER BY value DESC;
      `,
      select: "SELECT id AS value FROM refresh_tokens",
      expected: "token-501",
    },
    {
      name: "refresh-token families",
      insert: `
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501
        )
        INSERT INTO refresh_token_families (id, user_id, client_id, status, created_at)
        SELECT 'family-' || value, 'user', 'client', 'active', value
        FROM sequence ORDER BY value DESC;
      `,
      select: "SELECT id AS value FROM refresh_token_families",
      expected: "family-501",
    },
    {
      name: "revoked access-token identifiers",
      insert: `
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501
        )
        INSERT INTO revoked_access_tokens (jti, expires_at, revoked_at)
        SELECT 'jti-' || value, value, 0 FROM sequence ORDER BY value DESC;
      `,
      select: "SELECT jti AS value FROM revoked_access_tokens",
      expected: "jti-501",
    },
    {
      name: "audit events",
      insert: `
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501
        )
        INSERT INTO audit_events (type, data_json, created_at)
        SELECT 'audit-' || value, '{}', value FROM sequence ORDER BY value DESC;
      `,
      select: "SELECT type AS value FROM audit_events",
      expected: "audit-501",
    },
    {
      name: "rate-limit counters",
      insert: `
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501
        )
        INSERT INTO rate_limit_counters (key, count, window_start)
        SELECT 'counter-' || value, 1, value FROM sequence ORDER BY value DESC;
      `,
      select: "SELECT key AS value FROM rate_limit_counters",
      expected: "counter-501",
    },
    {
      name: "admin-operation submissions",
      insert: `
        INSERT INTO users (id, email, display_name, created_at, updated_at)
        VALUES ('user', 'cleanup@example.test', 'Cleanup User', 0, 0);
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501
        )
        INSERT INTO admin_operation_submissions
          (token_hash, user_id, created_at, expires_at, result_consumed_at)
        SELECT 'submission-' || value, 'user', 0, value, NULL
        FROM sequence ORDER BY value DESC;
      `,
      select: "SELECT token_hash AS value FROM admin_operation_submissions",
      expected: "submission-501",
    },
  ] as const;

  for (const cleanupCase of cases) {
    await t.test(cleanupCase.name, async () => {
      const database = await migratedDatabase();
      database.sqlite.exec(cleanupCase.insert);
      await new D1AuthStore(database.d1).cleanup(now);
      assert.deepEqual(
        database.sqlite
          .prepare(cleanupCase.select)
          .all()
          .map((row) => String(row.value)),
        [cleanupCase.expected],
      );
      database.sqlite.close();
    });
  }
});

test("refresh-family cleanup preserves new empty families for a grace period", async () => {
  const database = await migratedDatabase();
  database.sqlite.exec(
    "INSERT INTO refresh_token_families (id, user_id, client_id, status, created_at) VALUES ('new-family', 'user', 'client', 'active', 100)",
  );
  const d1Store = new D1AuthStore(database.d1);
  await d1Store.cleanup(100);
  assert.ok(
    database.sqlite
      .prepare("SELECT id FROM refresh_token_families WHERE id = 'new-family'")
      .get(),
  );
  await d1Store.cleanup(3_701);
  assert.equal(
    database.sqlite
      .prepare("SELECT id FROM refresh_token_families WHERE id = 'new-family'")
      .get(),
    undefined,
  );
  database.sqlite.close();

  const memoryStore = new MemoryAuthStore();
  memoryStore.families.set("new-family", {
    id: "new-family",
    userId: "user",
    clientId: "client",
    status: "active",
    createdAt: 100,
  });
  await memoryStore.cleanup(100);
  assert.equal(memoryStore.families.has("new-family"), true);
  await memoryStore.cleanup(3_701);
  assert.equal(memoryStore.families.has("new-family"), false);
});

test("security cleanup relationship queries use covering indexes", async () => {
  const database = await migratedDatabase();
  const authorizationPlan = database.sqlite
    .prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM authorization_codes WHERE auth_request_id = ? AND expires_at > ?",
    )
    .all("request", 10)
    .map((row) => String(row.detail))
    .join(" ");
  const refreshPlan = database.sqlite
    .prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM refresh_tokens WHERE family_id = ? AND expires_at > ?",
    )
    .all("family", 10)
    .map((row) => String(row.detail))
    .join(" ");
  assert.match(authorizationPlan, /idx_authorization_codes_request_expires/);
  assert.match(refreshPlan, /idx_refresh_tokens_family_expires/);
  database.sqlite.close();
});

test("the security migration scrubs persisted device user-code displays", async () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of [
    "0001_initial.sql",
    "0002_browser_session_client.sql",
    "0003_browser_session_openid.sql",
  ]) {
    sqlite.exec(
      await readFile(
        new URL(`../../db/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  }
  sqlite.exec(
    "INSERT INTO device_grants (id, device_code_hash, user_code_hash, user_code_display, client_id, scope, status, user_id, created_at, expires_at, interval_seconds, last_poll_at, slow_down_count) VALUES ('grant', 'device-hash', 'user-hash', 'ABCDEFGH', 'client', 'openid', 'pending', NULL, 1, 2, 5, NULL, 0)",
  );
  sqlite.exec(
    await readFile(
      new URL("../../db/migrations/0004_security_indexes.sql", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    sqlite
      .prepare("SELECT user_code_display FROM device_grants WHERE id = 'grant'")
      .get()?.user_code_display,
    "",
  );
  sqlite.close();
});

test("administrator subjects require canonical UUIDv4 configuration", async () => {
  const env = await testEnv();
  const subject = crypto.randomUUID();
  assert.deepEqual(
    loadConfig(
      { ...env, ADMIN_SUBJECTS: `${subject}, ${subject}` },
      env.ISSUER_URL!,
    ).adminSubjects,
    [subject],
  );
  assert.throws(
    () =>
      loadConfig(
        { ...env, ADMIN_SUBJECTS: "admin@example.test" },
        env.ISSUER_URL!,
      ),
    /ADMIN_SUBJECTS must contain canonical UUIDv4 values/,
  );
});

function record(
  userId: string,
  clientId: string,
  key: string,
  valueJson: string,
): StorageRecord {
  return {
    userId,
    clientId,
    key,
    valueJson,
    createdAt: 1,
    updatedAt: 1,
  };
}

function file(
  userId: string,
  clientId: string,
  key: string,
  size: number,
  updatedAt: number,
): StorageFileMetadata {
  return {
    userId,
    clientId,
    key,
    r2Key: `r2/${key}`,
    contentType: "application/octet-stream",
    size,
    sha256: key.padEnd(43, "x").slice(0, 43),
    createdAt: 1,
    updatedAt,
  };
}

async function migratedDatabase(): Promise<{
  sqlite: DatabaseSync;
  d1: D1Database;
}> {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of [
    "0001_initial.sql",
    "0002_browser_session_client.sql",
    "0003_browser_session_openid.sql",
    "0004_security_indexes.sql",
    "0005_admin_submission_results.sql",
    "0006_storage_file_orphan_repairs.sql",
    "0007_storage_file_orphan_repair_order.sql",
    "0008_account_deletion_jobs.sql",
    "0009_account_credential_purge.sql",
    "0010_account_deletion_finalization.sql",
  ]) {
    sqlite.exec(
      await readFile(
        new URL(`../../db/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  }
  return { sqlite, d1: sqliteD1(sqlite) };
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
