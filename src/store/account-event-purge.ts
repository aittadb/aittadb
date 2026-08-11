export const ACCOUNT_EVENT_PURGE_MAX_BATCH = 100;

export function assertAccountEventPurgeInput(
  subject: string,
  attempt: number,
  now: number,
  limit: number,
): void {
  if (subject.length === 0 || subject.length > 128) {
    throw new RangeError("account_event_purge_subject_invalid");
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("account_event_purge_attempt_invalid");
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("account_event_purge_now_invalid");
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ACCOUNT_EVENT_PURGE_MAX_BATCH
  ) {
    throw new RangeError("account_event_purge_limit_invalid");
  }
}

export function accountEventPurgeBatch(
  deletedCount: number,
  limit: number,
): { deletedCount: number; done: boolean } {
  if (
    !Number.isSafeInteger(deletedCount) ||
    deletedCount < 0 ||
    deletedCount > limit
  ) {
    throw new Error("account_event_purge_failed");
  }
  return { deletedCount, done: deletedCount < limit };
}

export function accountEventPurgeUnavailable(): Error {
  return new Error("account_event_purge_unavailable");
}
