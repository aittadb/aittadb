import type { AccountDeletionJobStartResult, AuthStore } from "./types";

export class SubjectAuthorizationDenied extends Error {
  constructor() {
    super("subject_not_authorized");
    this.name = "SubjectAuthorizationDenied";
  }
}

/** Fail closed once any deletion-job state exists for the local subject. */
export async function requireActiveSubject(
  store: AuthStore,
  subject: string,
): Promise<void> {
  if (await store.getAccountDeletionJob(subject)) {
    throw new SubjectAuthorizationDenied();
  }
}

export function isSubjectAuthorizationDenied(
  error: unknown,
): error is SubjectAuthorizationDenied {
  return error instanceof SubjectAuthorizationDenied;
}

/** Internal domain entry point; TASK-152 will own its HTTP adapter. */
export async function startSubjectAccountDeletion(
  store: AuthStore,
  adminSubjects: readonly string[],
  subject: string,
  now: number,
): Promise<AccountDeletionJobStartResult> {
  if (adminSubjects.includes(subject)) {
    throw new SubjectAuthorizationDenied();
  }
  return store.startAccountDeletionJob(subject, now);
}
