# Account-Deletion Coordination

This document defines the authenticated request and coarse-status operations plus the internal durable job, subject gate, bounded purge, R2-retirement, coordinator, clean finalization, and post-deletion isolation contracts. `POST /account/deletion` can start deletion for the current eligible local AittaDB account. With the separate encrypted handle issued on first acceptance, content-negotiated `GET /account/deletion` reports only pending, running, retry, or completed plus one currently valid refresh/recovery action. There is no deployment-wide deletion control or special re-registration route.

## State model

Migration `0008_account_deletion_jobs.sql` stores one row per immutable local AittaDB subject. The subject itself is the primary key; the table is `WITHOUT ROWID` and has no job ID, deployment ID, project ID, client ID, email address, physical storage key, credential, or error text.

The states are:

- `pending`: an idempotent start created the job, and it is immediately claimable;
- `running`: a bounded worker claim is active until `available_at`;
- `retryable`: a current claimant deferred work until `available_at`;
- `completed`: terminal; it cannot be claimed, retried, completed again, or restarted.

`attempt` starts at zero and increments on every claim or expired-lease reclaim. Retry and finalization require the exact current subject and attempt while its lease remains active. A stale worker cannot change a reclaimed job. `completed` is reachable only through clean finalization; migrations `0010_account_deletion_finalization.sql` and `0016_account_deletion_events.sql` reject direct or dirty terminal transitions, including transitions with owned events.

The completed row deliberately has no foreign key to `users`: later deletion work may remove the user row while retaining the minimal terminal tombstone needed for idempotency. The repository verifies that a local user exists when it creates the first job. An already-existing terminal row remains readable internally after user removal.

## Repository contract

`AuthStore` provides the same operations in D1 and the test-only memory implementation:

- `getUserByEmail(email)` reads one existing local user by the exact canonical email and never creates or updates identity state.
- `startAccountDeletionJob(subject, now)` creates a pending row once and otherwise returns the existing row unchanged. An unknown subject fails with `account_deletion_subject_not_found`.
- `getAccountDeletionJob(subject)` performs one exact-subject lookup.
- `claimAccountDeletionJobs(now, leaseSeconds, limit)` claims only eligible pending, retryable, or lease-expired running rows. The batch is limited to 25 and the lease to five minutes. Invalid bounds fail before mutation.
- `retryAccountDeletionJob(subject, attempt, now, retryAt)` conditionally defers one live claim; `retryAt` must be later than `now`.
- `finalizeAccountDeletion(subject, attempt, now)` unlinks at most 100 matching audit actor attributions in deterministic creation/ID order, then conditionally removes the local user and completes one clean live claim in the same D1 batch. Partial unlink progress commits and returns `false`; a matching clean completed attempt is idempotent.
- `purgeAccountCredentialsAndGrants(subject, limit)` deletes at most 100 owned credential/grant rows and returns only aggregate `deletedCount` and `done` progress. It refuses a subject without a deletion job.
- `purgeAccountRecords(subject, limit)` deletes at most 100 owned legacy or bounded-protocol JSON records across client namespaces and returns only aggregate `deletedCount` and `done` progress. It refuses a subject without the exact deletion job.
- `stageExpiredAccountFileWriteFences(subject, attempt, now, limit)` converts at most 25 expired in-flight R2 writes into durable repair rows before removing their fences.

Claim selection is finite and oldest-eligible-first by availability time, creation time, and subject. The repository returns only the selected internal job fields. It never returns a D1 `rowid` or another deployment/physical identifier.

## Credential and grant purge

One purge call spends a single finite row budget in this fixed child-before-parent order: authorization codes, authorization requests with no remaining code, device grants, consents, refresh tokens, empty refresh-token families, revoked access-token identifiers, and administrator operation submissions. Rows within a phase use an eligibility timestamp and stable identifier as tie-breakers. Repeated calls converge without a caller cursor; a completed retry returns zero deletions and `done: true`.

Every deletion predicate binds the exact local subject. OAuth clients, the reserved browser client, users, account-deletion jobs, records, file metadata/bytes, audit/rate state, configuration, and signing material are outside this primitive. Client IDs only partition owned grants and are never deletion targets. Administrator submissions are removed explicitly and do not rely on `ON DELETE CASCADE` or D1 foreign-key pragma state.

AittaDB browser access credentials remain stateless, short-lived, and unpersisted. The deletion-job authorization gate prevents new browser credentials and rejects already issued ones; the purge must not introduce a session table merely to delete it. The upstream ChatGPT Sites session remains Sites-owned and outside AittaDB's credential boundary.

Migration `0009_account_credential_purge.sql` adds subject-and-order indexes for every phase and attributes new revocation rows to the verified JWT subject so they can be purged safely. Pre-migration revocations remain nullable and are retained because their owner cannot be proven. This favors replay protection and tenant isolation over speculative deletion.

## Isolation and exposure

The local subject is required internally so the coordinator can purge exactly one owner. Every claim transition and finalization binds that subject and current attempt. A subject or attempt mismatch changes no row.

No HTTP, hypermedia, HTML, OpenAPI, logging, or audit surface exposes the repository model directly. The request operation renders only an encrypted confirmation before start and a coarse accepted response afterward. The status operation maps `retryable` to public `retry` and otherwise exposes only pending, running, or completed; it never serializes the subject, email, internal state name, attempt, availability or other timestamp, database detail, batch count, client/namespace value, credential, or storage identifier.

## Subject authorization

`src/subject-access.ts` is the only domain-level interpretation of deletion-job presence. A subject with no job is active. A subject with a pending, running, retryable, or completed job is inactive; the completed tombstone permanently prevents the removed identity's old credentials from becoming valid again.

The shared check runs before all AittaDB token issuance and in the common access-token verifier. Current-session issuance and `/session` therefore fail after start, and UserInfo, introspection, storage, and other access-token consumers reject credentials already issued to that subject. Refresh exchange consumes the presented one-time refresh token but performs the shared check before issuing or persisting any successor. Storage reaches neither namespace lookup, namespace rate limiting, data disclosure, nor mutation after this denial. Adapters expose only generic authentication errors and never reveal whether a deletion job exists or which state it has.

`startSubjectAccountDeletion` is the internal start boundary. It rejects an exact subject configured in `ADMIN_SUBJECTS` before calling the repository, preventing an operator from deleting the identity needed to administer that deployment. For other subjects it preserves the repository's idempotent start result. The HTTP adapter independently authorizes the current trusted Sites identity before invoking it.

## Authenticated request operation

An active non-administrator `GET /session` representation advertises `request-account-deletion` only when D1, R2, and background execution are available. HTML and versioned hypermedia carry the same three body fields: the protected CSRF value, an explicit `delete my account` phrase, and a short-lived AES-GCM confirmation. HKDF derives a purpose-specific key from private signing-key material. Authenticated additional data binds the token to its purpose, exact issuer, current local subject, and exact trusted Sites email; ciphertext reveals none of those values. Expiry, tampering, key or issuer rotation, email change, and cross-account reuse fail closed.

`POST /account/deletion` is the only canonical mutation and accepts strict URL-encoded or JSON input up to 1 KiB. The shared browser-origin classifier rejects invalid origin state before pulling the body. The adapter then applies atomic per-IP pseudonymous and deployment-global rate counters, resolves trusted Sites identity, and calls only `getUserByEmail`. It never calls `findOrCreateUser`, updates display identity, trusts browser identity fields, accepts CORS, or starts a job for an administrator.

Before the first valid request creates the pending job, it seals a distinct account-deletion status handle. The status key uses its own HKDF purpose and the AES-GCM additional data uses its own purpose; issuer, configured key ID, exact trusted email, and private key material are bound outside ciphertext, while the old local subject and exact seven-day lifetime are authenticated and encrypted. Confirmation and status values cannot be opened as each other. The accepted no-store `202` HTML or versioned hypermedia contains only `accepted: true` and a status action. It sets `aittadb_account_deletion_status` without a `Domain` attribute and with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/account/deletion`, and `Max-Age=604800`. It schedules one caught `coordinateAccountDeletionBatch` promise through `waitUntil`; background rejection cannot replace that response. A pre-existing job or replay returns the same generic rejection as stale identity/confirmation state, changes no existing job, issues no status cookie, and schedules no second coordinator nudge.

`GET /account/deletion` first reads the trusted Sites identity and path-scoped cookie, then authenticates and decrypts the handle using the exact current email, issuer, key ID, and key material. The former subject comes only from authenticated ciphertext: GET never calls `getUserByEmail`, `findOrCreateUser`, or any other identity reconstruction. Missing identity/handle, malformed encoding, expiry, tampering, wrong key ID/material or issuer, and a switched account all receive one generic no-store response before store availability checks, D1/R2 access, cleanup, rate limiting, or coordinator creation. A cryptographically valid handle makes one exact `getAccountDeletionJob(subject)` read. A missing matching job receives the same coarse client error and schedules nothing. Missing D1, or a valid noncompleted job without R2/`waitUntil`, receives a coarse no-store `503` and schedules nothing.

Successful HTML and hypermedia representations contain only `{ status }` and exactly one equivalent current status action. Pending and running refresh the same URI; retry recovers through the same URI; the completed status action offers only Sites-owned `/signout-with-chatgpt?return_to=%2F`, never `/`, `/session`, or another identity-aware route. Shared brand/footer navigation remains presentation-level navigation, not a status recovery action. Every successful noncompleted GET starts exactly one caught bounded coordinator promise; completed GETs start none. The seven-day cookie keeps reloads stateless and safe across removal of the user row without making browser state authoritative. Issuer, key-ID, or private-key rotation invalidates it immediately. The operation affects only the encrypted former subject and exposes no deployment-wide deletion action or new-account state.

## Record purge

`AccountRecordPurgeRepository.purgeAccountRecords(subject, limit)` deletes only D1 legacy and bounded-protocol JSON records whose `user_id` is the exact local subject, across all of that subject's client namespaces. The subject must already have an account-deletion job in any state, including the completed tombstone; a missing exact-subject job fails before mutation. The method has no HTTP or OpenAPI representation and returns only an internal deleted count and completion flag, never collections, record keys, client IDs, values, email, or database identifiers.

Each call deletes at most 100 rows. It selects bounded records first in deterministic `client_id`, collection, and stable-ID order, then spends the remaining budget on legacy `client_id` and logical-key order. Committed row removal is the durable progress marker, so no cursor or separate progress table is needed. A result is complete when fewer rows than requested were removed and neither record family has remaining rows. An exact multiple deliberately requires one final empty call, which makes interruption and retries idempotent without storing a last key.

D1 performs both bounded removals in one transactional prepared-statement batch. A statement failure commits no partial batch and is propagated as an internal failure rather than a false completed result. The memory adapter applies the same ordering and bounds for tests. Record and file usage is calculated from live legacy, bounded-protocol, and file rows, so each successful deletion immediately releases the corresponding deployment, subject, and namespace record item/byte capacity while preserving file usage. Files, R2 bytes, users, clients, credentials, grants, deletion jobs, repair state, audit state, rate counters, every other subject, and all other tables are outside this primitive.

## Event purge

`AccountEventPurgeRepository.purgeAccountEvents(subject, attempt, now, limit)` deletes only immutable application events owned by one human subject across that subject's client namespaces. It is internal and has no HTTP, HTML, hypermedia, or OpenAPI surface. Each call requires the exact running attempt and an unexpired lease, removes at most 100 rows in deterministic client/sequence order through one prepared statement, and returns only `{ deletedCount, done }`. Committed row absence is the resume position; an exact multiple requires one final empty call.

The D1 statement checks both the live claim and `principal_type = 'user'`, so a stale worker, missing job, completed tombstone, or service principal cannot authorize deletion. The memory repository applies the same checks and ordering. A failed statement commits no partial batch and reports one generic internal failure. Events belonging to another subject or any service principal remain untouched. Migration `0016_account_deletion_events.sql` adds an independent event-specific terminal-state guard; runtime finalization repeats that absence check. Migration `0013` and both append repositories already reject every new event write after deletion starts.

## Coordinator and finalization

`coordinateAccountDeletionBatch` claims at most one job for five minutes and performs one finite pass: convert at most 25 expired file-write fences, purge at most 100 credentials/grants, 100 records, and 100 events, then stage/repair at most 25 files. Incomplete or failed work is deferred for 30 seconds. Each committed absence is its own durable cursor, so interruption after any phase and exact batch multiples converge on later calls.

Every file upload reserves a durable owner/client fence before its R2 `put`. A deletion job may start while an earlier fence exists, but no new fence or subject-owned D1 row may be reserved afterward. The physical R2 key is a random `objects/<uuid>` value and custom object metadata contains no subject, client, or logical key. Metadata failure retires the object before clearing the fence; if retirement fails, one atomic D1 batch creates/updates durable repair state before deleting the fence. Expiry follows the same repair-before-clear rule. Finalization counts all fences regardless of expiry.

File repair classifies references globally. Any metadata reference owned by another subject/client is a conflict: the repair and bytes remain, the deletion stays retryable, and finalization fails closed. It never treats a foreign reference as successful retirement.

Finalization is one transactional D1 batch. It first clears at most 100 matching `actor_subject_hash` values ordered by `created_at, id`; the audit rows and generic audit data remain. If more matching attribution remains, the batch commits that bounded progress, preserves the user, and returns incomplete. Otherwise it removes the user only when the exact claim is still running with an unexpired lease and no subject-owned credentials, grants, legacy records, bounded-protocol records, application events, file metadata, fences, repairs, or administrator submissions remain, then marks that same job completed. Migration `0018_bounded_storage_records.sql` adds an independent dirty-completion guard for the new record table, and runtime reconciliation repeats that absence check. An uncertain response is reconciled by reading the clean terminal state. User lookup by email and aggregate identity statistics reflect removal immediately. OAuth clients, other users and namespaces, anonymous pending flows, audit events, and rate counters are not deletion targets.

## Retained security state

The completed job is a permanent pseudonymous tombstone keyed by the former local UUID. This linkable UUID is the explicit minimal exception needed to keep deletion idempotent and permanently reject old credentials; the row contains only state, attempt, and timestamps, never email, display name, content, client/key identifiers, credentials, hashes derived from content, or repair details.

Migration `0011_audit_actor_attribution.sql` moves only canonical 43-character unpadded SHA-256 base64url legacy `actor_subject_hash` values out of generic audit JSON into one nullable indexed column. It removes that member from every valid legacy JSON object, leaving malformed attribution null without deleting or rewriting unrelated event data. Both repositories reject malformed new attribution before mutation. New administration audits use the structured column, while the client reference remains bounded generic data. Account deletion clears matching actor attribution before user removal but retains the redacted event under the ordinary 90-day policy. Rate counters use a SHA-256 owner key and remain until the ordinary five-minute cleanup threshold. The tombstone is the only permanent subject-linkable deletion exception; short-lived rate state follows ordinary cleanup. Unattributable pre-migration revoked JTIs remain until expiry because ownership cannot be proven safely.

## Post-deletion registration

After clean completion removes the old user and exact-email index, the next ordinary identity-resolving request for that email creates one new immutable UUID; concurrent or repeated requests retain that canonical UUID. The new subject starts with no consent, credentials, records, files, application events, administrator submission state, or connection to the former subject. Its namespaces are empty even when it uses a client that the former subject also used.

The deletion-status handle continues to decrypt only the former UUID and read only its completed tombstone. Status reads never resolve the email, create identity, reveal either UUID, or reconnect the new account. AittaDB endpoints reject old access tokens immediately, and old refresh tokens cannot rotate. Previously issued access and ID JWTs remain self-contained: a signature-only external verifier can still validate them for the former subject until their signed expiration, but they never identify or gain authority over the replacement subject. External resource servers that require immediate deletion or revocation awareness must use introspection or an equivalent deployment policy rather than signature-only validation.

AittaDB still receives only an email identity signal from Sites and cannot determine whether a later holder is the same person. Email change or reassignment therefore remains an explicit upstream-identity limitation even though completed deletion prevents inheritance of the old AittaDB UUID and namespace.

## Failure behavior

An expired running lease becomes eligible for another bounded claim. A stale claimant then loses its compare-and-set transition. Retry scheduling is explicit and durable. `completed` is terminal and repeated starts return it without changing timestamps or resurrecting work. Record-purge retries start from the first remaining owned row; a repeated completed batch changes nothing.

Purge phases are separate prepared D1 statements. If one fails, earlier subject-owned deletions remain committed and a retry resumes idempotently. Parent rows stay while any child remains, including a corrupt cross-subject reference; this blocks convergence rather than authorizing cross-subject deletion. Migrations `0010` and `0013` close pre-check/write races for subject-owned rows, including application events. The memory adapter applies the same invariant at its write boundary.

The record purge is one atomic prepared-statement batch across both record tables; a statement failure removes no partial batch. The coordinator repeats every idempotent phase to `done`, and finalization rechecks all owned tables inside its atomic transition.

An internally caught coordinator failure emits one private `account-deletion.coordinator.failed` Worker-log event with only a fixed phase: `fences`, `credentials`, `records`, `events`, `files`, or `finalization`. The final value also covers retry scheduling and completion reconciliation. The event has no subject, email, request, SQL, logical or physical key, exception, credential, configuration, or secret. Successful passes emit nothing, telemetry failures never alter durable progress, and there is no HTTP, hypermedia, OpenAPI, or configuration surface for this diagnostic.

A pass that commits a durable retry emits one private `account-deletion.coordinator.deferred` event with only the first incomplete phase in fixed execution order: `credentials`, `records`, `events`, `files`, or `finalization`. It contains no count or other progress detail and follows the same redaction and observer-isolation rules. A completed pass, a pass that claims no job, and a stale claimant emit no deferred event.

When the D1 credential purge fails, it additionally emits one private `account-deletion.credentials.failed` event whose only detail is the fixed repository subphase: `job`, `authorization-codes`, `authorization-requests`, `device-grants`, `consents`, `refresh-tokens`, `refresh-families`, `access-revocations`, `admin-submissions`, or `remaining-check`. The repository replaces the adapter error with a generic internal error carrying that enum; the original exception and SQL never reach telemetry. Successful credential purges emit nothing.

The final credential remaining check is one prepared `SELECT` with subject-bound `EXISTS` predicates for every owned credential/grant table. It deliberately avoids a compound `UNION ALL` query because the deployed Sites D1 adapter rejected that form even though local SQLite accepted it. The single-row-or-null result preserves the same bounded `done` contract without returning table data.

Request authorization, coarse status representation, and bounded coordinator work remain separate units. The status GET can nudge one coordinator pass only after its cryptographic binding and exact job lookup succeed; it cannot select a subject, inspect internal progress, create a replacement identity, or initiate deployment-wide work.
