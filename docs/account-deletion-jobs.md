# Account-Deletion Job Repository

This document defines the internal durable state and subject-authorization primitives for the future self-service account-deletion flow. They add no HTTP route, data purge, coordinator, status resource, or browser interface.

## State model

Migration `0008_account_deletion_jobs.sql` stores one row per immutable local AittaDB subject. The subject itself is the primary key; the table is `WITHOUT ROWID` and has no job ID, deployment ID, project ID, client ID, email address, physical storage key, credential, or error text.

The states are:

- `pending`: an idempotent start created the job, and it is immediately claimable;
- `running`: a bounded worker claim is active until `available_at`;
- `retryable`: a current claimant deferred work until `available_at`;
- `completed`: terminal; it cannot be claimed, retried, completed again, or restarted.

`attempt` starts at zero and increments on every claim or expired-lease reclaim. A claimant must present the exact current subject and attempt when marking a job retryable or completed. The transition succeeds only while that claim's lease remains active. This compare-and-set rule prevents a stale worker from changing a job after another worker has reclaimed it.

The completed row deliberately has no foreign key to `users`: later deletion work may remove the user row while retaining the minimal terminal tombstone needed for idempotency. The repository verifies that a local user exists when it creates the first job. An already-existing terminal row remains readable internally after user removal.

## Repository contract

`AuthStore` provides the same operations in D1 and the test-only memory implementation:

- `startAccountDeletionJob(subject, now)` creates a pending row once and otherwise returns the existing row unchanged. An unknown subject fails with `account_deletion_subject_not_found`.
- `getAccountDeletionJob(subject)` performs one exact-subject lookup.
- `claimAccountDeletionJobs(now, leaseSeconds, limit)` claims only eligible pending, retryable, or lease-expired running rows. The batch is limited to 25 and the lease to five minutes. Invalid bounds fail before mutation.
- `retryAccountDeletionJob(subject, attempt, now, retryAt)` conditionally defers one live claim; `retryAt` must be later than `now`.
- `completeAccountDeletionJob(subject, attempt, now)` conditionally moves one live claim to its terminal state.

Claim selection is finite and oldest-eligible-first by availability time, creation time, and subject. The repository returns only the selected internal job fields. It never returns a D1 `rowid` or another deployment/physical identifier.

## Isolation and exposure

The local subject is required internally so a later coordinator can purge exactly one owner. Every lookup and state transition binds that exact subject, and every transition also binds its current attempt. A subject or attempt mismatch changes no row.

No current HTTP, hypermedia, HTML, OpenAPI, logging, or audit surface exposes this repository model. Future request and status tasks must authorize the current Sites identity independently and render only the caller's coarse state. They must not serialize the subject, attempt, availability timestamp, database details, or batch claims.

## Subject authorization

`src/subject-access.ts` is the only domain-level interpretation of deletion-job presence. A subject with no job is active. A subject with a pending, running, retryable, or completed job is inactive; the completed tombstone permanently prevents the removed identity's old credentials from becoming valid again.

The shared check runs before all AittaDB token issuance and in the common access-token verifier. Current-session issuance and `/session` therefore fail after start, and UserInfo, introspection, storage, and other access-token consumers reject credentials already issued to that subject. Refresh exchange consumes the presented one-time refresh token but performs the shared check before issuing or persisting any successor. Storage reaches neither namespace lookup, namespace rate limiting, data disclosure, nor mutation after this denial. Adapters expose only generic authentication errors and never reveal whether a deletion job exists or which state it has.

`startSubjectAccountDeletion` is the internal start boundary for future adapters. It rejects an exact subject configured in `ADMIN_SUBJECTS` before calling the repository, preventing an operator from deleting the identity needed to administer that deployment. For other subjects it preserves the repository's idempotent start result. It does not authorize an HTTP caller; TASK-152 owns that separate boundary.

## Failure behavior

An expired running lease becomes eligible for another bounded claim. A stale claimant then loses its compare-and-set transition. Retry scheduling is explicit and durable. `completed` is terminal and repeated starts return it without changing timestamps or resurrecting work.

These primitives do not delete anything. Interruption-safe purging, R2 compensation, final user removal, request authorization, and status representation are separate PLAN tasks and must not be inferred from the presence of this table.
