import type { AuthStore } from "./types";

export const STORAGE_FILE_ORPHAN_REPAIR_BATCH_SIZE = 25;

export interface StorageFileOrphanRepairResult {
  examined: number;
  resolved: number;
  deferred: number;
}

export async function repairStorageFileOrphans(
  store: AuthStore,
  bucket: R2Bucket,
  now: number,
): Promise<StorageFileOrphanRepairResult> {
  const repairs = await store.listStorageFileOrphanRepairs(
    STORAGE_FILE_ORPHAN_REPAIR_BATCH_SIZE,
  );
  let resolved = 0;
  let deferred = 0;

  for (const repair of repairs) {
    try {
      const disposition = await store.classifyStorageFileOrphanRepair(repair);
      if (disposition === "missing") continue;
      if (disposition === "referenced") {
        await store.completeStorageFileOrphanRepair(repair);
        resolved += 1;
        continue;
      }

      await bucket.delete(repair.r2Key);
      await store.completeStorageFileOrphanRepair(repair);
      resolved += 1;
    } catch {
      deferred += 1;
      try {
        await store.deferStorageFileOrphanRepair(repair, now);
      } catch {
        // The durable row remains eligible after a transient D1 failure.
      }
    }
  }

  return { examined: repairs.length, resolved, deferred };
}
