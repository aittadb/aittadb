import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { ACCOUNT_EVENT_PURGE_MAX_BATCH } from "../../src/store/account-event-purge";
import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  ApplicationEventInput,
  ApplicationEventLimits,
  AuthStore,
  ClientView,
  UpstreamIdentity,
} from "../../src/types";

const EVENT_LIMITS: ApplicationEventLimits = {
  globalMaxItems: 10_000,
  globalMaxBytes: 100_000_000,
  userMaxItems: 10_000,
  userMaxBytes: 100_000_000,
  namespaceMaxItems: 10_000,
  namespaceMaxBytes: 100_000_000,
};

test("D1 and memory purge only one human subject in bounded resumable batches", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const identity = userIdentity(`${adapter.name}-target`);
        const target = await fixture.store.findOrCreateUser(identity, 1);
        const other = await fixture.store.findOrCreateUser(
          userIdentity(`${adapter.name}-other`),
          2,
        );
        const firstClient = await createPublicClient(
          fixture.store,
          `${adapter.name}-first`,
          3,
        );
        const secondClient = await createPublicClient(
          fixture.store,
          `${adapter.name}-second`,
          4,
        );
        const service = await fixture.store.createClient(
          {
            type: "service",
            name: `${adapter.name} service`,
            redirectUris: [],
            scopes: ["events.publish", "events.read"],
            origins: [],
          },
          "s".repeat(43),
          5,
        );

        for (let index = 0; index < 7; index += 1) {
          assert.equal(
            (
              await fixture.store.appendApplicationEvent(
                eventInput(
                  target.id,
                  index % 2 === 0 ? firstClient.id : secondClient.id,
                  index + 1,
                ),
                EVENT_LIMITS,
              )
            ).status,
            "created",
          );
        }
        await append(fixture.store, other.id, firstClient.id, 101);
        await append(fixture.store, other.id, secondClient.id, 102);
        await append(fixture.store, service.id, service.id, 201);

        await fixture.store.startAccountDeletionJob(target.id, 100);
        const [claim] = await fixture.store.claimAccountDeletionJobs(
          100,
          30,
          1,
        );
        assert.ok(claim);

        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            target.id,
            claim.attempt,
            101,
          ),
          false,
        );
        await assert.rejects(
          fixture.store.purgeAccountEvents(
            target.id,
            claim.attempt + 1,
            101,
            3,
          ),
          /account_event_purge_unavailable/,
        );
        assert.deepEqual(
          await fixture.store.purgeAccountEvents(
            target.id,
            claim.attempt,
            101,
            3,
          ),
          { deletedCount: 3, done: false },
        );
        assert.equal(
          await fixture.store.retryAccountDeletionJob(
            target.id,
            claim.attempt,
            102,
            110,
          ),
          true,
        );
        await assert.rejects(
          fixture.store.purgeAccountEvents(target.id, claim.attempt, 103, 3),
          /account_event_purge_unavailable/,
        );

        const [retry] = await fixture.store.claimAccountDeletionJobs(
          110,
          30,
          1,
        );
        assert.ok(retry);
        assert.equal(retry.attempt, claim.attempt + 1);
        assert.deepEqual(
          await fixture.store.purgeAccountEvents(
            target.id,
            retry.attempt,
            111,
            3,
          ),
          { deletedCount: 3, done: false },
        );
        assert.deepEqual(
          await fixture.store.purgeAccountEvents(
            target.id,
            retry.attempt,
            112,
            3,
          ),
          { deletedCount: 1, done: true },
        );
        assert.deepEqual(
          await fixture.store.purgeAccountEvents(
            target.id,
            retry.attempt,
            113,
            3,
          ),
          { deletedCount: 0, done: true },
        );

        assert.equal(
          (
            await fixture.store.appendApplicationEvent(
              eventInput(target.id, firstClient.id, 301),
              EVENT_LIMITS,
            )
          ).status,
          "unavailable",
        );
        assert.equal(
          (
            await fixture.store.listApplicationEvents(
              target.id,
              firstClient.id,
              null,
              100,
            )
          ).items.length,
          0,
        );
        assert.equal(
          (
            await fixture.store.listApplicationEvents(
              target.id,
              secondClient.id,
              null,
              100,
            )
          ).items.length,
          0,
        );
        assert.equal(
          (
            await fixture.store.listApplicationEvents(
              other.id,
              firstClient.id,
              null,
              100,
            )
          ).items.length,
          1,
        );
        assert.equal(
          (
            await fixture.store.listApplicationEvents(
              other.id,
              secondClient.id,
              null,
              100,
            )
          ).items.length,
          1,
        );
        assert.equal(
          (
            await fixture.store.listApplicationEvents(
              service.id,
              service.id,
              null,
              100,
            )
          ).items.length,
          1,
        );
        await assert.rejects(
          fixture.store.startAccountDeletionJob(service.id, 114),
          /account_deletion_subject_not_found/,
        );

        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            target.id,
            retry.attempt,
            114,
          ),
          true,
        );
        const replacement = await fixture.store.findOrCreateUser(identity, 200);
        assert.notEqual(replacement.id, target.id);
        assert.equal(
          (
            await fixture.store.listApplicationEvents(
              replacement.id,
              firstClient.id,
              null,
              100,
            )
          ).items.length,
          0,
        );
        assert.equal(
          (
            await fixture.store.listApplicationEvents(
              other.id,
              firstClient.id,
              null,
              100,
            )
          ).items.length,
          1,
        );
        assert.equal(
          (
            await fixture.store.listApplicationEvents(
              service.id,
              service.id,
              null,
              100,
            )
          ).items.length,
          1,
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("event purge rejects invalid bounds and expired leases without mutation", async () => {
  const store = new MemoryAuthStore();
  const target = await store.findOrCreateUser(userIdentity("bounds"), 1);
  const client = await createPublicClient(store, "bounds", 2);
  await append(store, target.id, client.id, 1);
  await store.startAccountDeletionJob(target.id, 10);
  const [claim] = await store.claimAccountDeletionJobs(10, 5, 1);
  assert.ok(claim);

  for (const operation of [
    () => store.purgeAccountEvents("", claim.attempt, 11, 1),
    () => store.purgeAccountEvents("x".repeat(129), claim.attempt, 11, 1),
    () => store.purgeAccountEvents(target.id, 0, 11, 1),
    () => store.purgeAccountEvents(target.id, claim.attempt, -1, 1),
    () => store.purgeAccountEvents(target.id, claim.attempt, 11, 0),
    () =>
      store.purgeAccountEvents(
        target.id,
        claim.attempt,
        11,
        ACCOUNT_EVENT_PURGE_MAX_BATCH + 1,
      ),
  ]) {
    await assert.rejects(operation, /account_event_purge_.*_invalid/);
  }
  await assert.rejects(
    store.purgeAccountEvents(target.id, claim.attempt, 15, 1),
    /account_event_purge_unavailable/,
  );
  assert.equal(
    (await store.listApplicationEvents(target.id, client.id, null, 100)).items
      .length,
    1,
  );
});

test("D1 event purge rolls back a failed batch and resumes safely", async () => {
  const sqlite = await migratedDatabase();
  const store = new D1AuthStore(sqliteD1(sqlite));
  try {
    const target = await store.findOrCreateUser(userIdentity("failure"), 1);
    const client = await createPublicClient(store, "failure", 2);
    for (let index = 1; index <= 3; index += 1) {
      await append(store, target.id, client.id, index);
    }
    await store.startAccountDeletionJob(target.id, 10);
    const [claim] = await store.claimAccountDeletionJobs(10, 30, 1);
    assert.ok(claim);
    sqlite.exec(
      "CREATE TRIGGER fail_account_event_purge BEFORE DELETE ON application_events WHEN OLD.id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected_event_purge_failure'); END",
    );

    await assert.rejects(
      store.purgeAccountEvents(target.id, claim.attempt, 11, 3),
      /account_event_purge_failed/,
    );
    assert.equal(
      (await store.listApplicationEvents(target.id, client.id, null, 100)).items
        .length,
      3,
    );

    sqlite.exec("DROP TRIGGER fail_account_event_purge");
    assert.deepEqual(
      await store.purgeAccountEvents(target.id, claim.attempt, 12, 3),
      { deletedCount: 3, done: false },
    );
    assert.deepEqual(
      await store.purgeAccountEvents(target.id, claim.attempt, 13, 3),
      { deletedCount: 0, done: true },
    );
  } finally {
    sqlite.close();
  }
});

test("migration keeps the existing guard and blocks completion on event residue alone", async () => {
  const sqlite = await migratedDatabase();
  try {
    const store = new D1AuthStore(sqliteD1(sqlite));
    const target = await store.findOrCreateUser(userIdentity("guard"), 1);
    const client = await createPublicClient(store, "guard", 2);
    await append(store, target.id, client.id, 1);
    await store.startAccountDeletionJob(target.id, 10);
    const [claim] = await store.claimAccountDeletionJobs(10, 30, 1);
    assert.ok(claim);

    const triggers = sqlite
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND name IN ('trg_account_deletion_completion_clean', 'trg_account_deletion_completion_events_clean') ORDER BY name",
      )
      .all() as Array<{ name: string; sql: string }>;
    assert.deepEqual(
      triggers.map((trigger) => trigger.name),
      [
        "trg_account_deletion_completion_clean",
        "trg_account_deletion_completion_events_clean",
      ],
    );
    assert.match(triggers[1]!.sql, /application_events/);

    sqlite.exec("PRAGMA foreign_keys = OFF");
    sqlite.prepare("DELETE FROM users WHERE id = ?").run(target.id);
    assert.throws(
      () =>
        sqlite
          .prepare(
            "UPDATE account_deletion_jobs SET state = 'completed', available_at = NULL, completed_at = 11 WHERE subject = ?",
          )
          .run(target.id),
      /account_deletion_finalization_incomplete/,
    );
  } finally {
    sqlite.close();
  }
});

interface Fixture {
  store: AuthStore;
  close(): void;
}

function adapters(): Array<{
  name: "memory" | "d1";
  create(): Promise<Fixture>;
}> {
  return [
    {
      name: "memory",
      create: async () => ({
        store: new MemoryAuthStore(),
        close: () => undefined,
      }),
    },
    {
      name: "d1",
      create: async () => {
        const sqlite = await migratedDatabase();
        return {
          store: new D1AuthStore(sqliteD1(sqlite)),
          close: () => sqlite.close(),
        };
      },
    },
  ];
}

async function createPublicClient(
  store: AuthStore,
  prefix: string,
  now: number,
): Promise<ClientView> {
  return store.createClient(
    {
      type: "public",
      name: `${prefix} client`,
      redirectUris: [`https://${prefix}.example.test/callback`],
      scopes: ["events.publish", "events.read"],
      origins: [],
    },
    null,
    now,
  );
}

function userIdentity(prefix: string): UpstreamIdentity {
  return {
    email: `${prefix}@example.test`,
    fullName: `${prefix} user`,
    displayName: `${prefix} user`,
  };
}

async function append(
  store: AuthStore,
  userId: string,
  clientId: string,
  index: number,
): Promise<void> {
  assert.equal(
    (
      await store.appendApplicationEvent(
        eventInput(userId, clientId, index),
        EVENT_LIMITS,
      )
    ).status,
    "created",
  );
}

function eventInput(
  userId: string,
  clientId: string,
  index: number,
): ApplicationEventInput {
  const dataJson = JSON.stringify({ index });
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    userId,
    clientId,
    type: "example.changed",
    dataJson,
    dataBytes: Buffer.byteLength(dataJson),
    idempotencyKeyHash: null,
    requestHash: "r".repeat(43),
    createdAt: index + 1,
    expiresAt: index + 10_000,
  };
}

async function migratedDatabase(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrationUrl = new URL("../../db/migrations/", import.meta.url);
  const migrations = (await readdir(migrationUrl))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    sqlite.exec(await readFile(new URL(migration, migrationUrl), "utf8"));
  }
  return sqlite;
}

function sqliteD1(database: DatabaseSync): D1Database {
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
          const result = database
            .prepare(execution.query)
            .run(...execution.values);
          return {
            success: true,
            meta: { changes: Number(result.changes) },
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
