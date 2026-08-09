export const ACCOUNT_DELETION_MAX_CLAIM_BATCH = 25;
export const ACCOUNT_DELETION_MAX_LEASE_SECONDS = 5 * 60;
export const ACCOUNT_DELETION_AUDIT_UNLINK_BATCH = 100;

export function accountDeletionClaimExpiry(
  now: number,
  leaseSeconds: number,
  limit: number,
): number {
  assertTimestamp(now, "account_deletion_now_invalid");
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < 1 ||
    leaseSeconds > ACCOUNT_DELETION_MAX_LEASE_SECONDS
  ) {
    throw new RangeError("account_deletion_lease_invalid");
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ACCOUNT_DELETION_MAX_CLAIM_BATCH
  ) {
    throw new RangeError("account_deletion_claim_limit_invalid");
  }
  const expiresAt = now + leaseSeconds;
  assertTimestamp(expiresAt, "account_deletion_lease_invalid");
  return expiresAt;
}

export function assertAccountDeletionNow(now: number): void {
  assertTimestamp(now, "account_deletion_now_invalid");
}

export function assertAccountDeletionRetryAt(
  now: number,
  retryAt: number,
): void {
  assertAccountDeletionNow(now);
  assertTimestamp(retryAt, "account_deletion_retry_at_invalid");
  if (retryAt <= now) {
    throw new RangeError("account_deletion_retry_at_invalid");
  }
}

function assertTimestamp(value: number, error: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(error);
}
