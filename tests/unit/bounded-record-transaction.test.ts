import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import {
  BOUNDED_RECORD_MAX_TRANSACTION_BYTES,
  canonicalBoundedRecordTransaction,
  type BoundedRecordMutation,
  type BoundedRecordTransactionCommand,
  type BoundedRecordValue,
} from "../../src/bounded-record-protocol";
import {
  BOUNDED_RECORD_RECEIPT_DEFAULT_LIMITS,
  BOUNDED_RECORD_RECEIPT_DEFAULT_RETENTION_SECONDS,
  BOUNDED_RECORD_RECEIPT_MAX_RETENTION_SECONDS,
  BOUNDED_RECORD_RECEIPT_MIN_RETENTION_SECONDS,
  boundedRecordDeleteReceiptReserveLimits,
  parseBoundedStorageTransactionResult,
} from "../../src/bounded-record-transaction";
import { loadConfig } from "../../src/config";
import { sha256 } from "../../src/crypto";
import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  AuthStore,
  BoundedStorageReceiptLimits,
  BoundedStorageRecord,
  BoundedStorageTransactionOptions,
  ClientView,
  StorageLimits,
} from "../../src/types";
import { testEnv } from "../helpers";

const OPEN_LIMITS: StorageLimits = {
  writesEnabled: true,
  globalMaxItems: 10_000,
  globalMaxBytes: 1_000_000_000,
  userMaxItems: 10_000,
  userMaxBytes: 1_000_000_000,
  namespaceMaxItems: 10_000,
  namespaceMaxBytes: 1_000_000_000,
};

const OPEN_RECEIPT_LIMITS: BoundedStorageReceiptLimits = {
  globalMaxItems: 10_000,
  globalMaxBytes: 1_000_000_000,
  userMaxItems: 10_000,
  userMaxBytes: 1_000_000_000,
  namespaceMaxItems: 10_000,
  namespaceMaxBytes: 1_000_000_000,
};
const D1_MAX_BOUND_PARAMETERS = 100;
const D1_MAX_BOUND_VALUE_BYTES = 2_000_000;

test("bounded receipt retention configuration is finite and strict", async () => {
  const env = await testEnv();
  assert.equal(
    loadConfig(env, env.ISSUER_URL!).boundedRecordReceiptRetentionSeconds,
    BOUNDED_RECORD_RECEIPT_DEFAULT_RETENTION_SECONDS,
  );
  for (const value of [
    BOUNDED_RECORD_RECEIPT_MIN_RETENTION_SECONDS,
    BOUNDED_RECORD_RECEIPT_MAX_RETENTION_SECONDS,
  ]) {
    assert.equal(
      loadConfig(
        {
          ...env,
          BOUNDED_RECORD_RECEIPT_RETENTION_SECONDS: String(value),
        },
        env.ISSUER_URL!,
      ).boundedRecordReceiptRetentionSeconds,
      value,
    );
  }
  assert.throws(
    () =>
      loadConfig(
        {
          ...env,
          BOUNDED_RECORD_RECEIPT_RETENTION_SECONDS: String(
            BOUNDED_RECORD_RECEIPT_MIN_RETENTION_SECONDS - 1,
          ),
        },
        env.ISSUER_URL!,
      ),
    /BOUNDED_RECORD_RECEIPT_RETENTION_SECONDS must be at least 60/,
  );
  assert.throws(
    () =>
      loadConfig(
        {
          ...env,
          BOUNDED_RECORD_RECEIPT_RETENTION_SECONDS: String(
            BOUNDED_RECORD_RECEIPT_MAX_RETENTION_SECONDS + 1,
          ),
        },
        env.ISSUER_URL!,
      ),
    /BOUNDED_RECORD_RECEIPT_RETENTION_SECONDS must not exceed 604800/,
  );
});

test("bounded receipt admission configuration is independent and strict", async () => {
  const env = await testEnv();
  const independent = loadConfig(
    {
      ...env,
      STORAGE_GLOBAL_MAX_ITEMS: "1",
      STORAGE_GLOBAL_MAX_BYTES: "1",
      STORAGE_USER_MAX_ITEMS: "1",
      STORAGE_USER_MAX_BYTES: "1",
      STORAGE_NAMESPACE_MAX_ITEMS: "1",
      STORAGE_NAMESPACE_MAX_BYTES: "1",
    },
    env.ISSUER_URL!,
  );
  assert.deepEqual(
    independent.boundedRecordReceiptLimits,
    BOUNDED_RECORD_RECEIPT_DEFAULT_LIMITS,
  );

  const configured = loadConfig(
    {
      ...env,
      BOUNDED_RECORD_RECEIPT_GLOBAL_MAX_ITEMS: "101",
      BOUNDED_RECORD_RECEIPT_GLOBAL_MAX_BYTES: "102",
      BOUNDED_RECORD_RECEIPT_USER_MAX_ITEMS: "103",
      BOUNDED_RECORD_RECEIPT_USER_MAX_BYTES: "104",
      BOUNDED_RECORD_RECEIPT_NAMESPACE_MAX_ITEMS: "105",
      BOUNDED_RECORD_RECEIPT_NAMESPACE_MAX_BYTES: "106",
    },
    env.ISSUER_URL!,
  );
  assert.deepEqual(configured.boundedRecordReceiptLimits, {
    globalMaxItems: 101,
    globalMaxBytes: 102,
    userMaxItems: 103,
    userMaxBytes: 104,
    namespaceMaxItems: 105,
    namespaceMaxBytes: 106,
  });

  for (const name of [
    "BOUNDED_RECORD_RECEIPT_GLOBAL_MAX_ITEMS",
    "BOUNDED_RECORD_RECEIPT_GLOBAL_MAX_BYTES",
    "BOUNDED_RECORD_RECEIPT_USER_MAX_ITEMS",
    "BOUNDED_RECORD_RECEIPT_USER_MAX_BYTES",
    "BOUNDED_RECORD_RECEIPT_NAMESPACE_MAX_ITEMS",
    "BOUNDED_RECORD_RECEIPT_NAMESPACE_MAX_BYTES",
  ] as const) {
    assert.throws(() => loadConfig({ ...env, [name]: "0" }, env.ISSUER_URL!));
  }
  assert.throws(() =>
    loadConfig(
      {
        ...env,
        STORAGE_GLOBAL_MAX_ITEMS: String(
          Math.floor(Number.MAX_SAFE_INTEGER / 6) + 1,
        ),
      },
      env.ISSUER_URL!,
    ),
  );
});

test("receipt retention migration backfills and locks indexed expiry", async () => {
  const sqlite = await migratedDatabase(
    "0019_bounded_storage_transactions.sql",
  );
  try {
    sqlite.exec(
      "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('retention-user', 'retention@example.test', 'Retention', 1, 1); INSERT INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at) VALUES ('retention-client', 'public', 'Retention', NULL, NULL, 1);",
    );
    const hashes = ["a", "b", "c"].map((value) => value.repeat(43));
    sqlite
      .prepare(
        "INSERT INTO bounded_storage_transaction_receipts (user_id, client_id, operation_id_hash, request_hash, attempt_hash, mutation_count, result_json, result_bytes, status, created_at, committed_at) VALUES (?, ?, ?, ?, ?, 1, '[null]', 6, 'committed', 100, 100)",
      )
      .run("retention-user", "retention-client", ...hashes);
    sqlite.exec(
      await readFile(
        new URL(
          "../../db/migrations/0020_bounded_storage_transaction_receipt_retention.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    assert.equal(
      sqlite
        .prepare(
          "SELECT expires_at FROM bounded_storage_transaction_receipts WHERE user_id = 'retention-user'",
        )
        .get()?.expires_at,
      100 + BOUNDED_RECORD_RECEIPT_DEFAULT_RETENTION_SECONDS,
    );
    assert.throws(() =>
      sqlite
        .prepare(
          "INSERT INTO bounded_storage_transaction_receipts (user_id, client_id, operation_id_hash, request_hash, attempt_hash, mutation_count, result_json, result_bytes, status, created_at, committed_at) VALUES (?, ?, ?, ?, ?, 1, '[null]', 6, 'committed', 200, 200)",
        )
        .run(
          "retention-user",
          "retention-client",
          ...["d", "e", "f"].map((value) => value.repeat(43)),
        ),
    );
    sqlite
      .prepare(
        "INSERT INTO bounded_storage_transaction_receipts (user_id, client_id, operation_id_hash, request_hash, attempt_hash, mutation_count, result_json, result_bytes, status, created_at, committed_at, expires_at) VALUES (?, ?, ?, ?, ?, 1, '[null]', 6, 'pending', 200, NULL, 300)",
      )
      .run(
        "retention-user",
        "retention-client",
        ...["g", "h", "i"].map((value) => value.repeat(43)),
      );
    assert.throws(() =>
      sqlite.exec(
        `UPDATE bounded_storage_transaction_receipts SET status = 'committed', committed_at = 200, expires_at = 301 WHERE operation_id_hash = '${"g".repeat(43)}'`,
      ),
    );
    sqlite.exec(
      `UPDATE bounded_storage_transaction_receipts SET status = 'committed', committed_at = 200 WHERE operation_id_hash = '${"g".repeat(43)}'`,
    );
    assert.equal(
      sqlite
        .prepare(
          `SELECT expires_at FROM bounded_storage_transaction_receipts WHERE operation_id_hash = '${"g".repeat(43)}'`,
        )
        .get()?.expires_at,
      300,
    );
    const plan = sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT user_id, client_id, operation_id_hash FROM bounded_storage_transaction_receipts WHERE expires_at <= ? ORDER BY expires_at ASC, created_at ASC, user_id ASC, client_id ASC, operation_id_hash ASC LIMIT ?",
      )
      .all(100_000, 500)
      .map((row) => String(row.detail))
      .join(" ");
    assert.match(plan, /idx_bounded_transaction_receipts_expiry_order/);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    sqlite.close();
  }
});

test("receipt admission migration backfills and locks indexed classes", async () => {
  const sqlite = await migratedDatabase(
    "0020_bounded_storage_transaction_receipt_retention.sql",
  );
  try {
    sqlite.exec(
      "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('admission-user', 'admission@example.test', 'Admission', 1, 1); INSERT INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at) VALUES ('admission-client', 'public', 'Admission', NULL, NULL, 1);",
    );
    sqlite
      .prepare(
        "INSERT INTO bounded_storage_transaction_receipts (user_id, client_id, operation_id_hash, request_hash, attempt_hash, mutation_count, result_json, result_bytes, status, created_at, committed_at, expires_at) VALUES (?, ?, ?, ?, ?, 1, '[null]', 6, 'pending', 100, NULL, 200)",
      )
      .run(
        "admission-user",
        "admission-client",
        ...["j", "k", "l"].map((value) => value.repeat(43)),
      );
    sqlite
      .prepare(
        "INSERT INTO bounded_storage_transaction_receipts (user_id, client_id, operation_id_hash, request_hash, attempt_hash, mutation_count, result_json, result_bytes, status, created_at, committed_at, expires_at) VALUES (?, ?, ?, ?, ?, 1, '[null]', 6, 'committed', 101, 101, 201)",
      )
      .run(
        "admission-user",
        "admission-client",
        ...["p", "q", "r"].map((value) => value.repeat(43)),
      );
    sqlite.exec(
      await readFile(
        new URL(
          "../../db/migrations/0021_bounded_storage_transaction_receipt_admission.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT admission_class FROM bounded_storage_transaction_receipts ORDER BY created_at ASC",
        )
        .all()
        .map((row) => row.admission_class),
      ["ordinary", "ordinary"],
    );
    assert.throws(() =>
      sqlite
        .prepare(
          "INSERT INTO bounded_storage_transaction_receipts (user_id, client_id, operation_id_hash, request_hash, attempt_hash, mutation_count, result_json, result_bytes, status, created_at, committed_at, expires_at, admission_class) VALUES (?, ?, ?, ?, ?, 1, '[null]', 6, 'pending', 101, NULL, 201, 'invalid')",
        )
        .run(
          "admission-user",
          "admission-client",
          ...["m", "n", "o"].map((value) => value.repeat(43)),
        ),
    );
    assert.throws(() =>
      sqlite.exec(
        `UPDATE bounded_storage_transaction_receipts SET status = 'committed', committed_at = 100, admission_class = 'delete-reserve' WHERE operation_id_hash = '${"j".repeat(43)}'`,
      ),
    );
    sqlite.exec(
      `UPDATE bounded_storage_transaction_receipts SET status = 'committed', committed_at = 100 WHERE operation_id_hash = '${"j".repeat(43)}'`,
    );
    for (const query of [
      "EXPLAIN QUERY PLAN SELECT COUNT(*), COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'ordinary'",
      "EXPLAIN QUERY PLAN SELECT COUNT(*), COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'ordinary' AND user_id = 'admission-user'",
      "EXPLAIN QUERY PLAN SELECT COUNT(*), COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'ordinary' AND user_id = 'admission-user' AND client_id = 'admission-client'",
    ]) {
      const plan = sqlite
        .prepare(query)
        .all()
        .map((row) => String(row.detail))
        .join(" ");
      assert.match(plan, /idx_bounded_transaction_receipts_admission_scope/);
    }
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    sqlite.close();
  }
});

test("receipt collection-name migration backfills and locks maintenance metadata", async () => {
  const sqlite = await migratedDatabase(
    "0021_bounded_storage_transaction_receipt_admission.sql",
  );
  try {
    sqlite.exec(
      "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('maintenance-user', 'maintenance@example.test', 'Maintenance', 1, 1); INSERT INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at) VALUES ('maintenance-client', 'public', 'Maintenance', NULL, NULL, 1);",
    );
    for (const [operation, resultJson] of [
      ["s", "[null]"],
      [
        "v",
        '[{"key":{"collection":"proof-0123456789abcdef01234567-records","id":"record"},"revision":1,"value":{}}]',
      ],
    ] as const) {
      sqlite
        .prepare(
          "INSERT INTO bounded_storage_transaction_receipts (user_id, client_id, operation_id_hash, request_hash, attempt_hash, mutation_count, result_json, result_bytes, status, created_at, committed_at, expires_at, admission_class) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'pending', 100, NULL, 200, 'ordinary')",
        )
        .run(
          "maintenance-user",
          "maintenance-client",
          ...[operation, "t", "u"].map((value) => value.repeat(43)),
          resultJson,
          new TextEncoder().encode(resultJson).byteLength,
        );
    }
    sqlite.exec(
      await readFile(
        new URL(
          "../../db/migrations/0022_bounded_storage_receipt_collection_names.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT collection_names_json FROM bounded_storage_transaction_receipts WHERE user_id = 'maintenance-user'",
        )
        .get()?.collection_names_json,
      "[]",
    );
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT operation_id_hash, collection FROM bounded_storage_transaction_receipt_collections ORDER BY operation_id_hash ASC",
        )
        .all()
        .map((row) => ({
          operation_id_hash: String(row.operation_id_hash),
          collection: String(row.collection),
        })),
      [
        {
          operation_id_hash: "v".repeat(43),
          collection: "proof-0123456789abcdef01234567-records",
        },
      ],
    );
    const receiptCollectionPlan = sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT operation_id_hash FROM bounded_storage_transaction_receipt_collections WHERE user_id = 'maintenance-user' AND client_id = 'maintenance-client' AND collection >= 'proof-0123456789abcdef01234567-' AND collection < 'proof-0123456789abcdef01234567.' LIMIT 2501",
      )
      .all()
      .map((row) => String(row.detail))
      .join(" ");
    assert.match(
      receiptCollectionPlan,
      /idx_bounded_receipt_collections_namespace/,
    );
    assert.throws(() =>
      sqlite.exec(
        `UPDATE bounded_storage_transaction_receipts SET status = 'committed', committed_at = 100, collection_names_json = '["proof-0123456789abcdef01234567-records"]' WHERE operation_id_hash = '${"s".repeat(43)}'`,
      ),
    );
    sqlite.exec(
      `UPDATE bounded_storage_transaction_receipts SET status = 'committed', committed_at = 100 WHERE operation_id_hash = '${"s".repeat(43)}'`,
    );
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    sqlite.close();
  }
});

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

        const receiptOne: BoundedStorageReceiptLimits = {
          globalMaxItems: 1,
          globalMaxBytes: 1_000,
          userMaxItems: 1,
          userMaxBytes: 1_000,
          namespaceMaxItems: 1,
          namespaceMaxBytes: 1_000,
        };
        const receiptOneOptions = {
          receiptRetentionSeconds:
            BOUNDED_RECORD_RECEIPT_DEFAULT_RETENTION_SECONDS,
          receiptLimits: receiptOne,
        };
        assert.equal(
          (
            await fixture.store.transactBoundedStorageRecords(
              owner,
              client.id,
              command("receipt-one", [check("items", "missing", null)]),
              OPEN_LIMITS,
              32,
              receiptOneOptions,
            )
          ).status,
          "created",
        );
        assert.deepEqual(
          await fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            command("receipt-two", [check("items", "missing", null)]),
            OPEN_LIMITS,
            33,
            receiptOneOptions,
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

test("independent receipt count and byte ceilings bind every scope", async (t) => {
  const cases = [
    { name: "deployment-count", field: "globalMaxItems", value: 1 },
    { name: "subject-count", field: "userMaxItems", value: 1 },
    { name: "namespace-count", field: "namespaceMaxItems", value: 1 },
    { name: "deployment-bytes", field: "globalMaxBytes", value: 5 },
    { name: "subject-bytes", field: "userMaxBytes", value: 5 },
    { name: "namespace-bytes", field: "namespaceMaxBytes", value: 5 },
  ] as const;
  for (const adapter of adapters()) {
    for (const limitCase of cases) {
      await t.test(`${adapter.name}-${limitCase.name}`, async () => {
        const fixture = await adapter.create();
        try {
          const firstOwner = await createSubject(
            fixture.store,
            `${adapter.name}-${limitCase.name}-first`,
          );
          const secondOwner = await createSubject(
            fixture.store,
            `${adapter.name}-${limitCase.name}-second`,
          );
          const firstClient = await createClient(
            fixture.store,
            `${adapter.name}-${limitCase.name}-first`,
          );
          const secondClient = await createClient(
            fixture.store,
            `${adapter.name}-${limitCase.name}-second`,
          );
          const receiptLimits = {
            ...OPEN_RECEIPT_LIMITS,
            [limitCase.field]: limitCase.value,
          };
          const options = transactionOptions(receiptLimits);
          const isByteCase = limitCase.name.endsWith("bytes");

          if (!isByteCase) {
            assert.equal(
              (
                await fixture.store.transactBoundedStorageRecords(
                  firstOwner,
                  firstClient.id,
                  command(`${limitCase.name}-first`, [
                    check("items", "missing-first", null),
                  ]),
                  OPEN_LIMITS,
                  1,
                  options,
                )
              ).status,
              "created",
            );
          }

          const target = limitCase.name.startsWith("deployment")
            ? { owner: secondOwner, clientId: secondClient.id }
            : limitCase.name.startsWith("subject")
              ? { owner: firstOwner, clientId: secondClient.id }
              : { owner: firstOwner, clientId: firstClient.id };
          assert.deepEqual(
            await fixture.store.transactBoundedStorageRecords(
              target.owner,
              target.clientId,
              command(`${limitCase.name}-rejected`, [
                check("items", "missing-rejected", null),
              ]),
              OPEN_LIMITS,
              2,
              options,
            ),
            { status: "quota_exceeded" },
          );
          assert.equal(
            (await fixture.receiptCount(firstOwner)) +
              (await fixture.receiptCount(secondOwner)),
            isByteCase ? 0 : 1,
          );
        } finally {
          fixture.close();
        }
      });
    }
  }
});

test("delete-only receipts use a finite isolated reserve", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(
          fixture.store,
          `${adapter.name}-delete-reserve`,
        );
        const client = await createClient(
          fixture.store,
          `${adapter.name}-delete-reserve`,
        );
        const storageLimits: StorageLimits = {
          ...OPEN_LIMITS,
          globalMaxItems: 3,
          userMaxItems: 3,
          namespaceMaxItems: 3,
        };
        const receiptLimits: BoundedStorageReceiptLimits = {
          globalMaxItems: 1,
          globalMaxBytes: 6,
          userMaxItems: 1,
          userMaxBytes: 6,
          namespaceMaxItems: 1,
          namespaceMaxBytes: 6,
        };
        const ordinaryOptions = {
          receiptRetentionSeconds: BOUNDED_RECORD_RECEIPT_MIN_RETENTION_SECONDS,
          receiptLimits,
        };
        const reserveOptions = {
          receiptRetentionSeconds: BOUNDED_RECORD_RECEIPT_MAX_RETENTION_SECONDS,
          receiptLimits,
        };
        for (const id of ["a", "b", "c"]) {
          await fixture.seed(record(owner, client.id, "items", id, 1));
        }
        assert.equal(
          (
            await fixture.store.transactBoundedStorageRecords(
              owner,
              client.id,
              command("fill-ordinary", [check("items", "missing", null)]),
              storageLimits,
              10,
              ordinaryOptions,
            )
          ).status,
          "created",
        );

        for (const [operationId, mutations] of [
          ["blocked-check", [check("items", "missing-2", null)]],
          [
            "blocked-put",
            [put("items", "new", null, { reserve: "not-ordinary" })],
          ],
          [
            "blocked-mixed",
            [check("items", "missing-3", null), remove("items", "a", 1)],
          ],
        ] as const) {
          assert.deepEqual(
            await fixture.store.transactBoundedStorageRecords(
              owner,
              client.id,
              command(operationId, mutations),
              storageLimits,
              11,
              ordinaryOptions,
            ),
            { status: "quota_exceeded" },
          );
        }
        assert.ok(
          await fixture.store.getBoundedStorageRecord(
            owner,
            client.id,
            "items",
            "a",
          ),
        );

        for (const [index, id] of ["a", "b", "c"].entries()) {
          assert.equal(
            (
              await fixture.store.transactBoundedStorageRecords(
                owner,
                client.id,
                command(`reserved-delete-${id}`, [remove("items", id, 1)]),
                storageLimits,
                20 + index,
                reserveOptions,
              )
            ).status,
            "created",
          );
        }
        assert.deepEqual(await fixture.receiptClasses(owner), [
          "delete-reserve",
          "delete-reserve",
          "delete-reserve",
          "ordinary",
        ]);

        assert.equal(
          (await fixture.store.cleanup(70))["bounded-transaction-receipts"]
            .deletedCount,
          1,
        );
        assert.deepEqual(await fixture.receiptClasses(owner), [
          "delete-reserve",
          "delete-reserve",
          "delete-reserve",
        ]);
        assert.deepEqual(
          await fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            command("blocked-recreate", [
              put("items", "d", null, { reserve: "still-retained" }),
            ]),
            storageLimits,
            80,
            reserveOptions,
          ),
          { status: "quota_exceeded" },
        );
        assert.equal(
          await fixture.store.getBoundedStorageRecord(
            owner,
            client.id,
            "items",
            "d",
          ),
          null,
        );

        await fixture.seed(record(owner, client.id, "items", "d", 1));
        assert.equal(
          (
            await fixture.store.transactBoundedStorageRecords(
              owner,
              client.id,
              command("lowered-limit-delete", [remove("items", "d", 1)]),
              storageLimits,
              81,
              reserveOptions,
            )
          ).status,
          "created",
        );
        assert.equal(
          await fixture.store.getBoundedStorageRecord(
            owner,
            client.id,
            "items",
            "d",
          ),
          null,
        );

        const firstDelete = command("reserved-delete-a", [
          remove("items", "a", 1),
        ]);
        assert.equal(
          (
            await fixture
              .reconstruct()
              .transactBoundedStorageRecords(
                owner,
                client.id,
                firstDelete,
                storageLimits,
                31,
                reserveOptions,
              )
          ).status,
          "replayed",
        );
        assert.deepEqual(
          await fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            command("reserved-delete-a", [remove("items", "d", 1)]),
            storageLimits,
            31,
            reserveOptions,
          ),
          { status: "conflict" },
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("competing receipt attempts re-evaluate ordinary and delete capacity", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(
          fixture.store,
          `${adapter.name}-receipt-concurrency`,
        );
        const client = await createClient(
          fixture.store,
          `${adapter.name}-receipt-concurrency`,
        );
        const storageLimits: StorageLimits = {
          ...OPEN_LIMITS,
          globalMaxItems: 2,
          userMaxItems: 2,
          namespaceMaxItems: 2,
        };
        const options = transactionOptions({
          globalMaxItems: 1,
          globalMaxBytes: 6,
          userMaxItems: 1,
          userMaxBytes: 6,
          namespaceMaxItems: 1,
          namespaceMaxBytes: 6,
        });
        const ordinaryResults = await Promise.all([
          fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            command("ordinary-race-one", [check("items", "missing-one", null)]),
            storageLimits,
            10,
            options,
          ),
          fixture
            .reconstruct()
            .transactBoundedStorageRecords(
              owner,
              client.id,
              command("ordinary-race-two", [
                check("items", "missing-two", null),
              ]),
              storageLimits,
              10,
              options,
            ),
        ]);
        assert.deepEqual(
          ordinaryResults.map((result) => result.status).sort(),
          ["created", "quota_exceeded"],
        );

        await fixture.seed(record(owner, client.id, "items", "a", 1));
        await fixture.seed(record(owner, client.id, "items", "b", 1));
        const deleteResults = await Promise.all([
          fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            command("reserve-race-a", [remove("items", "a", 1)]),
            storageLimits,
            20,
            options,
          ),
          fixture
            .reconstruct()
            .transactBoundedStorageRecords(
              owner,
              client.id,
              command("reserve-race-b", [remove("items", "b", 1)]),
              storageLimits,
              20,
              options,
            ),
        ]);
        assert.deepEqual(deleteResults.map((result) => result.status).sort(), [
          "created",
          "created",
        ]);
        assert.deepEqual(await fixture.receiptClasses(owner), [
          "delete-reserve",
          "delete-reserve",
          "ordinary",
        ]);
      } finally {
        fixture.close();
      }
    });
  }
});

test("asymmetric delete reserves bind deployment, subject, and namespace scopes", async (t) => {
  const scenarios = [
    {
      name: "namespace",
      itemLimits: { global: 10, user: 8, namespace: 2 },
      seeds: [{ owner: 0, client: 0, count: 2 }],
      blocked: { owner: 0, client: 0 },
      control: { owner: 0, client: 1 },
      usage: { owner: 0, client: 0, items: 2, bytes: 12 },
    },
    {
      name: "subject",
      itemLimits: { global: 10, user: 4, namespace: 3 },
      seeds: [
        { owner: 0, client: 0, count: 2 },
        { owner: 0, client: 1, count: 2 },
      ],
      blocked: { owner: 0, client: 0 },
      control: { owner: 1, client: 2 },
      usage: { owner: 0, items: 4, bytes: 24 },
    },
    {
      name: "deployment",
      itemLimits: { global: 6, user: 4, namespace: 3 },
      seeds: [
        { owner: 0, client: 0, count: 2 },
        { owner: 1, client: 1, count: 2 },
        { owner: 2, client: 2, count: 2 },
      ],
      blocked: { owner: 0, client: 0 },
      control: null,
      usage: { items: 6, bytes: 36 },
    },
  ] as const;

  for (const adapter of adapters()) {
    for (const scenario of scenarios) {
      await t.test(`${adapter.name}-${scenario.name}`, async () => {
        const fixture = await adapter.create();
        try {
          const owners = await Promise.all(
            [0, 1, 2].map((index) =>
              createSubject(
                fixture.store,
                `${adapter.name}-${scenario.name}-owner-${index}`,
              ),
            ),
          );
          const clients = await Promise.all(
            [0, 1, 2].map((index) =>
              createClient(
                fixture.store,
                `${adapter.name}-${scenario.name}-client-${index}`,
              ),
            ),
          );
          const storageLimits: StorageLimits = {
            ...OPEN_LIMITS,
            globalMaxItems: scenario.itemLimits.global,
            userMaxItems: scenario.itemLimits.user,
            namespaceMaxItems: scenario.itemLimits.namespace,
          };
          const receiptLimits: BoundedStorageReceiptLimits = {
            globalMaxItems: 1,
            globalMaxBytes: OPEN_RECEIPT_LIMITS.globalMaxBytes,
            userMaxItems: 1,
            userMaxBytes: OPEN_RECEIPT_LIMITS.userMaxBytes,
            namespaceMaxItems: 1,
            namespaceMaxBytes: OPEN_RECEIPT_LIMITS.namespaceMaxBytes,
          };
          const ordinaryOptions = {
            receiptRetentionSeconds:
              BOUNDED_RECORD_RECEIPT_MIN_RETENTION_SECONDS,
            receiptLimits,
          };
          const reserveOptions = {
            receiptRetentionSeconds:
              BOUNDED_RECORD_RECEIPT_MAX_RETENTION_SECONDS,
            receiptLimits,
          };
          assert.equal(
            (
              await fixture.store.transactBoundedStorageRecords(
                owners[0]!,
                clients[0]!.id,
                command(`${scenario.name}-ordinary`, [
                  check("items", "missing", null),
                ]),
                storageLimits,
                1,
                ordinaryOptions,
              )
            ).status,
            "created",
          );

          let ordinal = 0;
          for (const seed of scenario.seeds) {
            for (let index = 0; index < seed.count; index += 1) {
              const id = `${scenario.name}-${ordinal}`;
              const owner = owners[seed.owner]!;
              const clientId = clients[seed.client]!.id;
              await fixture.seed(record(owner, clientId, "items", id, 1));
              assert.equal(
                (
                  await fixture.store.transactBoundedStorageRecords(
                    owner,
                    clientId,
                    command(`${scenario.name}-delete-${ordinal}`, [
                      remove("items", id, 1),
                    ]),
                    storageLimits,
                    10 + ordinal,
                    reserveOptions,
                  )
                ).status,
                "created",
              );
              ordinal += 1;
            }
          }

          assert.deepEqual(
            await fixture.receiptUsage(
              "delete-reserve",
              !("owner" in scenario.usage)
                ? undefined
                : owners[scenario.usage.owner],
              !("client" in scenario.usage)
                ? undefined
                : clients[scenario.usage.client]!.id,
            ),
            {
              itemCount: scenario.usage.items,
              byteCount: scenario.usage.bytes,
            },
          );
          assert.equal(
            (await fixture.store.cleanup(61))["bounded-transaction-receipts"]
              .deletedCount,
            1,
          );
          assert.deepEqual(
            await fixture.store.transactBoundedStorageRecords(
              owners[scenario.blocked.owner]!,
              clients[scenario.blocked.client]!.id,
              command(`${scenario.name}-blocked-recreate`, [
                put("items", "blocked", null, { admitted: false }),
              ]),
              storageLimits,
              70,
              ordinaryOptions,
            ),
            { status: "quota_exceeded" },
          );
          if (scenario.control) {
            assert.equal(
              (
                await fixture.store.transactBoundedStorageRecords(
                  owners[scenario.control.owner]!,
                  clients[scenario.control.client]!.id,
                  command(`${scenario.name}-control-create`, [
                    put("items", "control", null, { admitted: true }),
                  ]),
                  storageLimits,
                  71,
                  ordinaryOptions,
                )
              ).status,
              "created",
            );
          }
        } finally {
          fixture.close();
        }
      });
    }
  }
});

test("a full delete batch consumes the exact finite reserve bytes", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(
          fixture.store,
          `${adapter.name}-delete-reserve-bytes`,
        );
        const client = await createClient(
          fixture.store,
          `${adapter.name}-delete-reserve-bytes`,
        );
        const storageLimits: StorageLimits = {
          ...OPEN_LIMITS,
          globalMaxItems: 25,
          userMaxItems: 25,
          namespaceMaxItems: 25,
        };
        assert.deepEqual(
          boundedRecordDeleteReceiptReserveLimits(storageLimits),
          {
            globalMaxItems: 25,
            globalMaxBytes: 150,
            userMaxItems: 25,
            userMaxBytes: 150,
            namespaceMaxItems: 25,
            namespaceMaxBytes: 150,
          },
        );
        const options = transactionOptions({
          globalMaxItems: 1,
          globalMaxBytes: 6,
          userMaxItems: 1,
          userMaxBytes: 6,
          namespaceMaxItems: 1,
          namespaceMaxBytes: 6,
        });
        assert.equal(
          (
            await fixture.store.transactBoundedStorageRecords(
              owner,
              client.id,
              command("fill-ordinary-for-batch", [
                check("items", "missing", null),
              ]),
              storageLimits,
              10,
              options,
            )
          ).status,
          "created",
        );
        const mutations: BoundedRecordMutation[] = [];
        for (let index = 0; index < 25; index += 1) {
          const id = `record-${index}`;
          await fixture.seed(record(owner, client.id, "items", id, 1));
          mutations.push(remove("items", id, 1));
        }
        assert.equal(
          (
            await fixture.store.transactBoundedStorageRecords(
              owner,
              client.id,
              command("delete-full-batch", mutations),
              storageLimits,
              20,
              options,
            )
          ).status,
          "created",
        );
        assert.deepEqual(
          await fixture.receiptResultBytes(owner, "delete-reserve"),
          [126],
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("committed idempotency receipts outrank write disablement", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(
          fixture.store,
          `${adapter.name}-write-switch-replay`,
        );
        const client = await createClient(
          fixture.store,
          `${adapter.name}-write-switch-replay`,
        );
        const original = command("write-switch-replay", [
          put("items", "record", null, { durable: true }),
        ]);
        const created = await fixture.store.transactBoundedStorageRecords(
          owner,
          client.id,
          original,
          OPEN_LIMITS,
          35,
        );
        assert.equal(created.status, "created");

        const disabled = { ...OPEN_LIMITS, writesEnabled: false };
        const replayed = await fixture
          .reconstruct()
          .transactBoundedStorageRecords(
            owner,
            client.id,
            original,
            disabled,
            36,
          );
        assert.equal(replayed.status, "replayed");
        if (created.status === "created" && replayed.status === "replayed") {
          assert.deepEqual(replayed.records, created.records);
        }
        assert.deepEqual(
          await fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            command("write-switch-replay", [
              put("items", "different", null, { durable: false }),
            ]),
            disabled,
            37,
          ),
          { status: "conflict" },
        );
        assert.deepEqual(
          await fixture.store.transactBoundedStorageRecords(
            owner,
            client.id,
            command("write-switch-new", [
              put("items", "new", null, { durable: false }),
            ]),
            disabled,
            38,
          ),
          { status: "unavailable" },
        );
        assert.equal(await fixture.receiptCount(owner), 1);
      } finally {
        fixture.close();
      }
    });
  }
});

test("receipt presence governs replay until bounded physical cleanup", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(
          fixture.store,
          `${adapter.name}-retention`,
        );
        const client = await createClient(
          fixture.store,
          `${adapter.name}-retention`,
        );
        const options = {
          receiptRetentionSeconds: BOUNDED_RECORD_RECEIPT_MIN_RETENTION_SECONDS,
          receiptLimits: OPEN_RECEIPT_LIMITS,
        };
        const original = command("retained-operation", [
          check("items", "missing", null),
        ]);
        assert.equal(
          (
            await fixture.store.transactBoundedStorageRecords(
              owner,
              client.id,
              original,
              OPEN_LIMITS,
              100,
              options,
            )
          ).status,
          "created",
        );
        assert.deepEqual(await fixture.receiptExpiries(owner), [160]);
        assert.equal(
          (await fixture.store.cleanup(159))["bounded-transaction-receipts"]
            .deletedCount,
          0,
        );
        assert.equal(
          (
            await fixture
              .reconstruct()
              .transactBoundedStorageRecords(
                owner,
                client.id,
                original,
                OPEN_LIMITS,
                161,
                options,
              )
          ).status,
          "replayed",
        );
        assert.equal(
          (
            await fixture.store.transactBoundedStorageRecords(
              owner,
              client.id,
              command("retained-operation", [
                check("items", "different", null),
              ]),
              OPEN_LIMITS,
              161,
              options,
            )
          ).status,
          "conflict",
        );

        assert.equal(
          (await fixture.store.cleanup(160))["bounded-transaction-receipts"]
            .deletedCount,
          1,
        );
        assert.equal(
          (
            await fixture.store.transactBoundedStorageRecords(
              owner,
              client.id,
              command("retained-operation", [
                check("items", "different", null),
              ]),
              OPEN_LIMITS,
              161,
              options,
            )
          ).status,
          "created",
        );
        assert.deepEqual(await fixture.receiptExpiries(owner), [221]);
      } finally {
        fixture.close();
      }
    });
  }
});

test("receipt cleanup removes at most 500 oldest expiries in Memory and D1", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(
          fixture.store,
          `${adapter.name}-retention-batch`,
        );
        const client = await createClient(
          fixture.store,
          `${adapter.name}-retention-batch`,
        );
        const options = {
          receiptRetentionSeconds: BOUNDED_RECORD_RECEIPT_MIN_RETENTION_SECONDS,
          receiptLimits: OPEN_RECEIPT_LIMITS,
        };
        for (let index = 0; index < 501; index += 1) {
          assert.equal(
            (
              await fixture.store.transactBoundedStorageRecords(
                owner,
                client.id,
                command(`cleanup-operation-${index}`, [
                  check("items", `missing-${index}`, null),
                ]),
                OPEN_LIMITS,
                index,
                options,
              )
            ).status,
            "created",
          );
        }

        const first = await fixture.store.cleanup(560);
        assert.deepEqual(first["bounded-transaction-receipts"], {
          status: "verified",
          deletedCount: 500,
          limit: 500,
        });
        assert.deepEqual(await fixture.receiptExpiries(owner), [560]);
        assert.equal(
          (await fixture.store.cleanup(560))["bounded-transaction-receipts"]
            .deletedCount,
          1,
        );
        assert.equal(
          (await fixture.store.cleanup(560))["bounded-transaction-receipts"]
            .deletedCount,
          0,
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

test("transaction preconditions bind both user and client namespace dimensions", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const owner = await createSubject(
          fixture.store,
          `${adapter.name}-owner`,
        );
        const otherUser = await createSubject(
          fixture.store,
          `${adapter.name}-other-user`,
        );
        const ownerClient = await createClient(
          fixture.store,
          `${adapter.name}-owner-client`,
        );
        const otherClient = await createClient(
          fixture.store,
          `${adapter.name}-other-client`,
        );
        await fixture.seed(
          record(owner, ownerClient.id, "items", "foreign", 1),
        );

        for (const [name, userId, clientId] of [
          ["same-user-other-client", owner, otherClient.id],
          ["other-user-same-client", otherUser, ownerClient.id],
        ] as const) {
          assert.deepEqual(
            await fixture.store.transactBoundedStorageRecords(
              userId,
              clientId,
              command(`${name}:check`, [check("items", "foreign", null)]),
              OPEN_LIMITS,
              50,
            ),
            { status: "created", records: [null] },
          );
          const created = await fixture.store.transactBoundedStorageRecords(
            userId,
            clientId,
            command(`${name}:put`, [
              put("items", "foreign", null, { namespace: name }),
            ]),
            OPEN_LIMITS,
            51,
          );
          assert.equal(created.status, "created");
          if (created.status !== "created") return;
          assert.deepEqual(created.records, [
            protocolRecord("items", "foreign", 1, { namespace: name }),
          ]);
        }

        const ownerRecord = await fixture.store.getBoundedStorageRecord(
          owner,
          ownerClient.id,
          "items",
          "foreign",
        );
        assert.equal(ownerRecord?.revision, 1);
        assert.equal(
          ownerRecord?.valueJson,
          JSON.stringify({ id: "foreign", revision: 1 }),
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
    const tx = command(
      "response-loss",
      Array.from({ length: 25 }, (_, index) =>
        put("items", `record-${index}`, null, { durable: index }),
      ),
    );
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
    const replayed = await fixture
      .reconstruct()
      .transactBoundedStorageRecords(owner, client.id, tx, OPEN_LIMITS, 51);
    assert.equal(replayed.status, "replayed");
    if (replayed.status === "replayed") {
      assert.equal(replayed.records.length, 25);
    }
    assert.equal(await fixture.receiptCount(owner), 1);
    assert.equal(fixture.controls.maxBatchStatements, 31);
    assert.ok(
      fixture.controls.maxObservedBoundParameters <= D1_MAX_BOUND_PARAMETERS,
    );
  } finally {
    fixture.close();
  }
});

test("D1 rolls records and receipt back after an injected mutation failure", async () => {
  const fixture = await createD1Fixture();
  try {
    const owner = await createSubject(fixture.store, "d1-rollback");
    const client = await createClient(fixture.store, "d1-rollback");
    fixture.controls.failBatchIndex = 26;
    assert.deepEqual(
      await fixture.store.transactBoundedStorageRecords(
        owner,
        client.id,
        command(
          "injected-failure",
          Array.from({ length: 25 }, (_, index) =>
            put("items", `record-${index}`, null, { stored: index }),
          ),
        ),
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
        "record-0",
      ),
      null,
    );
    assert.equal(
      await fixture.store.getBoundedStorageRecord(
        owner,
        client.id,
        "items",
        "record-24",
      ),
      null,
    );
  } finally {
    fixture.close();
  }
});

test("D1 final verification rejection rolls back records and the pending receipt", async () => {
  const fixture = await createD1Fixture();
  try {
    const owner = await createSubject(
      fixture.store,
      "d1-final-verifier-rollback",
    );
    const client = await createClient(
      fixture.store,
      "d1-final-verifier-rollback",
    );
    fixture.controls.skipBatchIndex = 3;
    assert.deepEqual(
      await fixture.store.transactBoundedStorageRecords(
        owner,
        client.id,
        command("d1-final-verifier-rollback", [
          put("items", "first", null, { stored: 1 }),
          put("items", "second", null, { stored: 2 }),
        ]),
        OPEN_LIMITS,
        65,
      ),
      { status: "unavailable" },
    );
    assert.equal(fixture.controls.abortPendingAttempts, 1);
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
    assert.equal(
      await fixture.store.getBoundedStorageRecord(
        owner,
        client.id,
        "items",
        "second",
      ),
      null,
    );
  } finally {
    fixture.close();
  }
});

test("D1 verification document shape fails closed before a receipt can commit", async () => {
  const fixture = await createD1Fixture();
  try {
    const owner = await createSubject(fixture.store, "d1-verifier-shape");
    const client = await createClient(fixture.store, "d1-verifier-shape");
    const overrides = [
      "[]",
      JSON.stringify([
        {
          type: "unknown",
          key: { collection: "items", id: "record" },
          expected_revision: null,
        },
      ]),
      JSON.stringify([
        {
          type: "put",
          key: { collection: "items", id: "record" },
          expected_revision: null,
        },
      ]),
    ];
    for (const [index, override] of overrides.entries()) {
      fixture.controls.commitVerificationOverride = override;
      assert.deepEqual(
        await fixture.store.transactBoundedStorageRecords(
          owner,
          client.id,
          command(`d1-verifier-shape-${index}`, [
            put("items", "record", null, { shape: index }),
          ]),
          OPEN_LIMITS,
          66 + index,
        ),
        { status: "unavailable" },
      );
      assert.equal(await fixture.receiptCount(owner), 0);
      assert.equal(
        await fixture.store.getBoundedStorageRecord(
          owner,
          client.id,
          "items",
          "record",
        ),
        null,
      );
    }
    assert.equal(fixture.controls.abortPendingAttempts, overrides.length);
  } finally {
    fixture.close();
  }
});

test("D1 accepts a near-limit escaped 25-entry transaction within its value limit", async () => {
  const fixture = await createD1Fixture();
  try {
    const owner = await createSubject(fixture.store, "d1-large-verifier");
    const client = await createClient(fixture.store, "d1-large-verifier");
    const escapedValue: BoundedRecordValue = {
      payload: '"'.repeat(20_800),
      unicode: "\u00e5".repeat(8),
    };
    const transaction = command(
      "d1-large-verifier",
      Array.from({ length: 25 }, (_, index) =>
        put("items", `record-${index}`, null, escapedValue),
      ),
    );
    const transactionBytes = new TextEncoder().encode(
      canonicalBoundedRecordTransaction(transaction),
    ).byteLength;
    assert.ok(transactionBytes > 900_000);
    assert.ok(transactionBytes <= BOUNDED_RECORD_MAX_TRANSACTION_BYTES);
    const legacyNestedVerifierBytes = new TextEncoder().encode(
      JSON.stringify(
        transaction.transaction.mutations.map((mutation) => ({
          type: mutation.type,
          key: mutation.key,
          expected_revision: mutation.expected_revision,
          value_json:
            mutation.type === "put" ? JSON.stringify(mutation.value) : null,
        })),
      ),
    ).byteLength;
    assert.ok(legacyNestedVerifierBytes > D1_MAX_BOUND_VALUE_BYTES);

    const created = await fixture.store.transactBoundedStorageRecords(
      owner,
      client.id,
      transaction,
      OPEN_LIMITS,
      69,
    );
    assert.equal(created.status, "created");
    if (created.status === "created") assert.equal(created.records.length, 25);
    assert.ok(
      fixture.controls.maxObservedBoundValueBytes >= transactionBytes - 256,
    );
    assert.ok(
      fixture.controls.maxObservedBoundValueBytes <= D1_MAX_BOUND_VALUE_BYTES,
    );
  } finally {
    fixture.close();
  }
});

test("D1 completes every 25-entry final-state verification shape within platform limits", async () => {
  const fixture = await createD1Fixture();
  try {
    const owner = await createSubject(fixture.store, "d1-parameter-boundary");
    const client = await createClient(fixture.store, "d1-parameter-boundary");
    const initialValues = Array.from(
      { length: 25 },
      (_, index): BoundedRecordValue =>
        index === 0
          ? {
              z: { first: "Nordic \u00e5", second: [true, null, 0.1] },
              a: { second: 2, first: 1 },
            }
          : { ordinal: index },
    );
    const create = command(
      "d1-parameter-create",
      initialValues.map((value, index) =>
        put("items", `record-${index}`, null, value),
      ),
    );
    const created = await fixture.store.transactBoundedStorageRecords(
      owner,
      client.id,
      create,
      OPEN_LIMITS,
      70,
    );
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    assert.equal(created.records.length, 25);
    assert.deepEqual(
      created.records[0],
      protocolRecord("items", "record-0", 1, initialValues[0]!),
    );

    const replayed = await fixture
      .reconstruct()
      .transactBoundedStorageRecords(owner, client.id, create, OPEN_LIMITS, 71);
    assert.deepEqual(replayed, {
      status: "replayed",
      records: created.records,
    });
    assert.deepEqual(
      await fixture.store.transactBoundedStorageRecords(
        owner,
        client.id,
        command("d1-parameter-create", [check("items", "record-0", 1)]),
        OPEN_LIMITS,
        72,
      ),
      { status: "conflict" },
    );

    const checked = await fixture.store.transactBoundedStorageRecords(
      owner,
      client.id,
      command(
        "d1-parameter-positive-check",
        Array.from({ length: 25 }, (_, index) =>
          check("items", `record-${index}`, 1),
        ),
      ),
      OPEN_LIMITS,
      73,
    );
    assert.equal(checked.status, "created");
    if (checked.status === "created") assert.equal(checked.records.length, 25);

    const replaced = await fixture.store.transactBoundedStorageRecords(
      owner,
      client.id,
      command(
        "d1-parameter-replace",
        Array.from({ length: 25 }, (_, index) =>
          put("items", `record-${index}`, 1, { replaced: index }),
        ),
      ),
      OPEN_LIMITS,
      74,
    );
    assert.equal(replaced.status, "created");
    if (replaced.status === "created") {
      assert.equal(replaced.records[0]?.revision, 2);
      assert.equal(replaced.records[24]?.revision, 2);
    }

    const absent = await fixture.store.transactBoundedStorageRecords(
      owner,
      client.id,
      command(
        "d1-parameter-absence-check",
        Array.from({ length: 25 }, (_, index) =>
          check("items", `missing-${index}`, null),
        ),
      ),
      OPEN_LIMITS,
      75,
    );
    assert.deepEqual(absent, {
      status: "created",
      records: Array(25).fill(null),
    });

    const deleted = await fixture.store.transactBoundedStorageRecords(
      owner,
      client.id,
      command(
        "d1-parameter-delete",
        Array.from({ length: 25 }, (_, index) =>
          remove("items", `record-${index}`, 2),
        ),
      ),
      OPEN_LIMITS,
      76,
    );
    assert.deepEqual(deleted, {
      status: "created",
      records: Array(25).fill(null),
    });

    const mixedChecks = Array.from(
      { length: 8 },
      (_, index) => `check-${index}`,
    );
    const mixedDeletes = Array.from(
      { length: 9 },
      (_, index) => `delete-${index}`,
    );
    for (const id of [...mixedChecks, ...mixedDeletes]) {
      await fixture.seed(record(owner, client.id, "mixed", id, 1));
    }
    const mixed = await fixture.store.transactBoundedStorageRecords(
      owner,
      client.id,
      command("d1-parameter-mixed", [
        ...Array.from({ length: 8 }, (_, index) =>
          put("mixed", `put-${index}`, null, { put: index }),
        ),
        ...mixedChecks.map((id) => check("mixed", id, 1)),
        ...mixedDeletes.map((id) => remove("mixed", id, 1)),
      ]),
      OPEN_LIMITS,
      77,
    );
    assert.equal(mixed.status, "created");
    if (mixed.status === "created") {
      assert.equal(mixed.records.length, 25);
      assert.equal(mixed.records[0]?.revision, 1);
      assert.equal(mixed.records[8]?.revision, 1);
      assert.equal(mixed.records[24], null);
    }
    assert.equal(fixture.controls.maxBatchStatements, 31);
    assert.ok(
      fixture.controls.maxObservedBoundParameters <= D1_MAX_BOUND_PARAMETERS,
    );
  } finally {
    fixture.close();
  }
});

test("D1 preflights 25-entry quota overflow and delete-funded puts without partial state", async () => {
  const fixture = await createD1Fixture();
  try {
    const owner = await createSubject(fixture.store, "d1-quota-boundary");
    const client = await createClient(fixture.store, "d1-quota-boundary");
    const limits: StorageLimits = {
      ...OPEN_LIMITS,
      globalMaxItems: 24,
      userMaxItems: 24,
      namespaceMaxItems: 24,
    };
    const overflow = await fixture.store.transactBoundedStorageRecords(
      owner,
      client.id,
      command(
        "d1-quota-overflow",
        Array.from({ length: 25 }, (_, index) =>
          put("items", `overflow-${index}`, null, { ordinal: index }),
        ),
      ),
      limits,
      80,
    );
    assert.deepEqual(overflow, { status: "quota_exceeded" });
    assert.equal(await fixture.receiptCount(owner), 0);
    assert.equal(
      await fixture.store.getBoundedStorageRecord(
        owner,
        client.id,
        "items",
        "overflow-0",
      ),
      null,
    );

    for (let index = 0; index < 24; index += 1) {
      await fixture.seed(record(owner, client.id, "items", `full-${index}`, 1));
    }
    const funded = await fixture.store.transactBoundedStorageRecords(
      owner,
      client.id,
      command("d1-quota-funded", [
        ...Array.from({ length: 12 }, (_, index) =>
          remove("items", `full-${index}`, 1),
        ),
        ...Array.from({ length: 12 }, (_, index) =>
          put("items", `replacement-${index}`, null, { ordinal: index }),
        ),
        check("items", "missing", null),
      ]),
      limits,
      81,
    );
    assert.equal(funded.status, "created");
    if (funded.status === "created") assert.equal(funded.records.length, 25);
    assert.equal(await fixture.receiptCount(owner), 1);
    assert.equal(fixture.controls.maxBatchStatements, 31);
    assert.ok(
      fixture.controls.maxObservedBoundParameters <= D1_MAX_BOUND_PARAMETERS,
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

test("acceptance maintenance removes only a bounded matching service namespace", async (t) => {
  const prefix = "proof-0123456789abcdef01234567-";
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const service = await fixture.store.createClient(
          {
            type: "service",
            name: `${adapter.name}-maintenance-owner`,
            redirectUris: [],
            scopes: ["storage.read", "storage.write", "storage.delete"],
            origins: [],
          },
          "synthetic-maintenance-owner-hash",
          1,
        );
        const outsider = await fixture.store.createClient(
          {
            type: "service",
            name: `${adapter.name}-maintenance-outsider`,
            redirectUris: [],
            scopes: ["storage.read"],
            origins: [],
          },
          "synthetic-maintenance-outsider-hash",
          1,
        );
        for (const [subject, client, collection, id, operationId] of [
          [
            service.id,
            service.id,
            `${prefix}records`,
            "target",
            "maintenance-target",
          ],
          [
            service.id,
            service.id,
            "unrelated-records",
            "retain",
            "maintenance-unrelated",
          ],
          [
            outsider.id,
            outsider.id,
            `${prefix}records`,
            "outsider",
            "maintenance-outsider",
          ],
        ] as const) {
          assert.equal(
            (
              await fixture.store.transactBoundedStorageRecords(
                subject,
                client,
                command(operationId, [
                  put(collection, id, null, { active: true }),
                ]),
                OPEN_LIMITS,
                20,
              )
            ).status,
            "created",
          );
        }
        assert.equal(
          (
            await fixture.store.transactBoundedStorageRecords(
              service.id,
              service.id,
              command("maintenance-mixed", [
                put(`${prefix}mixed`, "target", null, { active: true }),
                put("unrelated-records", "mixed", null, { active: true }),
              ]),
              OPEN_LIMITS,
              20,
            )
          ).status,
          "created",
        );
        assert.equal(await fixture.receiptCount(service.id), 3);
        const result =
          await fixture.store.purgeAcceptanceBoundedServiceNamespace(
            {
              serviceClientId: service.id,
              collectionPrefix: prefix,
            },
            maintenanceAudit(),
          );
        assert.deepEqual(result, {
          status: "completed",
          deletedRecords: 2,
          deletedReceipts: 1,
          remainingRecords: 0,
          remainingReceipts: 0,
        });
        assert.equal(
          await fixture.store.getBoundedStorageRecord(
            service.id,
            service.id,
            `${prefix}records`,
            "target",
          ),
          null,
        );
        assert.ok(
          await fixture.store.getBoundedStorageRecord(
            service.id,
            service.id,
            "unrelated-records",
            "retain",
          ),
        );
        assert.equal(
          await fixture.store.getBoundedStorageRecord(
            service.id,
            service.id,
            `${prefix}mixed`,
            "target",
          ),
          null,
        );
        assert.ok(
          await fixture.store.getBoundedStorageRecord(
            service.id,
            service.id,
            "unrelated-records",
            "mixed",
          ),
        );
        assert.ok(
          await fixture.store.getBoundedStorageRecord(
            outsider.id,
            outsider.id,
            `${prefix}records`,
            "outsider",
          ),
        );
        assert.equal(await fixture.receiptCount(service.id), 2);
        assert.equal(await fixture.receiptCount(outsider.id), 1);
      } finally {
        fixture.close();
      }
    });
  }
});

test("acceptance maintenance rejects an oversized candidate set without partial deletion", async () => {
  const fixture = await createD1Fixture();
  const prefix = "proof-fedcba9876543210fedcba98-";
  try {
    const service = await fixture.store.createClient(
      {
        type: "service",
        name: "d1-maintenance-bound",
        redirectUris: [],
        scopes: ["storage.read", "storage.write", "storage.delete"],
        origins: [],
      },
      "synthetic-maintenance-bound-hash",
      1,
    );
    for (let index = 0; index < 51; index += 1) {
      assert.equal(
        (
          await fixture.store.transactBoundedStorageRecords(
            service.id,
            service.id,
            command(`maintenance-bound-${index}`, [
              put(`${prefix}records`, `record-${index}`, null, { index }),
            ]),
            OPEN_LIMITS,
            30 + index,
          )
        ).status,
        "created",
      );
    }
    assert.deepEqual(
      await fixture.store.purgeAcceptanceBoundedServiceNamespace(
        {
          serviceClientId: service.id,
          collectionPrefix: prefix,
        },
        maintenanceAudit(),
      ),
      { status: "batch_too_large" },
    );
    assert.ok(
      await fixture.store.getBoundedStorageRecord(
        service.id,
        service.id,
        `${prefix}records`,
        "record-0",
      ),
    );
    assert.equal(await fixture.receiptCount(service.id), 51);
  } finally {
    fixture.close();
  }
});

test("D1 acceptance maintenance bounds record discovery before an oversized purge", async () => {
  const fixture = await createD1Fixture();
  const prefix = "proof-0123456789abcdef01234567-";
  try {
    const service = await fixture.store.createClient(
      {
        type: "service",
        name: "d1-maintenance-record-overflow",
        redirectUris: [],
        scopes: ["storage.read", "storage.write", "storage.delete"],
        origins: [],
      },
      "synthetic-maintenance-record-overflow-hash",
      1,
    );
    for (let index = 0; index <= 100; index += 1) {
      await fixture.seed(
        record(
          service.id,
          service.id,
          `${prefix}records`,
          `record-${index}`,
          1,
        ),
      );
    }
    assert.deepEqual(
      await fixture.store.purgeAcceptanceBoundedServiceNamespace(
        { serviceClientId: service.id, collectionPrefix: prefix },
        maintenanceAudit(),
      ),
      { status: "batch_too_large" },
    );
    assert.equal(fixture.auditCount(), 0);
    assert.ok(
      await fixture.store.getBoundedStorageRecord(
        service.id,
        service.id,
        `${prefix}records`,
        "record-0",
      ),
    );
  } finally {
    fixture.close();
  }
});

test("D1 acceptance maintenance bounds receipt-membership discovery before deletion", async () => {
  const fixture = await createD1Fixture();
  const prefix = "proof-89abcdef0123456789abcdef-";
  try {
    const service = await fixture.store.createClient(
      {
        type: "service",
        name: "d1-maintenance-receipt-membership-overflow",
        redirectUris: [],
        scopes: ["storage.read", "storage.write", "storage.delete"],
        origins: [],
      },
      "synthetic-maintenance-receipt-membership-overflow-hash",
      1,
    );
    fixture.seedReceiptMembershipOverflow(service.id, prefix);

    assert.deepEqual(
      await fixture.store.purgeAcceptanceBoundedServiceNamespace(
        { serviceClientId: service.id, collectionPrefix: prefix },
        maintenanceAudit(),
      ),
      { status: "batch_too_large" },
    );
    assert.equal(fixture.auditCount(), 0);
    assert.equal(await fixture.receiptCount(service.id), 100);
  } finally {
    fixture.close();
  }
});

test("D1 acceptance maintenance couples audit, deletion, and service-principal qualification", async () => {
  const fixture = await createD1Fixture();
  const prefix = "proof-abcdef0123456789abcdef01-";
  try {
    const service = await fixture.store.createClient(
      {
        type: "service",
        name: "d1-maintenance-atomic-audit",
        redirectUris: [],
        scopes: ["storage.read", "storage.write", "storage.delete"],
        origins: [],
      },
      "synthetic-maintenance-atomic-audit-hash",
      1,
    );
    assert.equal(
      (
        await fixture.store.transactBoundedStorageRecords(
          service.id,
          service.id,
          command("maintenance-atomic-audit", [
            put(`${prefix}records`, "target", null, { active: true }),
          ]),
          OPEN_LIMITS,
          20,
        )
      ).status,
      "created",
    );

    fixture.controls.failBatchIndex = 2;
    assert.deepEqual(
      await fixture.store.purgeAcceptanceBoundedServiceNamespace(
        { serviceClientId: service.id, collectionPrefix: prefix },
        maintenanceAudit(),
      ),
      { status: "unavailable" },
    );
    assert.equal(fixture.auditCount(), 0);
    assert.ok(
      await fixture.store.getBoundedStorageRecord(
        service.id,
        service.id,
        `${prefix}records`,
        "target",
      ),
    );

    fixture.setServicePrincipalType(service.id, "user");
    assert.deepEqual(
      await fixture.store.purgeAcceptanceBoundedServiceNamespace(
        { serviceClientId: service.id, collectionPrefix: prefix },
        maintenanceAudit(),
      ),
      { status: "unavailable" },
    );
    assert.equal(fixture.auditCount(), 0);
    assert.ok(
      await fixture.store.getBoundedStorageRecord(
        service.id,
        service.id,
        `${prefix}records`,
        "target",
      ),
    );

    fixture.setServicePrincipalType(service.id, "service");
    assert.equal(
      (
        await fixture.store.purgeAcceptanceBoundedServiceNamespace(
          { serviceClientId: service.id, collectionPrefix: prefix },
          maintenanceAudit(),
        )
      ).status,
      "completed",
    );
    assert.equal(fixture.auditCount(), 1);
    assert.equal(
      await fixture.store.getBoundedStorageRecord(
        service.id,
        service.id,
        `${prefix}records`,
        "target",
      ),
      null,
    );
  } finally {
    fixture.close();
  }
});

interface Fixture {
  store: AuthStore;
  seed(record: BoundedStorageRecord): Promise<void>;
  reconstruct(): AuthStore;
  receiptCount(subject: string): Promise<number>;
  receiptClasses(subject: string): Promise<string[]>;
  receiptUsage(
    admissionClass: string,
    subject?: string,
    clientId?: string,
  ): Promise<{ itemCount: number; byteCount: number }>;
  receiptResultBytes(
    subject: string,
    admissionClass: string,
  ): Promise<number[]>;
  receiptExpiries(subject: string): Promise<number[]>;
  hasPlaintextOperationId(operationId: string): Promise<boolean>;
  close(): void;
}

interface D1Controls {
  failBatchIndex: number | null;
  skipBatchIndex: number | null;
  commitVerificationOverride: string | null;
  throwAfterCommit: boolean;
  abortPendingAttempts: number;
  maxBatchStatements: number;
  maxObservedBoundParameters: number;
  maxObservedBoundValueBytes: number;
}

interface D1Fixture extends Fixture {
  controls: D1Controls;
  auditCount(): number;
  seedReceiptMembershipOverflow(
    serviceClientId: string,
    collectionPrefix: string,
  ): void;
  setServicePrincipalType(id: string, type: "user" | "service"): void;
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
          async receiptClasses(subject) {
            return Array.from(store.boundedStorageTransactionReceipts.values())
              .filter((receipt) => receipt.userId === subject)
              .map((receipt) => receipt.admissionClass)
              .sort();
          },
          async receiptUsage(admissionClass, subject, clientId) {
            const receipts = Array.from(
              store.boundedStorageTransactionReceipts.values(),
            ).filter(
              (receipt) =>
                receipt.admissionClass === admissionClass &&
                (subject === undefined || receipt.userId === subject) &&
                (clientId === undefined || receipt.clientId === clientId),
            );
            return {
              itemCount: receipts.length,
              byteCount: receipts.reduce(
                (total, receipt) => total + receipt.resultBytes,
                0,
              ),
            };
          },
          async receiptResultBytes(subject, admissionClass) {
            return Array.from(store.boundedStorageTransactionReceipts.values())
              .filter(
                (receipt) =>
                  receipt.userId === subject &&
                  receipt.admissionClass === admissionClass,
              )
              .map((receipt) => receipt.resultBytes)
              .sort((left, right) => left - right);
          },
          async receiptExpiries(subject) {
            return Array.from(store.boundedStorageTransactionReceipts.values())
              .filter((receipt) => receipt.userId === subject)
              .map((receipt) => receipt.expiresAt)
              .sort((left, right) => left - right);
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
    skipBatchIndex: null,
    commitVerificationOverride: null,
    throwAfterCommit: false,
    abortPendingAttempts: 0,
    maxBatchStatements: 0,
    maxObservedBoundParameters: 0,
    maxObservedBoundValueBytes: 0,
  };
  const d1 = sqliteD1(sqlite, controls);
  return {
    store: new D1AuthStore(d1),
    controls,
    auditCount: () =>
      Number(
        sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get()
          ?.count ?? 0,
      ),
    setServicePrincipalType: (id, type) => {
      sqlite
        .prepare("UPDATE users SET principal_type = ? WHERE id = ?")
        .run(type, id);
    },
    seedReceiptMembershipOverflow: (serviceClientId, collectionPrefix) => {
      const resultJson = JSON.stringify(Array.from({ length: 25 }, () => null));
      const resultBytes = new TextEncoder().encode(resultJson).byteLength;
      const insertReceipt = sqlite.prepare(
        "INSERT INTO bounded_storage_transaction_receipts (user_id, client_id, operation_id_hash, request_hash, attempt_hash, mutation_count, result_json, result_bytes, status, created_at, committed_at, expires_at, admission_class, collection_names_json) VALUES (?, ?, ?, ?, ?, 25, ?, ?, 'committed', 10, 10, 11, 'ordinary', '[]')",
      );
      const insertCollection = sqlite.prepare(
        "INSERT INTO bounded_storage_transaction_receipt_collections (user_id, client_id, operation_id_hash, collection) VALUES (?, ?, ?, ?)",
      );
      const operationHashes: string[] = [];
      for (let receiptIndex = 0; receiptIndex < 100; receiptIndex += 1) {
        const operationIdHash = `m${receiptIndex.toString(36).padStart(42, "0")}`;
        operationHashes.push(operationIdHash);
        insertReceipt.run(
          serviceClientId,
          serviceClientId,
          operationIdHash,
          "r".repeat(43),
          "t".repeat(43),
          resultJson,
          resultBytes,
        );
        for (
          let collectionIndex = 0;
          collectionIndex < 25;
          collectionIndex += 1
        ) {
          insertCollection.run(
            serviceClientId,
            serviceClientId,
            operationIdHash,
            `${collectionPrefix}receipt-${receiptIndex}-${collectionIndex}`,
          );
        }
      }
      // This test-only malformed extra map row proves the 2,501-row sentinel
      // rejects a corrupt or legacy receipt map before any candidate is deleted.
      insertCollection.run(
        serviceClientId,
        serviceClientId,
        operationHashes[0]!,
        `${collectionPrefix}overflow`,
      );
    },
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
    async receiptClasses(subject) {
      return sqlite
        .prepare(
          "SELECT admission_class FROM bounded_storage_transaction_receipts WHERE user_id = ? ORDER BY admission_class ASC, created_at ASC",
        )
        .all(subject)
        .map((row) => String(row.admission_class));
    },
    async receiptUsage(admissionClass, subject, clientId) {
      const row =
        subject === undefined
          ? sqlite
              .prepare(
                "SELECT COUNT(*) AS item_count, COALESCE(SUM(result_bytes), 0) AS byte_count FROM bounded_storage_transaction_receipts WHERE admission_class = ?",
              )
              .get(admissionClass)
          : clientId === undefined
            ? sqlite
                .prepare(
                  "SELECT COUNT(*) AS item_count, COALESCE(SUM(result_bytes), 0) AS byte_count FROM bounded_storage_transaction_receipts WHERE admission_class = ? AND user_id = ?",
                )
                .get(admissionClass, subject)
            : sqlite
                .prepare(
                  "SELECT COUNT(*) AS item_count, COALESCE(SUM(result_bytes), 0) AS byte_count FROM bounded_storage_transaction_receipts WHERE admission_class = ? AND user_id = ? AND client_id = ?",
                )
                .get(admissionClass, subject, clientId);
      return {
        itemCount: Number(row?.item_count ?? 0),
        byteCount: Number(row?.byte_count ?? 0),
      };
    },
    async receiptResultBytes(subject, admissionClass) {
      return sqlite
        .prepare(
          "SELECT result_bytes FROM bounded_storage_transaction_receipts WHERE user_id = ? AND admission_class = ? ORDER BY result_bytes ASC",
        )
        .all(subject, admissionClass)
        .map((row) => Number(row.result_bytes));
    },
    async receiptExpiries(subject) {
      return sqlite
        .prepare(
          "SELECT expires_at FROM bounded_storage_transaction_receipts WHERE user_id = ? ORDER BY expires_at ASC",
        )
        .all(subject)
        .map((row) => Number(row.expires_at));
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

function maintenanceAudit() {
  return { actorSubjectHash: "a".repeat(43), createdAt: 100 };
}

function transactionOptions(
  receiptLimits: Readonly<BoundedStorageReceiptLimits>,
): BoundedStorageTransactionOptions {
  return {
    receiptRetentionSeconds: BOUNDED_RECORD_RECEIPT_DEFAULT_RETENTION_SECONDS,
    receiptLimits,
  };
}

function put(
  collection: string,
  id: string,
  expectedRevision: number | null,
  value: BoundedRecordValue,
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
  value: BoundedRecordValue,
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

async function migratedDatabase(lastMigration?: string): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrationUrl = new URL("../../db/migrations/", import.meta.url);
  const names = (await readdir(migrationUrl))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of names) {
    if (lastMigration && name > lastMigration) break;
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
        controls.maxBatchStatements = Math.max(
          controls.maxBatchStatements,
          statements.length,
        );
        const results = statements.map((statement, index) => {
          if (controls.failBatchIndex === index) {
            controls.failBatchIndex = null;
            throw new Error("injected_batch_failure");
          }
          const execution = prepared.get(statement);
          assert.ok(execution);
          const values = [...execution.values];
          if (
            controls.commitVerificationOverride !== null &&
            execution.query.startsWith("\nWITH expected_state AS")
          ) {
            values[6] = controls.commitVerificationOverride;
            controls.commitVerificationOverride = null;
          }
          controls.maxObservedBoundParameters = Math.max(
            controls.maxObservedBoundParameters,
            values.length,
          );
          controls.maxObservedBoundValueBytes = Math.max(
            controls.maxObservedBoundValueBytes,
            ...values.map(d1BoundValueBytes),
          );
          if (values.length > D1_MAX_BOUND_PARAMETERS) {
            throw new Error("d1_bound_parameter_limit");
          }
          if (
            values.some(
              (value) => d1BoundValueBytes(value) > D1_MAX_BOUND_VALUE_BYTES,
            )
          ) {
            throw new Error("d1_bound_value_limit");
          }
          if (controls.skipBatchIndex === index) {
            controls.skipBatchIndex = null;
            return {
              success: true,
              meta: { changes: 0 },
            } as D1Result<T>;
          }
          if (execution.query.includes("committed_at = -1")) {
            controls.abortPendingAttempts += 1;
          }
          const sqliteStatement = database.prepare(execution.query);
          if (sqliteStatement.columns().length > 0) {
            return {
              success: true,
              results: sqliteStatement.all(...values) as T[],
              meta: { changes: 0 },
            } as D1Result<T>;
          }
          const result = sqliteStatement.run(...values);
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

function d1BoundValueBytes(value: SQLInputValue): number {
  if (typeof value === "string")
    return new TextEncoder().encode(value).byteLength;
  return value instanceof Uint8Array ? value.byteLength : 0;
}
