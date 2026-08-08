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
  private remainingPuts = 0;
  private putBarrier: Promise<void> = Promise.resolve();
  private releasePuts = (): void => undefined;

  blockNextPuts(count: number): void {
    this.remainingPuts = count;
    this.putBarrier = new Promise<void>((resolve) => {
      this.releasePuts = resolve;
    });
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
    if (this.remainingPuts > 0) {
      this.remainingPuts -= 1;
      if (this.remainingPuts === 0) this.releasePuts();
      await this.putBarrier;
    }
    return super.put(key, value, options);
  }

  override async delete(key: string): Promise<void> {
    if (this.failDeletes) throw new Error("injected_r2_delete_failure");
    await super.delete(key);
  }
}

interface Fixture {
  app: AittaDBApp;
  sqlite: DatabaseSync;
  store: D1AuthStore;
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

async function fixture(): Promise<Fixture> {
  const sqlite = await migratedDatabase();
  const database = sqliteD1(sqlite);
  const bucket = new CoordinatedBucket();
  const env = await testEnv({ DB: database, BUCKET: bucket });
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new D1AuthStore(database);
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
