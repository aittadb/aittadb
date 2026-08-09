import { nowSeconds } from "./crypto";
import { purgeAccountFilesBatch } from "./account-file-purge";
import {
  ACCOUNT_CREDENTIAL_PURGE_MAX_BATCH,
  AccountCredentialPurgeFailure,
  type AccountCredentialPurgeFailurePhase,
} from "./store/account-credential-purge";
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
export type AccountDeletionCoordinatorFailurePhase =
  | "fences"
  | "credentials"
  | "records"
  | "files"
  | "finalization";
export type AccountDeletionCoordinatorFailureObserver = (
  phase: AccountDeletionCoordinatorFailurePhase,
) => void;
export type AccountDeletionCoordinatorDeferredPhase = Exclude<
  AccountDeletionCoordinatorFailurePhase,
  "fences"
>;
export type AccountDeletionCoordinatorDeferredObserver = (
  phase: AccountDeletionCoordinatorDeferredPhase,
) => void;
export type AccountCredentialPurgeFailureObserver = (
  phase: AccountCredentialPurgeFailurePhase,
) => void;

export const ACCOUNT_DELETION_COORDINATOR_FAILURE_EVENT =
  "account-deletion.coordinator.failed";
export const ACCOUNT_DELETION_COORDINATOR_DEFERRED_EVENT =
  "account-deletion.coordinator.deferred";

export function accountDeletionCoordinatorFailureTelemetry(
  phase: AccountDeletionCoordinatorFailurePhase,
): string {
  return JSON.stringify({
    event: ACCOUNT_DELETION_COORDINATOR_FAILURE_EVENT,
    phase,
  });
}

export function accountDeletionCoordinatorDeferredTelemetry(
  phase: AccountDeletionCoordinatorDeferredPhase,
): string {
  return JSON.stringify({
    event: ACCOUNT_DELETION_COORDINATOR_DEFERRED_EVENT,
    phase,
  });
}

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
  onFailure?: AccountDeletionCoordinatorFailureObserver,
  onDeferred?: AccountDeletionCoordinatorDeferredObserver,
  onCredentialFailure?: AccountCredentialPurgeFailureObserver,
): Promise<AccountDeletionCoordinatorResult> {
  const claimed = await store.claimAccountDeletionJobs(
    clock(),
    ACCOUNT_DELETION_COORDINATOR_LEASE_SECONDS,
    ACCOUNT_DELETION_COORDINATOR_CLAIM_LIMIT,
  );
  const job = claimed[0];
  if (!job) return { ...EMPTY_RESULT };

  let phase: AccountDeletionCoordinatorFailurePhase = "fences";
  let deferredPhase: AccountDeletionCoordinatorDeferredPhase | undefined;
  try {
    await store.stageExpiredAccountFileWriteFences(
      job.subject,
      job.attempt,
      clock(),
      STORAGE_FILE_WRITE_FENCE_CLEANUP_BATCH,
    );
    phase = "credentials";
    const credentials = await store.purgeAccountCredentialsAndGrants(
      job.subject,
      ACCOUNT_CREDENTIAL_PURGE_MAX_BATCH,
    );
    if (!credentials.done) deferredPhase = "credentials";
    phase = "records";
    const records = await store.purgeAccountRecords(
      job.subject,
      ACCOUNT_RECORD_PURGE_MAX_BATCH,
    );
    if (!records.done && !deferredPhase) deferredPhase = "records";
    phase = "files";
    const files = await purgeAccountFilesBatch(
      store,
      objects,
      job.subject,
      job.attempt,
      clock(),
    );
    if (!files.complete && !deferredPhase) deferredPhase = "files";

    if (!deferredPhase) {
      phase = "finalization";
      const completed = await store.finalizeAccountDeletion(
        job.subject,
        job.attempt,
        clock(),
      );
      if (completed) {
        return { claimed: 1, completed: 1, deferred: 0, leaseLost: 0 };
      }
      deferredPhase = "finalization";
    }
  } catch (error) {
    if (error instanceof AccountCredentialPurgeFailure) {
      observeCredentialFailure(onCredentialFailure, error.phase);
    }
    observeFailure(onFailure, phase);
    deferredPhase = undefined;
    // Committed phase work is its own durable cursor. Deferral below retries
    // from the first remaining row without exposing which phase failed.
  }

  return deferOrObserveCompletion(
    store,
    job.subject,
    job.attempt,
    clock(),
    onFailure,
    onDeferred,
    deferredPhase,
  );
}

async function deferOrObserveCompletion(
  store: AuthStore,
  subject: string,
  attempt: number,
  now: number,
  onFailure?: AccountDeletionCoordinatorFailureObserver,
  onDeferred?: AccountDeletionCoordinatorDeferredObserver,
  deferredPhase?: AccountDeletionCoordinatorDeferredPhase,
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
      observeDeferred(onDeferred, deferredPhase);
      return { claimed: 1, completed: 0, deferred: 1, leaseLost: 0 };
    }
    const current = await store.getAccountDeletionJob(subject);
    if (current?.state === "completed") {
      return { claimed: 1, completed: 1, deferred: 0, leaseLost: 0 };
    }
  } catch {
    observeFailure(onFailure, "finalization");
    // A later invocation can reclaim an expired or retryable durable job.
  }
  return { claimed: 1, completed: 0, deferred: 0, leaseLost: 1 };
}

function observeCredentialFailure(
  observer: AccountCredentialPurgeFailureObserver | undefined,
  phase: AccountCredentialPurgeFailurePhase,
): void {
  try {
    observer?.(phase);
  } catch {
    // Telemetry must never change durable deletion progress or retry behavior.
  }
}

function observeDeferred(
  observer: AccountDeletionCoordinatorDeferredObserver | undefined,
  phase: AccountDeletionCoordinatorDeferredPhase | undefined,
): void {
  if (!phase) return;
  try {
    observer?.(phase);
  } catch {
    // Telemetry must never change durable deletion progress or retry behavior.
  }
}

function observeFailure(
  observer: AccountDeletionCoordinatorFailureObserver | undefined,
  phase: AccountDeletionCoordinatorFailurePhase,
): void {
  try {
    observer?.(phase);
  } catch {
    // Telemetry must never change durable deletion progress or retry behavior.
  }
}
