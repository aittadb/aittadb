import { nowSeconds } from "./crypto";
import { purgeAccountFilesBatch } from "./account-file-purge";
import { ACCOUNT_CREDENTIAL_PURGE_MAX_BATCH } from "./store/account-credential-purge";
import { ACCOUNT_RECORD_PURGE_MAX_BATCH } from "./store/account-record-purge";
import { STORAGE_FILE_WRITE_FENCE_CLEANUP_BATCH } from "./storage-file-write-fence";
import type { AuthStore } from "./types";
import type { StorageFileObjectStore } from "./storage-orphan-repair";

export const ACCOUNT_DELETION_COORDINATOR_LEASE_SECONDS = 5 * 60;
export const ACCOUNT_DELETION_COORDINATOR_RETRY_SECONDS = 30;
export const ACCOUNT_DELETION_COORDINATOR_CLAIM_LIMIT = 1;

export interface AccountDeletionCoordinatorResult {
  claimed: number;
  completed: number;
  deferred: number;
  leaseLost: number;
}

export type AccountDeletionClock = () => number;

const EMPTY_RESULT: AccountDeletionCoordinatorResult = {
  claimed: 0,
  completed: 0,
  deferred: 0,
  leaseLost: 0,
};

/**
 * Advances one claimed deletion in finite request-time work. The aggregate
 * result is internal and deliberately contains no subject or storage detail.
 */
export async function coordinateAccountDeletionBatch(
  store: AuthStore,
  objects: StorageFileObjectStore,
  clock: AccountDeletionClock = nowSeconds,
): Promise<AccountDeletionCoordinatorResult> {
  const claimed = await store.claimAccountDeletionJobs(
    clock(),
    ACCOUNT_DELETION_COORDINATOR_LEASE_SECONDS,
    ACCOUNT_DELETION_COORDINATOR_CLAIM_LIMIT,
  );
  const job = claimed[0];
  if (!job) return { ...EMPTY_RESULT };

  try {
    await store.stageExpiredAccountFileWriteFences(
      job.subject,
      job.attempt,
      clock(),
      STORAGE_FILE_WRITE_FENCE_CLEANUP_BATCH,
    );
    const credentials = await store.purgeAccountCredentialsAndGrants(
      job.subject,
      ACCOUNT_CREDENTIAL_PURGE_MAX_BATCH,
    );
    const records = await store.purgeAccountRecords(
      job.subject,
      ACCOUNT_RECORD_PURGE_MAX_BATCH,
    );
    const files = await purgeAccountFilesBatch(
      store,
      objects,
      job.subject,
      job.attempt,
      clock(),
    );

    if (credentials.done && records.done && files.complete) {
      const completed = await store.finalizeAccountDeletion(
        job.subject,
        job.attempt,
        clock(),
      );
      if (completed) {
        return { claimed: 1, completed: 1, deferred: 0, leaseLost: 0 };
      }
    }
  } catch {
    // Committed phase work is its own durable cursor. Deferral below retries
    // from the first remaining row without exposing which phase failed.
  }

  return deferOrObserveCompletion(store, job.subject, job.attempt, clock());
}

async function deferOrObserveCompletion(
  store: AuthStore,
  subject: string,
  attempt: number,
  now: number,
): Promise<AccountDeletionCoordinatorResult> {
  try {
    if (
      await store.retryAccountDeletionJob(
        subject,
        attempt,
        now,
        now + ACCOUNT_DELETION_COORDINATOR_RETRY_SECONDS,
      )
    ) {
      return { claimed: 1, completed: 0, deferred: 1, leaseLost: 0 };
    }
    const current = await store.getAccountDeletionJob(subject);
    if (current?.state === "completed") {
      return { claimed: 1, completed: 1, deferred: 0, leaseLost: 0 };
    }
  } catch {
    // A later invocation can reclaim an expired or retryable durable job.
  }
  return { claimed: 1, completed: 0, deferred: 0, leaseLost: 1 };
}
