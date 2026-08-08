# Account-Deletion Coordination

This document defines the internal durable job, subject gate, bounded purge, R2-retirement, coordinator, and clean finalization primitives for the future self-service account-deletion flow. They add no HTTP route, status resource, browser interface, or re-registration policy.

## State model

Migration `0008_account_deletion_jobs.sql` stores one row per immutable local AittaDB subject. The subject itself is the primary key; the table is `WITHOUT ROWID` and has no job ID, deployment ID, project ID, client ID, email address, physical storage key, credential, or error text.

The states are:

- `pending`: an idempotent start created the job, and it is immediately claimable;
- `running`: a bounded worker claim is active until `available_at`;
- `retryable`: a current claimant deferred work until `available_at`;
- `completed`: terminal; it cannot be claimed, retried, completed again, or restarted.

`attempt` starts at zero and increments on every claim or expired-lease reclaim. Retry and finalization require the exact current subject and attempt while its lease remains active. A stale worker cannot change a reclaimed job. `completed` is reachable only through clean finalization; migration `0010_account_deletion_finalization.sql` rejects direct terminal inserts and dirty terminal transitions.

The completed row deliberately has no foreign key to `users`: later deletion work may remove the user row while retaining the minimal terminal tombstone needed for idempotency. The repository verifies that a local user exists when it creates the first job. An already-existing terminal row remains readable internally after user removal.

## Repository contract

`AuthStore` provides the same operations in D1 and the test-only memory implementation:

- `startAccountDeletionJob(subject, now)` creates a pending row once and otherwise returns the existing row unchanged. An unknown subject fails with `account_deletion_subject_not_found`.
- `getAccountDeletionJob(subject)` performs one exact-subject lookup.
- `claimAccountDeletionJobs(now, leaseSeconds, limit)` claims only eligible pending, retryable, or lease-expired running rows. The batch is limited to 25 and the lease to five minutes. Invalid bounds fail before mutation.
- `retryAccountDeletionJob(subject, attempt, now, retryAt)` conditionally defers one live claim; `retryAt` must be later than `now`.
- `finalizeAccountDeletion(subject, attempt, now)` conditionally removes the local user and completes one clean live claim in the same D1 batch. A matching clean completed attempt is idempotent.
- `purgeAccountCredentialsAndGrants(subject, limit)` deletes at most 100 owned credential/grant rows and returns only aggregate `deletedCount` and `done` progress. It refuses a subject without a deletion job.
- `purgeAccountRecords(subject, limit)` deletes at most 100 owned JSON records across client namespaces and returns only aggregate `deletedCount` and `done` progress. It refuses a subject without the exact deletion job.
- `stageExpiredAccountFileWriteFences(subject, attempt, now, limit)` converts at most 25 expired in-flight R2 writes into durable repair rows before removing their fences.

Claim selection is finite and oldest-eligible-first by availability time, creation time, and subject. The repository returns only the selected internal job fields. It never returns a D1 `rowid` or another deployment/physical identifier.

## Credential and grant purge

One purge call spends a single finite row budget in this fixed child-before-parent order: authorization codes, authorization requests with no remaining code, device grants, consents, refresh tokens, empty refresh-token families, revoked access-token identifiers, and administrator operation submissions. Rows within a phase use an eligibility timestamp and stable identifier as tie-breakers. Repeated calls converge without a caller cursor; a completed retry returns zero deletions and `done: true`.

Every deletion predicate binds the exact local subject. OAuth clients, the reserved browser client, users, account-deletion jobs, records, file metadata/bytes, audit/rate state, configuration, and signing material are outside this primitive. Client IDs only partition owned grants and are never deletion targets. Administrator submissions are removed explicitly and do not rely on `ON DELETE CASCADE` or D1 foreign-key pragma state.

AittaDB browser access credentials remain stateless, short-lived, and unpersisted. The deletion-job authorization gate prevents new browser credentials and rejects already issued ones; the purge must not introduce a session table merely to delete it. The upstream ChatGPT Sites session remains Sites-owned and outside AittaDB's credential boundary.

Migration `0009_account_credential_purge.sql` adds subject-and-order indexes for every phase and attributes new revocation rows to the verified JWT subject so they can be purged safely. Pre-migration revocations remain nullable and are retained because their owner cannot be proven. This favors replay protection and tenant isolation over speculative deletion.

## Isolation and exposure

The local subject is required internally so the coordinator can purge exactly one owner. Every claim transition and finalization binds that subject and current attempt. A subject or attempt mismatch changes no row.

No current HTTP, hypermedia, HTML, OpenAPI, logging, or audit surface exposes this repository model. Future request and status tasks must authorize the current Sites identity independently and render only the caller's coarse state. They must not serialize the subject, attempt, availability timestamp, database details, or batch claims.

## Subject authorization

`src/subject-access.ts` is the only domain-level interpretation of deletion-job presence. A subject with no job is active. A subject with a pending, running, retryable, or completed job is inactive; the completed tombstone permanently prevents the removed identity's old credentials from becoming valid again.

The shared check runs before all AittaDB token issuance and in the common access-token verifier. Current-session issuance and `/session` therefore fail after start, and UserInfo, introspection, storage, and other access-token consumers reject credentials already issued to that subject. Refresh exchange consumes the presented one-time refresh token but performs the shared check before issuing or persisting any successor. Storage reaches neither namespace lookup, namespace rate limiting, data disclosure, nor mutation after this denial. Adapters expose only generic authentication errors and never reveal whether a deletion job exists or which state it has.

`startSubjectAccountDeletion` is the internal start boundary for future adapters. It rejects an exact subject configured in `ADMIN_SUBJECTS` before calling the repository, preventing an operator from deleting the identity needed to administer that deployment. For other subjects it preserves the repository's idempotent start result. It does not authorize an HTTP caller; TASK-152 owns that separate boundary.

## Record purge

`AccountRecordPurgeRepository.purgeAccountRecords(subject, limit)` deletes only D1 JSON records whose `user_id` is the exact local subject, across all of that subject's client namespaces. The subject must already have an account-deletion job in any state, including the completed tombstone; a missing exact-subject job fails before the delete statement. The method has no HTTP or OpenAPI representation and returns only an internal deleted count and completion flag, never record keys, client IDs, values, email, or database identifiers.

Each call deletes at most 100 rows in deterministic `client_id`, then logical-key order. Committed row removal is the durable progress marker, so no cursor or separate progress table is needed. A result is complete when fewer rows than requested were removed. An exact multiple deliberately requires one final empty call, which makes interruption and retries idempotent without storing a last key.

D1 performs the bounded removal in one prepared `DELETE` statement. A statement failure commits no partial batch and is propagated as an internal failure rather than a false completed result. The memory adapter applies the same ordering and bounds for tests. Record and file usage is calculated from live rows, so each successful deletion immediately releases the corresponding deployment, subject, and namespace record item/byte capacity while preserving file usage. Files, R2 bytes, users, clients, credentials, grants, deletion jobs, repair state, audit state, rate counters, every other subject, and all other tables are outside this primitive.

## Coordinator and finalization

`coordinateAccountDeletionBatch` claims at most one job for five minutes and performs one finite pass: convert at most 25 expired file-write fences, purge at most 100 credentials/grants, purge at most 100 records, and stage/repair at most 25 files. Incomplete or failed work is deferred for 30 seconds. Each committed absence is its own durable cursor, so interruption after any phase and exact batch multiples converge on later calls.

Every file upload reserves a durable owner/client fence before its R2 `put`. A deletion job may start while an earlier fence exists, but no new fence or subject-owned D1 row may be reserved afterward. The physical R2 key is a random `objects/<uuid>` value and custom object metadata contains no subject, client, or logical key. Metadata failure retires the object before clearing the fence; if retirement fails, one atomic D1 batch creates/updates durable repair state before deleting the fence. Expiry follows the same repair-before-clear rule. Finalization counts all fences regardless of expiry.

File repair classifies references globally. Any metadata reference owned by another subject/client is a conflict: the repair and bytes remain, the deletion stays retryable, and finalization fails closed. It never treats a foreign reference as successful retirement.

Finalization is one transactional D1 batch. It removes the user only when the exact claim is still running with an unexpired lease and no subject-owned credentials, grants, records, file metadata, fences, repairs, or administrator submissions remain; it then marks that same job completed. A trigger independently rejects dirty completion. An uncertain batch response is reconciled by reading the clean terminal state. User lookup by email and aggregate identity statistics reflect removal immediately. OAuth clients, other users and namespaces, anonymous pending flows, audit events, and rate counters are not deletion targets.

## Retained security state

The completed job is a permanent pseudonymous tombstone keyed by the former local UUID. This linkable UUID is the explicit minimal exception needed to keep deletion idempotent and permanently reject old credentials; the row contains only state, attempt, and timestamps, never email, display name, content, client/key identifiers, credentials, hashes derived from content, or repair details.

Existing redacted audit rows are retained under the ordinary 90-day security policy. Current administration audits contain only event type, timestamps, and bounded hashed actor/client references. Rate counters use a SHA-256 owner key and remain only until the ordinary five-minute cleanup threshold. Those pseudonymous, bounded security records are not traversed or enriched during deletion and contain no email, display name, raw UUID, credential, logical/physical storage key, content, or repair detail. Unattributable pre-migration revoked JTIs remain until ordinary expiry because ownership cannot be proven safely.

## Failure behavior

An expired running lease becomes eligible for another bounded claim. A stale claimant then loses its compare-and-set transition. Retry scheduling is explicit and durable. `completed` is terminal and repeated starts return it without changing timestamps or resurrecting work. Record-purge retries start from the first remaining owned row; a repeated completed batch changes nothing.

Purge phases are separate prepared D1 statements. If one fails, earlier subject-owned deletions remain committed and a retry resumes idempotently. Parent rows stay while any child remains, including a corrupt cross-subject reference; this blocks convergence rather than authorizing cross-subject deletion. Migration `0010` closes pre-check/write races with D1 insert and ownership-update triggers on every subject-bearing credential, grant, record, file, administrator-submission, and fence table. The memory adapter applies the same invariant at its write boundary.

The record purge is one atomic prepared statement per batch; a statement failure removes no partial batch. The coordinator repeats every idempotent phase to `done`, and finalization rechecks all owned tables inside its atomic transition.

Request authorization, status representation, browser/API operations, and re-registration semantics remain separate tasks. No caller can currently initiate or inspect this coordinator through HTTP.
