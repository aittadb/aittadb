import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config";
import { nowSeconds, sha256 } from "../../src/crypto";
import type { AittaDBApp } from "../../src/handler";
import { createClientRegistration, issueTokens } from "../../src/oauth";
import { MemoryAuthStore } from "../../src/store/memory";
import type { StorageFileMetadata, StorageLimits } from "../../src/types";
import { createTestAittaDB, MemoryR2Bucket, testEnv } from "../helpers";

const INJECTED_FAILURE = "injected-storage-internal-secret";

class FaultInjectingStore extends MemoryAuthStore {
  upsertFileFailures = 0;
  deleteFileFailures = 0;

  override async upsertStorageFileMetadata(
    file: StorageFileMetadata,
    expectedR2Key: string | null,
    limits?: StorageLimits,
  ): Promise<boolean> {
    if (this.upsertFileFailures > 0) {
      this.upsertFileFailures -= 1;
      throw new Error(`${INJECTED_FAILURE}:d1-upsert`);
    }
    return super.upsertStorageFileMetadata(file, expectedR2Key, limits);
  }

  override async deleteStorageFileMetadata(
    userId: string,
    clientId: string,
    key: string,
    expectedR2Key: string,
  ): Promise<boolean> {
    if (this.deleteFileFailures > 0) {
      this.deleteFileFailures -= 1;
      throw new Error(`${INJECTED_FAILURE}:d1-delete`);
    }
    return super.deleteStorageFileMetadata(
      userId,
      clientId,
      key,
      expectedR2Key,
    );
  }
}

class FaultInjectingBucket extends MemoryR2Bucket {
  putFailures = 0;
  private readonly deleteFailures = new Map<string, number>();

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
    if (this.putFailures > 0) {
      this.putFailures -= 1;
      throw new Error(`${INJECTED_FAILURE}:r2-put`);
    }
    return super.put(key, value, options);
  }

  override async delete(key: string): Promise<void> {
    const remaining = this.deleteFailures.get(key) ?? 0;
    if (remaining > 0) {
      this.deleteFailures.set(key, remaining - 1);
      throw new Error(`${INJECTED_FAILURE}:r2-delete`);
    }
    await super.delete(key);
  }
}

class CoordinatedBucket extends FaultInjectingBucket {
  private putBarrier:
    | { remaining: number; promise: Promise<void>; release: () => void }
    | undefined;
  private nextPutGate:
    | { entered: () => void; promise: Promise<void> }
    | undefined;

  blockNextPuts(count: number): void {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.putBarrier = { remaining: count, promise, release };
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

  override async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown> {
    const gate = this.nextPutGate;
    if (gate) {
      this.nextPutGate = undefined;
      gate.entered();
      await gate.promise;
    }
    const barrier = this.putBarrier;
    if (barrier) {
      barrier.remaining -= 1;
      if (barrier.remaining === 0) {
        this.putBarrier = undefined;
        barrier.release();
      }
      await barrier.promise;
    }
    return super.put(key, value, options);
  }
}

interface Fixture {
  app: AittaDBApp;
  store: FaultInjectingStore;
  bucket: FaultInjectingBucket;
  userId: string;
  clientId: string;
  accessToken: string;
}

async function fixture(
  bucket: FaultInjectingBucket = new FaultInjectingBucket(),
): Promise<Fixture> {
  const env = await testEnv({ BUCKET: bucket });
  const config = loadConfig(env, env.ISSUER_URL!);
  const store = new FaultInjectingStore();
  const now = nowSeconds();
  const user = await store.findOrCreateUser(
    {
      email: "file-owner@example.test",
      fullName: "File Owner",
      displayName: "File Owner",
    },
    now,
  );
  const { client } = await createClientRegistration(
    {
      type: "public",
      name: "Failure consistency client",
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
    store,
    bucket,
    userId: user.id,
    clientId: client.id,
    accessToken: String(tokens.access_token),
  };
}

async function fileRequest(
  context: Fixture,
  method: "POST" | "PUT" | "DELETE",
  key: string | null,
  body?: string,
  contentType?: string,
): Promise<Response> {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${context.accessToken}`,
  });
  if (contentType) headers.set("content-type", contentType);
  const response = await context.app.fetch(
    new Request(
      `https://aittadb.example.test/storage/files${key === null ? "" : `/${encodeURIComponent(key)}`}`,
      { method, headers, body },
    ),
  );
  assert.ok(response);
  return response;
}

async function assertGenericFailure(
  response: Response,
  context: Fixture,
  physicalKey?: string,
): Promise<void> {
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.match(text, /Unexpected server error/);
  assert.doesNotMatch(text, new RegExp(INJECTED_FAILURE));
  assert.doesNotMatch(text, new RegExp(context.userId));
  assert.doesNotMatch(text, new RegExp(context.clientId));
  assert.doesNotMatch(text, /users\//);
  if (physicalKey) assert.equal(text.includes(physicalKey), false);
}

function storedBody(bucket: FaultInjectingBucket, key: string): string {
  const object = bucket.objects.get(key);
  assert.ok(object);
  return new TextDecoder().decode(object.body);
}

test("file creation leaves neither metadata nor an R2 object after an isolated write failure", async () => {
  const context = await fixture();

  context.bucket.putFailures = 1;
  await assertGenericFailure(
    await fileRequest(context, "POST", null, "r2 failure body", "text/plain"),
    context,
  );
  assert.equal(context.store.storageFiles.size, 0);
  assert.equal(context.bucket.objects.size, 0);

  context.store.upsertFileFailures = 1;
  await assertGenericFailure(
    await fileRequest(
      context,
      "POST",
      null,
      "metadata failure body",
      "text/plain",
    ),
    context,
  );
  assert.equal(context.store.storageFiles.size, 0);
  assert.equal(context.bucket.objects.size, 0);
});

test("file replacement uses copy-on-write and never pairs new bytes with old metadata", async () => {
  const context = await fixture();
  const key = "replace.txt";
  const initial = await fileRequest(
    context,
    "PUT",
    key,
    "original bytes",
    "text/plain",
  );
  assert.equal(initial.status, 200);
  const previous = {
    ...(await context.store.getStorageFileMetadata(
      context.userId,
      context.clientId,
      key,
    )),
  } as StorageFileMetadata;
  assert.equal(storedBody(context.bucket, previous.r2Key), "original bytes");

  context.bucket.putFailures = 1;
  await assertGenericFailure(
    await fileRequest(
      context,
      "PUT",
      key,
      "uncommitted r2 bytes",
      "application/r2-failure",
    ),
    context,
    previous.r2Key,
  );
  assert.deepEqual(
    await context.store.getStorageFileMetadata(
      context.userId,
      context.clientId,
      key,
    ),
    previous,
  );
  assert.equal(storedBody(context.bucket, previous.r2Key), "original bytes");

  context.store.upsertFileFailures = 1;
  await assertGenericFailure(
    await fileRequest(
      context,
      "PUT",
      key,
      "uncommitted metadata bytes",
      "application/d1-failure",
    ),
    context,
    previous.r2Key,
  );
  assert.deepEqual(
    await context.store.getStorageFileMetadata(
      context.userId,
      context.clientId,
      key,
    ),
    previous,
  );
  assert.equal(context.bucket.objects.size, 1);
  assert.equal(storedBody(context.bucket, previous.r2Key), "original bytes");

  const replacementBody = "committed replacement";
  const replacementResponse = await fileRequest(
    context,
    "PUT",
    key,
    replacementBody,
    "application/replacement",
  );
  assert.equal(replacementResponse.status, 200);
  const replacement = await context.store.getStorageFileMetadata(
    context.userId,
    context.clientId,
    key,
  );
  assert.ok(replacement);
  assert.notEqual(replacement.r2Key, previous.r2Key);
  assert.equal(replacement.contentType, "application/replacement");
  assert.equal(replacement.size, replacementBody.length);
  assert.equal(replacement.sha256, await sha256(replacementBody));
  assert.equal(storedBody(context.bucket, replacement.r2Key), replacementBody);
  assert.equal(context.bucket.objects.has(previous.r2Key), false);
  assert.equal(context.bucket.objects.size, 1);
});

test("file replacement rolls metadata and bytes back when the old R2 object cannot be retired", async () => {
  const context = await fixture();
  const key = "rollback.txt";
  assert.equal(
    (
      await fileRequest(
        context,
        "PUT",
        key,
        "rollback original",
        "text/original",
      )
    ).status,
    200,
  );
  const previous = {
    ...(await context.store.getStorageFileMetadata(
      context.userId,
      context.clientId,
      key,
    )),
  } as StorageFileMetadata;
  context.bucket.failDelete(previous.r2Key, 2);

  await assertGenericFailure(
    await fileRequest(
      context,
      "PUT",
      key,
      "replacement that must roll back",
      "application/replacement",
    ),
    context,
    previous.r2Key,
  );
  assert.deepEqual(
    await context.store.getStorageFileMetadata(
      context.userId,
      context.clientId,
      key,
    ),
    previous,
  );
  assert.equal(context.bucket.objects.size, 1);
  assert.equal(storedBody(context.bucket, previous.r2Key), "rollback original");
});

test("file deletion preserves the complete resource when D1 or R2 deletion fails", async () => {
  const context = await fixture();
  const key = "delete.txt";
  assert.equal(
    (await fileRequest(context, "PUT", key, "delete original", "text/original"))
      .status,
    200,
  );
  const previous = {
    ...(await context.store.getStorageFileMetadata(
      context.userId,
      context.clientId,
      key,
    )),
  } as StorageFileMetadata;

  context.store.deleteFileFailures = 1;
  await assertGenericFailure(
    await fileRequest(context, "DELETE", key),
    context,
    previous.r2Key,
  );
  assert.deepEqual(
    await context.store.getStorageFileMetadata(
      context.userId,
      context.clientId,
      key,
    ),
    previous,
  );
  assert.equal(storedBody(context.bucket, previous.r2Key), "delete original");

  context.bucket.failDelete(previous.r2Key, 2);
  await assertGenericFailure(
    await fileRequest(context, "DELETE", key),
    context,
    previous.r2Key,
  );
  assert.deepEqual(
    await context.store.getStorageFileMetadata(
      context.userId,
      context.clientId,
      key,
    ),
    previous,
  );
  assert.equal(storedBody(context.bucket, previous.r2Key), "delete original");

  const deleted = await fileRequest(context, "DELETE", key);
  assert.equal(deleted.status, 200);
  assert.equal(
    await context.store.getStorageFileMetadata(
      context.userId,
      context.clientId,
      key,
    ),
    null,
  );
  assert.equal(context.bucket.objects.has(previous.r2Key), false);
});

test("concurrent first writes retain exactly one metadata row and R2 object", async () => {
  const bucket = new CoordinatedBucket();
  const context = await fixture(bucket);
  const key = "concurrent-create.txt";
  bucket.blockNextPuts(10);

  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      fileRequest(context, "PUT", key, `body-${index}`, "text/plain"),
    ),
  );
  assert.equal(responses.filter(({ status }) => status === 200).length, 1);
  assert.equal(responses.filter(({ status }) => status === 409).length, 9);
  const metadata = await context.store.getStorageFileMetadata(
    context.userId,
    context.clientId,
    key,
  );
  assert.ok(metadata);
  assert.equal(context.store.storageFiles.size, 1);
  assert.equal(context.bucket.objects.size, 1);
  assert.equal(context.bucket.objects.has(metadata.r2Key), true);
});

test("concurrent replacements retain only the winning R2 object", async () => {
  const bucket = new CoordinatedBucket();
  const context = await fixture(bucket);
  const key = "concurrent-replace.txt";
  assert.equal(
    (await fileRequest(context, "PUT", key, "initial", "text/plain")).status,
    200,
  );
  bucket.blockNextPuts(8);

  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      fileRequest(context, "PUT", key, `replacement-${index}`, "text/plain"),
    ),
  );
  assert.equal(responses.filter(({ status }) => status === 200).length, 1);
  assert.equal(responses.filter(({ status }) => status === 409).length, 7);
  const metadata = await context.store.getStorageFileMetadata(
    context.userId,
    context.clientId,
    key,
  );
  assert.ok(metadata);
  assert.equal(context.bucket.objects.size, 1);
  assert.equal(context.bucket.objects.has(metadata.r2Key), true);
});

test("a replacement that loses to deletion removes its uncommitted R2 object", async () => {
  const bucket = new CoordinatedBucket();
  const context = await fixture(bucket);
  const key = "replace-delete-race.txt";
  assert.equal(
    (await fileRequest(context, "PUT", key, "initial", "text/plain")).status,
    200,
  );
  const gate = bucket.pauseNextPut();
  const replacement = fileRequest(
    context,
    "PUT",
    key,
    "late replacement",
    "text/plain",
  );
  await gate.entered;
  assert.equal((await fileRequest(context, "DELETE", key)).status, 200);
  gate.release();
  assert.equal((await replacement).status, 409);
  assert.equal(
    await context.store.getStorageFileMetadata(
      context.userId,
      context.clientId,
      key,
    ),
    null,
  );
  assert.equal(context.bucket.objects.size, 0);
});
