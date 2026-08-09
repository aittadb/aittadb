export const ACCOUNT_CREDENTIAL_PURGE_MAX_BATCH = 100;

export type AccountCredentialPurgeFailurePhase =
  | "job"
  | "authorization-codes"
  | "authorization-requests"
  | "device-grants"
  | "consents"
  | "refresh-tokens"
  | "refresh-families"
  | "access-revocations"
  | "admin-submissions"
  | "remaining-check";

export const ACCOUNT_CREDENTIAL_PURGE_FAILURE_EVENT =
  "account-deletion.credentials.failed";

export class AccountCredentialPurgeFailure extends Error {
  constructor(readonly phase: AccountCredentialPurgeFailurePhase) {
    super("account_credential_purge_failed");
    this.name = "AccountCredentialPurgeFailure";
  }
}

export function accountCredentialPurgeFailureTelemetry(
  phase: AccountCredentialPurgeFailurePhase,
): string {
  return JSON.stringify({
    event: ACCOUNT_CREDENTIAL_PURGE_FAILURE_EVENT,
    phase,
  });
}

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
