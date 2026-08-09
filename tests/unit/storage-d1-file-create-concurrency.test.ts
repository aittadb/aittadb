import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { nowSeconds, sha256 } from "../../src/crypto";
import type { AittaDBApp } from "../../src/handler";
import { createClientRegistration, issueTokens } from "../../src/oauth";
import { repairStorageFileOrphans } from "../../src/storage-orphan-repair";
import { D1AuthStore } from "../../src/store/d1";
import type { StorageFileMetadata } from "../../src/types";
import { createTestAittaDB, MemoryR2Bucket, testEnv } from "../helpers";

class CoordinatedBucket extends MemoryR2Bucket {
  failDeletes = false;
  readonly putKeys: string[] = [];
  private readonly deleteFailures = new Map<string, number>();
  private readonly deleteGates = new Map<
    string,
    { entered: () => void; promise: Promise<void> }
  >();
  private nextPutGate:
    | { entered: () => void; promise: Promise<void> }
    | undefined;
  private remainingPuts = 0;
  private putBarrier: Promise<void> = Promise.resolve();
  private releasePuts = (): void => undefined;

  blockNextPuts(count: number): void {
    this.remainingPuts = count;
    this.putBarrier = new Promise<void>((resolve) => {
      this.releasePuts = resolve;
    });
  }

  pauseNextPut(): { entered: Promise<void>; release: () => void } {
    let markEntered = (): void => undefined;
    let release = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextPutGate = { entered: markEntered, promise };
    return { entered, release };
  }

  pauseNextDelete(key: string): {
    entered: Promise<void>;
    release: () => void;
  } {
    let markEntered = (): void => undefined;
    let release = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.deleteGates.set(key, { entered: markEntered, promise });
    return { entered, release };
  }

  failDelete(key: string, attempts: number): void {
    this.deleteFailures.set(key, attempts);
  }

  override async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown> {
    this.putKeys.push(key);
    const nextPutGate = this.nextPutGate;
    if (nextPutGate) {
      this.nextPutGate = undefined;
      nextPutGate.entered();
      await nextPutGate.promise;
    }
    if (this.remainingPuts > 0) {
      this.remainingPuts -= 1;
      if (this.remainingPuts === 0) this.releasePuts();
      await this.putBarrier;
    }
    return super.put(key, value, options);
  }

  override async delete(key: string): Promise<void> {
    const gate = this.deleteGates.get(key);
    if (gate) {
      this.deleteGates.delete(key);
      gate.entered();
      await gate.promise;
    }
    if (this.failDeletes) throw new Error("injected_r2_delete_failure");
    const remaining = this.deleteFailures.get(key) ?? 0;
    if (remaining > 0) {
      this.deleteFailures.set(key, remaining - 1);
      throw new Error("injected_r2_delete_failure");
    }
    await super.delete(key);
  }
}

class CoordinatedD1AuthStore extends D1AuthStore {
  private nextDeleteGate:
    | { entered: () => void; promise: Promise<void> }
    | undefined;

  pauseNextDelete(): { entered: Promise<void>; release: () => void } {
    let markEntered = (): void => undefined;
    let release = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextDeleteGate = { entered: markEntered, promise };
    return { entered, release };
  }

  override async deleteStorageFileMetadata(
    userId: string,
    clientId: string,
    key: string,
    expectedR2Key: string,
  ): Promise<boolean> {
    const gate = this.nextDeleteGate;
    if (gate) {
      this.nextDeleteGate = undefined;
      gate.entered();
      await gate.promise;
    }
    return super.deleteStorageFileMetadata(
      userId,
      clientId,
      key,
      expectedR2Key,
    );
  }
}

interface Fixture {
  app: AittaDBApp;
  sqlite: DatabaseSync;
  store: CoordinatedD1AuthStore;
  bucket: CoordinatedBucket;
  userId: string;
  clientId: string;
  accessToken: string;
}

test("migrated D1 gives concurrent first file writes exactly one winner", async () => {
  const context = await fixture();
  try {
    const key = "production-shaped-create.txt";
    const bodies = Array.from(
      { length: 8 },
      (_, index) => `candidate-${index}`,
    );
    context.bucket.blockNextPuts(bodies.length);

    const responses = await Promise.all(
      bodies.map((body) => filePut(context, key, body)),
    );
    const winners = responses.filter((response) => response.status === 200);
    const losers = responses.filter((response) => response.status === 409);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, bodies.length - 1);

    const loserBodies = await Promise.all(
      losers.map((response) => response.text()),
    );
    assert.equal(new Set(loserBodies).size, 1);
    assert.match(loserBodies[0]!, /"error":"storage_conflict"/);
    for (const physicalKey of context.bucket.putKeys) {
      assert.equal(loserBodies[0]!.includes(physicalKey), false);
    }

    const metadata = await retainedMetadata(context, key);
    assert.equal(
      Number(
        context.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM storage_files WHERE user_id = ? AND client_id = ? AND key = ?",
          )
          .get(context.userId, context.clientId, key)?.count,
      ),
      1,
    );
    assert.equal(context.bucket.objects.size, 1);
    await assertMetadataMatchesBytes(context.bucket, metadata, bodies);
    assert.deepEqual(await context.store.listStorageFileOrphanRepairs(10), []);
  } finally {
    context.sqlite.close();
  }
});

test("a D1 create loser queues failed R2 retirement and TASK-119 converges", async () => {
  const context = await fixture();
  try {
    const key = "repairable-create-race.txt";
    const bodies = ["winning-or-losing-a", "winning-or-losing-b"];
    context.bucket.failDeletes = true;
    context.bucket.blockNextPuts(bodies.length);

    const responses = await Promise.all(
      bodies.map((body) => filePut(context, key, body)),
    );
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
    );
    const loser = responses.find((response) => response.status === 409);
    assert.ok(loser);
    const loserBody = await loser.text();
    assert.match(loserBody, /"error":"storage_conflict"/);

    const metadata = await retainedMetadata(context, key);
    await assertMetadataMatchesBytes(context.bucket, metadata, bodies);
    assert.equal(context.bucket.objects.size, 2);
    const repairs = await context.store.listStorageFileOrphanRepairs(10);
    assert.equal(repairs.length, 1);
    const repair = repairs[0]!;
    assert.equal(repair.userId, context.userId);
    assert.equal(repair.clientId, context.clientId);
    assert.notEqual(repair.r2Key, metadata.r2Key);
    assert.equal(context.bucket.objects.has(repair.r2Key), true);
    assert.equal(loserBody.includes(repair.r2Key), false);

    context.bucket.failDeletes = false;
    assert.deepEqual(
      await repairStorageFileOrphans(
        context.store,
        context.bucket,
        nowSeconds() + 1,
      ),
      { examined: 1, resolved: 1, deferred: 0 },
    );
    assert.deepEqual(await context.store.listStorageFileOrphanRepairs(10), []);
    assert.equal(context.bucket.objects.size, 1);
    await assertMetadataMatchesBytes(context.bucket, metadata, bodies);
  } finally {
    context.sqlite.close();
  }
});

test("migrated D1 gives concurrent replacements one winner and deterministic losers", async () => {
  const context = await fixture();
  try {
    const key = "production-shaped-replace.txt";
    assert.equal((await filePut(context, key, "initial")).status, 200);
    const initial = await retainedMetadata(context, key);
    const bodies = Array.from(
      { length: 8 },
      (_, index) => `replacement-${index}`,
    );
    context.bucket.blockNextPuts(bodies.length);

    const responses = await Promise.all(
      bodies.map((body) => filePut(context, key, body)),
    );
    const winners = responses.filter((response) => response.status === 200);
    const losers = responses.filter((response) => response.status === 409);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, bodies.length - 1);
    const loserBodies = await Promise.all(
      losers.map((response) => assertStorageConflict(response, context)),
    );
    assert.equal(new Set(loserBodies).size, 1);

    const retained = await retainedMetadata(context, key);
    assert.notEqual(retained.r2Key, initial.r2Key);
    assert.equal(context.bucket.objects.has(initial.r2Key), false);
    assert.equal(context.bucket.objects.size, 1);
    await assertMetadataMatchesBytes(context.bucket, retained, bodies);
    assert.deepEqual(await context.store.listStorageFileOrphanRepairs(10), []);
  } finally {
    context.sqlite.close();
  }
});

test("a stale D1 delete cannot remove a newer replacement", async () => {
  const context = await fixture();
  try {
    const key = "stale-delete.txt";
    assert.equal((await filePut(context, key, "initial")).status, 200);
    const initial = await retainedMetadata(context, key);
    const gate = context.store.pauseNextDelete();
    const staleDelete = fileDelete(context, key);
    await gate.entered;

    assert.equal((await filePut(context, key, "newer winner")).status, 200);
    gate.release();
    await assertStorageConflict(await staleDelete, context, [initial.r2Key]);

    const retained = await retainedMetadata(context, key);
    assert.notEqual(retained.r2Key, initial.r2Key);
    assert.equal(context.bucket.objects.has(initial.r2Key), false);
    assert.equal(context.bucket.objects.size, 1);
    await assertMetadataMatchesBytes(context.bucket, retained, [
      "newer winner",
    ]);
    assert.deepEqual(await context.store.listStorageFileOrphanRepairs(10), []);
  } finally {
    context.sqlite.close();
  }
});

test("a replacement that loses to delete queues failed loser retirement", async () => {
  const context = await fixture();
  try {
    const key = "stale-replacement-after-delete.txt";
    assert.equal((await filePut(context, key, "initial")).status, 200);
    const gate = context.bucket.pauseNextPut();
    const staleReplacement = filePut(context, key, "stale replacement");
    await gate.entered;
    const stalePhysicalKey = context.bucket.putKeys.at(-1);
    assert.ok(stalePhysicalKey);
    context.bucket.failDelete(stalePhysicalKey, 2);

    assert.equal((await fileDelete(context, key)).status, 200);
    gate.release();
    await assertStorageConflict(await staleReplacement, context, [
      stalePhysicalKey,
    ]);

    assert.equal(
      await context.store.getStorageFileMetadata(
        context.userId,
        context.clientId,
        key,
      ),
      null,
    );
    assert.equal(context.bucket.objects.size, 1);
    await assertQueuedRepair(context, stalePhysicalKey);

    context.bucket.failDelete(stalePhysicalKey, 0);
    await resolveQueuedRepair(context);
    assert.equal(context.bucket.objects.size, 0);
  } finally {
    context.sqlite.close();
  }
});

test("a failed replacement rollback preserves a newer D1 winner and queues old bytes", async () => {
  const context = await fixture();
  try {
    const key = "replacement-rollback-race.txt";
    assert.equal((await filePut(context, key, "initial bytes")).status, 200);
    const initial = await retainedMetadata(context, key);
    const gate = context.bucket.pauseNextDelete(initial.r2Key);
    context.bucket.failDelete(initial.r2Key, 4);

    const staleReplacement = filePut(context, key, "first replacement");
    await gate.entered;
    const firstReplacement = await retainedMetadata(context, key);
    assert.notEqual(firstReplacement.r2Key, initial.r2Key);

    assert.equal(
      (await filePut(context, key, "newer replacement")).status,
      200,
    );
    gate.release();
    await assertStorageConflict(await staleReplacement, context, [
      initial.r2Key,
      firstReplacement.r2Key,
    ]);

    const retained = await retainedMetadata(context, key);
    assert.notEqual(retained.r2Key, initial.r2Key);
    assert.notEqual(retained.r2Key, firstReplacement.r2Key);
    assert.equal(context.bucket.objects.has(firstReplacement.r2Key), false);
    assert.equal(context.bucket.objects.has(initial.r2Key), true);
    assert.equal(context.bucket.objects.size, 2);
    await assertMetadataMatchesBytes(context.bucket, retained, [
      "newer replacement",
    ]);
    await assertQueuedRepair(context, initial.r2Key);

    context.bucket.failDelete(initial.r2Key, 0);
    await resolveQueuedRepair(context);
    assert.equal(context.bucket.objects.size, 1);
    await assertMetadataMatchesBytes(context.bucket, retained, [
      "newer replacement",
    ]);
  } finally {
    context.sqlite.close();
  }
});

test("a failed delete rollback preserves a newer D1 winner and queues old bytes", async () => {
  const context = await fixture();
  try {
    const key = "delete-rollback-race.txt";
    assert.equal((await filePut(context, key, "initial bytes")).status, 200);
    const initial = await retainedMetadata(context, key);
    const gate = context.bucket.pauseNextDelete(initial.r2Key);
    context.bucket.failDelete(initial.r2Key, 4);

    const staleDelete = fileDelete(context, key);
    await gate.entered;
    assert.equal(
      await context.store.getStorageFileMetadata(
        context.userId,
        context.clientId,
        key,
      ),
      null,
    );
    assert.equal((await filePut(context, key, "newer winner")).status, 200);

    gate.release();
    await assertStorageConflict(await staleDelete, context, [initial.r2Key]);

    const retained = await retainedMetadata(context, key);
    assert.notEqual(retained.r2Key, initial.r2Key);
    assert.equal(context.bucket.objects.has(initial.r2Key), true);
    assert.equal(context.bucket.objects.size, 2);
    await assertMetadataMatchesBytes(context.bucket, retained, [
      "newer winner",
    ]);
    await assertQueuedRepair(context, initial.r2Key);

    context.bucket.failDelete(initial.r2Key, 0);
    await resolveQueuedRepair(context);
    assert.equal(context.bucket.objects.size, 1);
    await assertMetadataMatchesBytes(context.bucket, retained, [
      "newer winner",
    ]);
  } finally {
    context.sqlite.close();
  }
});

async function fixture(): Promise<Fixture> {
  const sqlite = await migratedDatabase();
  const database = sqliteD1(sqlite);
  const bucket = new CoordinatedBucket();
  const env = await testEnv({ DB: database, BUCKET: bucket });
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new CoordinatedD1AuthStore(database);
  const now = nowSeconds();
  const user = await store.findOrCreateUser(
    {
      email: "d1-file-owner@example.test",
      fullName: "D1 File Owner",
      displayName: "D1 File Owner",
    },
    now,
  );
  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "D1 file concurrency client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["storage.read", "storage.write", "storage.delete"],
      origins: [],
    },
    store,
    now,
  );
  const tokens = await issueTokens({
    config,
    store,
    user,
    client,
    scope: "storage.read storage.write storage.delete",
    includeRefresh: false,
    now,
  });
  return {
    app: createTestAittaDB(env, store),
    sqlite,
    store,
    bucket,
    userId: user.id,
    clientId: client.id,
    accessToken: String(tokens.access_token),
  };
}

async function filePut(
  context: Fixture,
  key: string,
  body: string,
): Promise<Response> {
  const response = await context.app.fetch(
    new Request(
      `https://aittadb.example.test/storage/files/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${context.accessToken}`,
          "content-type": "text/plain",
        },
        body,
      },
    ),
  );
  assert.ok(response);
  return response;
}

async function fileDelete(context: Fixture, key: string): Promise<Response> {
  const response = await context.app.fetch(
    new Request(
      `https://aittadb.example.test/storage/files/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${context.accessToken}`,
        },
      },
    ),
  );
  assert.ok(response);
  return response;
}

async function assertStorageConflict(
  response: Response,
  context: Fixture,
  forbiddenPhysicalKeys: string[] = [],
): Promise<string> {
  assert.equal(response.status, 409);
  const body = await response.text();
  assert.match(body, /"error":"storage_conflict"/);
  assert.match(
    body,
    /"error_description":"The file changed while this request was being processed"/,
  );
  assert.equal(body.includes(context.userId), false);
  assert.equal(body.includes(context.clientId), false);
  for (const physicalKey of forbiddenPhysicalKeys) {
    assert.equal(body.includes(physicalKey), false);
  }
  return body;
}

async function assertQueuedRepair(
  context: Fixture,
  expectedR2Key: string,
): Promise<void> {
  const repairs = await context.store.listStorageFileOrphanRepairs(10);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0]?.userId, context.userId);
  assert.equal(repairs[0]?.clientId, context.clientId);
  assert.equal(repairs[0]?.r2Key, expectedR2Key);
}

async function resolveQueuedRepair(context: Fixture): Promise<void> {
  assert.deepEqual(
    await repairStorageFileOrphans(
      context.store,
      context.bucket,
      nowSeconds() + 1,
    ),
    { examined: 1, resolved: 1, deferred: 0 },
  );
  assert.deepEqual(await context.store.listStorageFileOrphanRepairs(10), []);
}

async function retainedMetadata(
  context: Fixture,
  key: string,
): Promise<StorageFileMetadata> {
  const metadata = await context.store.getStorageFileMetadata(
    context.userId,
    context.clientId,
    key,
  );
  assert.ok(metadata);
  return metadata;
}

async function assertMetadataMatchesBytes(
  bucket: CoordinatedBucket,
  metadata: StorageFileMetadata,
  candidateBodies: string[],
): Promise<void> {
  const stored = bucket.objects.get(metadata.r2Key);
  assert.ok(stored);
  const body = new TextDecoder().decode(stored.body);
  assert.equal(candidateBodies.includes(body), true);
  assert.equal(metadata.contentType, "text/plain");
  assert.equal(metadata.size, stored.body.byteLength);
  assert.equal(metadata.sha256, await sha256(stored.body));
}

async function migratedDatabase(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  const directory = new URL("../../db/migrations/", import.meta.url);
  const migrations = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    sqlite.exec(await readFile(new URL(migration, directory), "utf8"));
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
