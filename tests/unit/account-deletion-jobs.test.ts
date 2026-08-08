import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import {
  ACCOUNT_DELETION_MAX_CLAIM_BATCH,
  ACCOUNT_DELETION_MAX_LEASE_SECONDS,
} from "../../src/store/account-deletion";
import { D1AuthStore } from "../../src/store/d1";
import { MemoryAuthStore } from "../../src/store/memory";
import type { AccountDeletionJob, AuthStore } from "../../src/types";

const UNKNOWN_SUBJECT = "00000000-0000-4000-8000-000000000000";

test("account deletion migration has one subject key and constrained states", async () => {
  const sqlite = await migratedDatabase();
  try {
    const columns = sqlite
      .prepare("PRAGMA table_info(account_deletion_jobs)")
      .all()
      .map((column) => String(column.name));
    assert.deepEqual(columns, [
      "subject",
      "state",
      "attempt",
      "available_at",
      "created_at",
      "updated_at",
      "completed_at",
    ]);
    assert.throws(
      () => sqlite.prepare("SELECT rowid FROM account_deletion_jobs").all(),
      /no such column: rowid/,
    );
    const indexes = sqlite
      .prepare("PRAGMA index_list(account_deletion_jobs)")
      .all()
      .map((index) => String(index.name));
    assert.ok(indexes.includes("idx_account_deletion_jobs_claimable"));

    assert.throws(
      () =>
        sqlite
          .prepare(
            "INSERT INTO account_deletion_jobs (subject, state, attempt, available_at, created_at, updated_at, completed_at) VALUES (?, 'unknown', 0, 1, 1, 1, NULL)",
          )
          .run(UNKNOWN_SUBJECT),
      /CHECK constraint failed/,
    );
    assert.throws(
      () =>
        sqlite
          .prepare(
            "INSERT INTO account_deletion_jobs (subject, state, attempt, available_at, created_at, updated_at, completed_at) VALUES (?, 'completed', 0, NULL, 1, 1, 1)",
          )
          .run(UNKNOWN_SUBJECT),
      /account_deletion_finalization_invalid/,
    );
  } finally {
    sqlite.close();
  }
});

test("D1 and memory start one idempotent subject job without extra identifiers", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        await assert.rejects(
          fixture.store.startAccountDeletionJob(UNKNOWN_SUBJECT, 10),
          /account_deletion_subject_not_found/,
        );
        const subject = await createSubject(fixture.store, adapter.name, 1);
        const starts = await Promise.all(
          Array.from({ length: 8 }, () =>
            fixture.store.startAccountDeletionJob(subject, 10),
          ),
        );
        assert.equal(starts.filter((start) => start.created).length, 1);
        for (const start of starts) {
          assert.deepEqual(start.job, starts[0]!.job);
        }
        assert.deepEqual(Object.keys(starts[0]!.job).sort(), [
          "attempt",
          "availableAt",
          "completedAt",
          "createdAt",
          "state",
          "subject",
          "updatedAt",
        ]);
        assert.deepEqual(starts[0]!.job, {
          subject,
          state: "pending",
          attempt: 0,
          availableAt: 10,
          createdAt: 10,
          updatedAt: 10,
          completedAt: null,
        });
        assert.equal(
          await fixture.store.getAccountDeletionJob(UNKNOWN_SUBJECT),
          null,
        );
        assert.deepEqual(
          await fixture.store.startAccountDeletionJob(subject, 999),
          { created: false, job: starts[0]!.job },
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("D1 and memory claim finite disjoint batches and reject invalid bounds", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const subjects: string[] = [];
        for (let index = 0; index < 8; index += 1) {
          const subject = await createSubject(
            fixture.store,
            adapter.name,
            index + 10,
          );
          subjects.push(subject);
          await fixture.store.startAccountDeletionJob(subject, 10 + index);
        }

        const claims = (
          await Promise.all(
            Array.from({ length: 4 }, () =>
              fixture.store.claimAccountDeletionJobs(100, 30, 2),
            ),
          )
        ).flat();
        assert.equal(claims.length, subjects.length);
        assert.equal(new Set(claims.map((job) => job.subject)).size, 8);
        assert.ok(
          claims.every(
            (job) =>
              job.state === "running" &&
              job.attempt === 1 &&
              job.availableAt === 130,
          ),
        );
        assert.deepEqual(
          await fixture.store.claimAccountDeletionJobs(100, 30, 2),
          [],
        );

        const extra = await createSubject(fixture.store, adapter.name, 99);
        await fixture.store.startAccountDeletionJob(extra, 101);
        await assert.rejects(
          fixture.store.claimAccountDeletionJobs(101, 30, 0),
          /account_deletion_claim_limit_invalid/,
        );
        await assert.rejects(
          fixture.store.claimAccountDeletionJobs(
            101,
            30,
            ACCOUNT_DELETION_MAX_CLAIM_BATCH + 1,
          ),
          /account_deletion_claim_limit_invalid/,
        );
        await assert.rejects(
          fixture.store.claimAccountDeletionJobs(101, 0, 1),
          /account_deletion_lease_invalid/,
        );
        await assert.rejects(
          fixture.store.claimAccountDeletionJobs(
            101,
            ACCOUNT_DELETION_MAX_LEASE_SECONDS + 1,
            1,
          ),
          /account_deletion_lease_invalid/,
        );
        assert.equal(
          (await fixture.store.getAccountDeletionJob(extra))?.state,
          "pending",
        );
      } finally {
        fixture.close();
      }
    });
  }
});

test("D1 and memory finalize only a clean exact live claim", async (t) => {
  for (const adapter of adapters()) {
    await t.test(adapter.name, async () => {
      const fixture = await adapter.create();
      try {
        const subjectA = await createSubject(fixture.store, adapter.name, 201);
        const subjectB = await createSubject(fixture.store, adapter.name, 202);
        await fixture.store.startAccountDeletionJob(subjectA, 10);
        await fixture.store.startAccountDeletionJob(subjectB, 11);
        const firstClaims = await fixture.store.claimAccountDeletionJobs(
          100,
          30,
          2,
        );
        const firstA = requiredJob(firstClaims, subjectA);
        const firstB = requiredJob(firstClaims, subjectB);

        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            UNKNOWN_SUBJECT,
            firstA.attempt,
            101,
          ),
          false,
        );
        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            subjectB,
            firstB.attempt + 1,
            101,
          ),
          false,
        );
        assert.equal(
          (await fixture.store.getAccountDeletionJob(subjectB))?.state,
          "running",
        );

        const secondClaims = await fixture.store.claimAccountDeletionJobs(
          130,
          30,
          2,
        );
        const secondA = requiredJob(secondClaims, subjectA);
        assert.equal(secondA.attempt, firstA.attempt + 1);
        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            subjectA,
            firstA.attempt,
            131,
          ),
          false,
        );
        assert.equal(
          await fixture.store.retryAccountDeletionJob(
            subjectA,
            firstA.attempt,
            131,
            140,
          ),
          false,
        );
        assert.equal(
          await fixture.store.retryAccountDeletionJob(
            subjectA,
            secondA.attempt,
            131,
            140,
          ),
          true,
        );
        assert.deepEqual(
          await fixture.store.claimAccountDeletionJobs(139, 30, 1),
          [],
        );
        const thirdA = requiredJob(
          await fixture.store.claimAccountDeletionJobs(140, 30, 1),
          subjectA,
        );
        assert.equal(thirdA.attempt, secondA.attempt + 1);
        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            subjectA,
            thirdA.attempt,
            141,
          ),
          true,
        );
        assert.equal(
          await fixture.store.finalizeAccountDeletion(
            subjectA,
            thirdA.attempt,
            142,
          ),
          true,
        );
        assert.equal(
          await fixture.store.retryAccountDeletionJob(
            subjectA,
            thirdA.attempt,
            142,
            150,
          ),
          false,
        );
        const completed = await fixture.store.getAccountDeletionJob(subjectA);
        assert.equal(completed?.state, "completed");
        assert.equal(completed?.availableAt, null);
        assert.equal(completed?.completedAt, 141);
        assert.equal(await fixture.store.getUser(subjectA), null);
        assert.ok(await fixture.store.getUser(subjectB));
        assert.equal(await fixture.store.countUsers(), 1);
        assert.deepEqual(
          await fixture.store.startAccountDeletionJob(subjectA, 999),
          { created: false, job: completed },
        );
      } finally {
        fixture.close();
      }
    });
  }
});

function adapters(): Array<{
  name: string;
  create: () => Promise<StoreFixture>;
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

interface StoreFixture {
  store: AuthStore;
  close: () => void;
}

async function createSubject(
  store: AuthStore,
  adapter: string,
  index: number,
): Promise<string> {
  const user = await store.findOrCreateUser(
    {
      email: `${adapter}-${index}@example.test`,
      fullName: null,
      displayName: `User ${index}`,
    },
    index,
  );
  return user.id;
}

function requiredJob(
  jobs: AccountDeletionJob[],
  subject: string,
): AccountDeletionJob {
  const job = jobs.find((candidate) => candidate.subject === subject);
  assert.ok(job);
  return job;
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
  const prepared = new WeakMap<
    D1PreparedStatement,
    { query: string; values: SQLInputValue[] }
  >();
  return {
    prepare(query: string): D1PreparedStatement {
      const execution = { query, values: [] as SQLInputValue[] };
      const statement: D1PreparedStatement = {
        bind(...nextValues: unknown[]): D1PreparedStatement {
          execution.values = nextValues as SQLInputValue[];
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
