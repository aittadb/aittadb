import {
  repairStorageFileOrphanBatch,
  type StorageFileObjectStore,
  type StorageFileOrphanRepairRepository,
} from "./storage-orphan-repair";
import type {
  AccountDeletionJob,
  AccountFilePurgeStageResult,
  StorageFileOrphanRepair,
} from "./types";

export const ACCOUNT_FILE_PURGE_BATCH_SIZE = 25;

export interface AccountFilePurgeRepository extends StorageFileOrphanRepairRepository {
  getAccountDeletionJob(subject: string): Promise<AccountDeletionJob | null>;
  stageAccountFilePurgeBatch(
    subject: string,
    attempt: number,
    now: number,
    limit: number,
  ): Promise<AccountFilePurgeStageResult>;
  hasStorageFilesForSubject(subject: string): Promise<boolean>;
  listStorageFileOrphanRepairsForSubject(
    subject: string,
    limit: number,
  ): Promise<StorageFileOrphanRepair[]>;
  hasStorageFileOrphanRepairsForSubject(subject: string): Promise<boolean>;
}

export interface AccountFilePurgeResult {
  staged: number;
  examined: number;
  resolved: number;
  deferred: number;
  complete: boolean;
}

/**
 * Detaches one finite metadata batch and retires its objects through TASK-119.
 * This internal primitive deliberately returns aggregate progress only.
 */
export async function purgeAccountFilesBatch(
  repository: AccountFilePurgeRepository,
  objects: StorageFileObjectStore,
  subject: string,
  attempt: number,
  now: number,
): Promise<AccountFilePurgeResult> {
  assertAccountFilePurgeInput(
    subject,
    attempt,
    now,
    ACCOUNT_FILE_PURGE_BATCH_SIZE,
  );
  const job = await repository.getAccountDeletionJob(subject);
  if (!job) throw new Error("account_file_purge_job_required");
  if (job.state === "completed" && job.attempt === attempt) {
    try {
      const [filesRemain, repairsRemain] = await Promise.all([
        repository.hasStorageFilesForSubject(subject),
        repository.hasStorageFileOrphanRepairsForSubject(subject),
      ]);
      if (filesRemain || repairsRemain) {
        throw new Error("account_file_purge_completed_dirty");
      }
      return {
        staged: 0,
        examined: 0,
        resolved: 0,
        deferred: 0,
        complete: true,
      };
    } catch {
      throw new Error("account_file_purge_failed");
    }
  }
  if (
    job.state !== "running" ||
    job.attempt !== attempt ||
    job.availableAt === null ||
    job.availableAt <= now
  ) {
    throw new Error("account_file_purge_lease_invalid");
  }

  try {
    let staged = 0;
    let repairs = await repository.listStorageFileOrphanRepairsForSubject(
      subject,
      ACCOUNT_FILE_PURGE_BATCH_SIZE,
    );

    if (repairs.length === 0) {
      const stage = await repository.stageAccountFilePurgeBatch(
        subject,
        attempt,
        now,
        ACCOUNT_FILE_PURGE_BATCH_SIZE,
      );
      if (stage.selected !== stage.staged) {
        throw new Error("account_file_purge_stage_incomplete");
      }
      staged = stage.staged;
      repairs = await repository.listStorageFileOrphanRepairsForSubject(
        subject,
        ACCOUNT_FILE_PURGE_BATCH_SIZE,
      );
    }

    const repaired = await repairStorageFileOrphanBatch(
      repository,
      objects,
      repairs,
      now,
    );
    const [filesRemain, repairsRemain] = await Promise.all([
      repository.hasStorageFilesForSubject(subject),
      repository.hasStorageFileOrphanRepairsForSubject(subject),
    ]);
    return {
      staged,
      ...repaired,
      complete: !filesRemain && !repairsRemain,
    };
  } catch {
    throw new Error("account_file_purge_failed");
  }
}

export function assertAccountFilePurgeInput(
  subject: string,
  attempt: number,
  now: number,
  limit: number,
): void {
  if (
    subject.length === 0 ||
    subject.length > 128 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ACCOUNT_FILE_PURGE_BATCH_SIZE
  ) {
    throw new RangeError("account_file_purge_input_invalid");
  }
}
