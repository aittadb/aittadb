import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_FILE_ORPHAN_REPAIR_BATCH_SIZE,
  repairStorageFileOrphans,
} from "../../src/storage-orphan-repair";
import { MemoryAuthStore } from "../../src/store/memory";
import type {
  StorageFileMetadata,
  StorageFileOrphanRepair,
} from "../../src/types";
import { MemoryR2Bucket } from "../helpers";

test("orphan processor handles one deterministic finite batch", async () => {
  const store = new MemoryAuthStore();
  const bucket = new TrackingBucket();
  const total = STORAGE_FILE_ORPHAN_REPAIR_BATCH_SIZE + 2;

  for (let index = total - 1; index >= 0; index -= 1) {
    const candidate = repair(
      `physical/${String(index).padStart(2, "0")}`,
      index,
    );
    await store.recordStorageFileOrphanRepair(candidate);
    await bucket.put(candidate.r2Key, `body-${index}`);
  }

  const result = await repairStorageFileOrphans(store, bucket, 100);

  assert.deepEqual(result, {
    examined: STORAGE_FILE_ORPHAN_REPAIR_BATCH_SIZE,
    resolved: STORAGE_FILE_ORPHAN_REPAIR_BATCH_SIZE,
    deferred: 0,
  });
  assert.deepEqual(bucket.deleteCalls, [
    ...Array.from(
      { length: STORAGE_FILE_ORPHAN_REPAIR_BATCH_SIZE },
      (_, index) => `physical/${String(index).padStart(2, "0")}`,
    ),
  ]);
  assert.deepEqual(Array.from(store.storageFileOrphanRepairs.keys()).sort(), [
    "physical/25",
    "physical/26",
  ]);
  assert.deepEqual(Object.keys(result).sort(), [
    "deferred",
    "examined",
    "resolved",
  ]);
});

test("foreign-owner references retain bytes and defer the repair", async () => {
  const store = new MemoryAuthStore();
  const bucket = new TrackingBucket();
  const candidate = repair("physical/referenced", 1);
  const metadata = file(candidate.r2Key, "user-b", "client-b");
  assert.equal(await store.upsertStorageFileMetadata(metadata, null), true);
  assert.equal(await store.recordStorageFileOrphanRepair(candidate), true);
  await bucket.put(candidate.r2Key, "referenced-body");

  const result = await repairStorageFileOrphans(store, bucket, 100);

  assert.deepEqual(result, { examined: 1, resolved: 0, deferred: 1 });
  assert.deepEqual(bucket.deleteCalls, []);
  assert.equal(bucket.objects.has(candidate.r2Key), true);
  assert.equal(store.storageFileOrphanRepairs.size, 1);
});

test("concurrent processors keep a foreign-owner conflict deferred", async () => {
  const store = new MemoryAuthStore();
  const bucket = new TrackingBucket();
  const candidate = repair("physical/concurrent-reference", 1);
  assert.equal(
    await store.upsertStorageFileMetadata(
      file(candidate.r2Key, "user-b", "client-b"),
      null,
    ),
    true,
  );
  await store.recordStorageFileOrphanRepair(candidate);
  await bucket.put(candidate.r2Key, "referenced-body");

  await Promise.all([
    repairStorageFileOrphans(store, bucket, 100),
    repairStorageFileOrphans(store, bucket, 100),
  ]);

  assert.deepEqual(bucket.deleteCalls, []);
  assert.equal(bucket.objects.has(candidate.r2Key), true);
  assert.equal(store.storageFileOrphanRepairs.size, 1);
});

test("queued repair blocks a metadata reattachment race until deletion completes", async () => {
  const store = new InterleavingStore();
  const bucket = new TrackingBucket();
  const candidate = repair("physical/race", 1);
  await store.recordStorageFileOrphanRepair(candidate);
  await bucket.put(candidate.r2Key, "orphan-body");

  const result = await repairStorageFileOrphans(store, bucket, 100);

  assert.deepEqual(result, { examined: 1, resolved: 1, deferred: 0 });
  assert.equal(store.attachmentResult, false);
  assert.equal(bucket.objects.has(candidate.r2Key), false);
  assert.equal(store.storageFiles.size, 0);
});

test("transient R2 deletion failure is deferred and converges on retry", async () => {
  const store = new MemoryAuthStore();
  const bucket = new TrackingBucket();
  const candidate = repair("physical/transient-r2", 1);
  await store.recordStorageFileOrphanRepair(candidate);
  await bucket.put(candidate.r2Key, "orphan-body");
  bucket.failDeletes = 1;

  assert.deepEqual(await repairStorageFileOrphans(store, bucket, 100), {
    examined: 1,
    resolved: 0,
    deferred: 1,
  });
  assert.equal(bucket.objects.has(candidate.r2Key), true);
  assert.equal(
    store.storageFileOrphanRepairs.get(candidate.r2Key)?.updatedAt,
    100,
  );

  assert.deepEqual(await repairStorageFileOrphans(store, bucket, 101), {
    examined: 1,
    resolved: 1,
    deferred: 0,
  });
  assert.equal(bucket.objects.has(candidate.r2Key), false);
  assert.equal(store.storageFileOrphanRepairs.size, 0);
});

test("D1 completion failure after R2 deletion retries idempotently", async () => {
  const store = new CompletionFailingStore();
  const bucket = new TrackingBucket();
  const candidate = repair("physical/transient-d1", 1);
  await store.recordStorageFileOrphanRepair(candidate);
  await bucket.put(candidate.r2Key, "orphan-body");

  assert.deepEqual(await repairStorageFileOrphans(store, bucket, 100), {
    examined: 1,
    resolved: 0,
    deferred: 1,
  });
  assert.equal(bucket.objects.has(candidate.r2Key), false);
  assert.equal(store.storageFileOrphanRepairs.size, 1);

  assert.deepEqual(await repairStorageFileOrphans(store, bucket, 101), {
    examined: 1,
    resolved: 1,
    deferred: 0,
  });
  assert.equal(store.storageFileOrphanRepairs.size, 0);
  assert.deepEqual(bucket.deleteCalls, [candidate.r2Key, candidate.r2Key]);
});

class TrackingBucket extends MemoryR2Bucket {
  deleteCalls: string[] = [];
  failDeletes = 0;

  override async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      throw new Error("injected_r2_delete_failure");
    }
    await super.delete(key);
  }
}

class CompletionFailingStore extends MemoryAuthStore {
  failCompletions = 1;

  override async completeStorageFileOrphanRepair(
    candidate: StorageFileOrphanRepair,
  ): Promise<boolean> {
    if (this.failCompletions > 0) {
      this.failCompletions -= 1;
      throw new Error("injected_d1_completion_failure");
    }
    return super.completeStorageFileOrphanRepair(candidate);
  }
}

class InterleavingStore extends MemoryAuthStore {
  attachmentResult: boolean | null = null;

  override async classifyStorageFileOrphanRepair(
    candidate: StorageFileOrphanRepair,
  ): ReturnType<MemoryAuthStore["classifyStorageFileOrphanRepair"]> {
    const disposition = await super.classifyStorageFileOrphanRepair(candidate);
    this.attachmentResult = await this.upsertStorageFileMetadata(
      file(candidate.r2Key),
      null,
    );
    return disposition;
  }
}

function repair(r2Key: string, recordedAt: number): StorageFileOrphanRepair {
  return {
    userId: "user-a",
    clientId: "client-a",
    r2Key,
    createdAt: recordedAt,
    updatedAt: recordedAt,
  };
}

function file(
  r2Key: string,
  userId = "user-a",
  clientId = "client-a",
): StorageFileMetadata {
  return {
    userId,
    clientId,
    key: "logical-key",
    r2Key,
    contentType: "text/plain",
    size: 4,
    sha256: "digest",
    createdAt: 1,
    updatedAt: 1,
  };
}
