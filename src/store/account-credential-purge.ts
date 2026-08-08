export const ACCOUNT_CREDENTIAL_PURGE_MAX_BATCH = 100;

export function assertAccountCredentialPurgeLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ACCOUNT_CREDENTIAL_PURGE_MAX_BATCH
  ) {
    throw new RangeError("account_credential_purge_limit_invalid");
  }
}

export function accountCredentialPurgeUnavailable(): Error {
  return new Error("account_credential_purge_unavailable");
}
