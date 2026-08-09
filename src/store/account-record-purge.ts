import type { AccountRecordPurgeBatch } from "../types";

export const ACCOUNT_RECORD_PURGE_MAX_BATCH = 100;

export function accountRecordPurgeUnavailable(): Error {
  return new Error("account_record_purge_unavailable");
}

export function assertAccountRecordPurgeInput(
  subject: string,
  limit: number,
): void {
  if (subject.length === 0 || subject.length > 128) {
    throw new RangeError("account_record_purge_subject_invalid");
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ACCOUNT_RECORD_PURGE_MAX_BATCH
  ) {
    throw new RangeError("account_record_purge_limit_invalid");
  }
}

export function accountRecordPurgeBatch(
  deletedCount: number,
  limit: number,
): AccountRecordPurgeBatch {
  if (
    !Number.isSafeInteger(deletedCount) ||
    deletedCount < 0 ||
    deletedCount > limit
  ) {
    throw new Error("account_record_purge_result_invalid");
  }
  return { deletedCount, done: deletedCount < limit };
}
