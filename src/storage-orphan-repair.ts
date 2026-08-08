import type {
  AuthStore,
  StorageFileOrphanRepair,
  StorageFileOrphanRepairDisposition,
} from "./types";

export const STORAGE_FILE_ORPHAN_REPAIR_BATCH_SIZE = 25;

export interface StorageFileOrphanRepairResult {
  examined: number;
  resolved: number;
  deferred: number;
}

export interface StorageFileOrphanRepairRepository {
  classifyStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
  ): Promise<StorageFileOrphanRepairDisposition>;
  completeStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
  ): Promise<boolean>;
  deferStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
    now: number,
  ): Promise<boolean>;
}

export interface StorageFileObjectStore {
  delete(key: string): Promise<void>;
}

export async function repairStorageFileOrphans(
  store: AuthStore,
  bucket: StorageFileObjectStore,
  now: number,
): Promise<StorageFileOrphanRepairResult> {
  const repairs = await store.listStorageFileOrphanRepairs(
    STORAGE_FILE_ORPHAN_REPAIR_BATCH_SIZE,
  );
  return repairStorageFileOrphanBatch(store, bucket, repairs, now);
}

export async function repairStorageFileOrphanBatch(
  store: StorageFileOrphanRepairRepository,
  bucket: StorageFileObjectStore,
  repairs: readonly StorageFileOrphanRepair[],
  now: number,
): Promise<StorageFileOrphanRepairResult> {
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
