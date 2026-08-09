import type { StorageFileWriteFence } from "./types";

export const STORAGE_FILE_WRITE_FENCE_SECONDS = 5 * 60;
export const STORAGE_FILE_WRITE_FENCE_CLEANUP_BATCH = 25;

export function assertStorageFileWriteFenceBatchLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > STORAGE_FILE_WRITE_FENCE_CLEANUP_BATCH
  ) {
    throw new RangeError("storage_file_write_fence_limit_invalid");
  }
}

export function storageFileWriteFence(
  userId: string,
  clientId: string,
  r2Key: string,
  now: number,
): StorageFileWriteFence {
  const fence = {
    userId,
    clientId,
    r2Key,
    createdAt: now,
    expiresAt: now + STORAGE_FILE_WRITE_FENCE_SECONDS,
  };
  assertStorageFileWriteFence(fence);
  return fence;
}

export function assertStorageFileWriteFence(
  fence: StorageFileWriteFence,
): void {
  if (
    fence.userId.length === 0 ||
    fence.userId.length > 128 ||
    fence.clientId.length === 0 ||
    fence.clientId.length > 128 ||
    fence.r2Key.length === 0 ||
    fence.r2Key.length > 512 ||
    !Number.isSafeInteger(fence.createdAt) ||
    fence.createdAt < 0 ||
    !Number.isSafeInteger(fence.expiresAt) ||
    fence.expiresAt <= fence.createdAt ||
    fence.expiresAt - fence.createdAt > STORAGE_FILE_WRITE_FENCE_SECONDS
  ) {
    throw new RangeError("storage_file_write_fence_invalid");
  }
}
