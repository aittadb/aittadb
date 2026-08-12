import { sha256, uuid } from "../crypto";
import { assertAuditEventAttribution } from "../audit";
import { assertAccountFilePurgeInput } from "../account-file-purge";
import {
  APPLICATION_EVENT_CLEANUP_BATCH_SIZE,
  assertApplicationEvent,
  assertApplicationEventInput,
  assertApplicationEventLimits,
  assertApplicationEventLookupInput,
  assertApplicationEventPageInput,
} from "../application-events";
import {
  AUDIT_RETENTION_SECONDS,
  CLEANUP_BATCH_SIZE,
  CLEANUP_CATEGORY_LIMITS,
  createCleanupReport,
  RATE_COUNTER_RETENTION_SECONDS,
  REFRESH_FAMILY_ORPHAN_GRACE_SECONDS,
} from "./cleanup";
import type { CleanupCategory, CleanupReport } from "./cleanup";
import {
  assertStorageFileWriteFenceBatchLimit,
  assertStorageFileWriteFence,
  STORAGE_FILE_WRITE_FENCE_CLEANUP_BATCH,
} from "../storage-file-write-fence";
import {
  ACCOUNT_DELETION_AUDIT_UNLINK_BATCH,
  accountDeletionClaimExpiry,
  assertAccountDeletionNow,
  assertAccountDeletionRetryAt,
} from "./account-deletion";
import {
  AccountCredentialPurgeFailure,
  accountCredentialPurgeUnavailable,
  assertAccountCredentialPurgeLimit,
} from "./account-credential-purge";
import {
  accountEventPurgeBatch,
  accountEventPurgeUnavailable,
  assertAccountEventPurgeInput,
} from "./account-event-purge";
import {
  accountRecordPurgeBatch,
  accountRecordPurgeUnavailable,
  assertAccountRecordPurgeInput,
} from "./account-record-purge";
import {
  BROWSER_SESSION_CLIENT_ID,
  isBrowserSessionClientId,
} from "../system-client";
import {
  BOUNDED_RECORD_MAX_PAGE_SIZE,
  boundedRecordDocument,
  decodeBoundedRecordKey,
} from "../bounded-record-protocol";
import type {
  BoundedRecordMutation,
  BoundedRecordTransactionCommand,
  BoundedRecordValue,
} from "../bounded-record-protocol";
import {
  BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD,
  BOUNDED_RECORD_RECEIPT_DEFAULT_LIMITS,
  BOUNDED_RECORD_RECEIPT_DEFAULT_RETENTION_SECONDS,
  parseBoundedStorageTransactionResult,
  prepareBoundedStorageTransaction,
} from "../bounded-record-transaction";
import type { PreparedBoundedStorageTransaction } from "../bounded-record-transaction";
import type {
  AccountDeletionJob,
  AccountDeletionJobStartResult,
  AccountCredentialPurgeBatchResult,
  AccountEventPurgeBatch,
  AccountFilePurgeStageResult,
  AccountRecordPurgeBatch,
  ApplicationEvent,
  ApplicationEventAppendResult,
  ApplicationEventInput,
  ApplicationEventLimits,
  ApplicationEventPage,
  AuditEventAttribution,
  AuthStore,
  AuthorizationCode,
  AuthorizationRequest,
  BoundedStorageTransactionOptions,
  ClientRegistrationInput,
  ClientView,
  DeviceGrant,
  LocalUser,
  RefreshTokenFamily,
  RefreshTokenRecord,
  BoundedStorageRecord,
  BoundedStorageRecordPage,
  BoundedStorageTransactionResult,
  StorageFileMetadata,
  StorageFileOrphanRepair,
  StorageFileOrphanRepairDisposition,
  StorageFileWriteFence,
  StorageLimits,
  StorageListPage,
  StorageListPosition,
  StorageRecord,
  StorageUsage,
  UpstreamIdentity,
} from "../types";

type Row = Record<string, unknown>;

const MAX_RATE_COUNTERS = 10_000;

const RESOLVE_LOCAL_USER = `
INSERT INTO users (id, email, display_name, created_at, updated_at, principal_type)
VALUES (?1, ?2, ?3, ?4, ?4, 'user')
ON CONFLICT(email) DO UPDATE SET
  display_name = excluded.display_name,
  updated_at = excluded.updated_at
WHERE users.principal_type = 'user'
RETURNING id, email, display_name, created_at, updated_at`;

const APPEND_APPLICATION_EVENT = `
INSERT INTO application_events (
  id, user_id, client_id, event_type, data_json, data_bytes,
  idempotency_key_hash, request_hash, created_at, expires_at
)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)
  AND EXISTS (
    SELECT 1 FROM oauth_clients WHERE id = ?3 AND disabled_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM account_deletion_jobs WHERE subject = ?2
  )
  AND (SELECT COUNT(*) FROM application_events) < ?11
  AND (SELECT COALESCE(SUM(data_bytes), 0) FROM application_events) + ?6 <= ?12
  AND (SELECT COUNT(*) FROM application_events WHERE user_id = ?2) < ?13
  AND (SELECT COALESCE(SUM(data_bytes), 0) FROM application_events WHERE user_id = ?2) + ?6 <= ?14
  AND (SELECT COUNT(*) FROM application_events WHERE user_id = ?2 AND client_id = ?3) < ?15
  AND (SELECT COALESCE(SUM(data_bytes), 0) FROM application_events WHERE user_id = ?2 AND client_id = ?3) + ?6 <= ?16
ON CONFLICT DO NOTHING
RETURNING *`;

const SELECT_APPLICATION_EVENT_REPLAY = `
SELECT event.*
FROM application_events event
WHERE event.user_id = ?1
  AND event.client_id = ?2
  AND event.idempotency_key_hash = ?3
  AND EXISTS (SELECT 1 FROM users WHERE id = ?1)
  AND EXISTS (
    SELECT 1 FROM oauth_clients WHERE id = ?2 AND disabled_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM account_deletion_jobs WHERE subject = ?1
  )
LIMIT 1`;

const CLASSIFY_APPLICATION_EVENT_ADMISSION = `
SELECT
  CASE WHEN EXISTS (SELECT 1 FROM users WHERE id = ?1)
    AND EXISTS (SELECT 1 FROM oauth_clients WHERE id = ?2 AND disabled_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = ?1)
    THEN 1 ELSE 0 END AS active,
  CASE WHEN EXISTS (SELECT 1 FROM application_events WHERE id = ?3)
    THEN 1 ELSE 0 END AS id_exists,
  CASE WHEN (SELECT COUNT(*) FROM application_events) >= ?5
    OR (SELECT COALESCE(SUM(data_bytes), 0) FROM application_events) + ?4 > ?6
    OR (SELECT COUNT(*) FROM application_events WHERE user_id = ?1) >= ?7
    OR (SELECT COALESCE(SUM(data_bytes), 0) FROM application_events WHERE user_id = ?1) + ?4 > ?8
    OR (SELECT COUNT(*) FROM application_events WHERE user_id = ?1 AND client_id = ?2) >= ?9
    OR (SELECT COALESCE(SUM(data_bytes), 0) FROM application_events WHERE user_id = ?1 AND client_id = ?2) + ?4 > ?10
    THEN 1 ELSE 0 END AS quota_exceeded`;

const ACCOUNT_CREDENTIAL_PURGE_DELETIONS = [
  {
    phase: "authorization-codes",
    sql: "DELETE FROM authorization_codes WHERE code_hash IN (SELECT code_hash FROM authorization_codes WHERE user_id = ? ORDER BY expires_at ASC, code_hash ASC LIMIT ?)",
  },
  {
    phase: "authorization-requests",
    sql: "DELETE FROM authorization_requests WHERE id IN (SELECT ar.id FROM authorization_requests ar WHERE ar.user_id = ? AND NOT EXISTS (SELECT 1 FROM authorization_codes ac WHERE ac.auth_request_id = ar.id) ORDER BY ar.expires_at ASC, ar.id ASC LIMIT ?)",
  },
  {
    phase: "device-grants",
    sql: "DELETE FROM device_grants WHERE id IN (SELECT id FROM device_grants WHERE user_id = ? ORDER BY expires_at ASC, id ASC LIMIT ?)",
  },
  {
    phase: "consents",
    sql: "DELETE FROM consents WHERE rowid IN (SELECT rowid FROM consents WHERE user_id = ? ORDER BY created_at ASC, client_id ASC, scope ASC LIMIT ?)",
  },
  {
    phase: "refresh-tokens",
    sql: "DELETE FROM refresh_tokens WHERE id IN (SELECT id FROM refresh_tokens WHERE user_id = ? ORDER BY expires_at ASC, id ASC LIMIT ?)",
  },
  {
    phase: "refresh-families",
    sql: "DELETE FROM refresh_token_families WHERE id IN (SELECT family.id FROM refresh_token_families family WHERE family.user_id = ? AND NOT EXISTS (SELECT 1 FROM refresh_tokens token WHERE token.family_id = family.id) ORDER BY family.created_at ASC, family.id ASC LIMIT ?)",
  },
  {
    phase: "access-revocations",
    sql: "DELETE FROM revoked_access_tokens WHERE jti IN (SELECT jti FROM revoked_access_tokens WHERE user_id = ? ORDER BY revoked_at ASC, jti ASC LIMIT ?)",
  },
  {
    phase: "admin-submissions",
    sql: "DELETE FROM admin_operation_submissions WHERE token_hash IN (SELECT token_hash FROM admin_operation_submissions WHERE user_id = ? ORDER BY expires_at ASC, token_hash ASC LIMIT ?)",
  },
] as const;

const ACCOUNT_CREDENTIAL_PURGE_REMAINS = `
SELECT 1 AS remaining
WHERE EXISTS (SELECT 1 FROM authorization_codes WHERE user_id = ?1)
   OR EXISTS (SELECT 1 FROM authorization_requests WHERE user_id = ?1)
   OR EXISTS (SELECT 1 FROM device_grants WHERE user_id = ?1)
   OR EXISTS (SELECT 1 FROM consents WHERE user_id = ?1)
   OR EXISTS (SELECT 1 FROM refresh_tokens WHERE user_id = ?1)
   OR EXISTS (SELECT 1 FROM refresh_token_families WHERE user_id = ?1)
   OR EXISTS (SELECT 1 FROM revoked_access_tokens WHERE user_id = ?1)
   OR EXISTS (SELECT 1 FROM admin_operation_submissions WHERE user_id = ?1)`;

const UNLINK_FINALIZED_ACCOUNT_AUDITS = `
UPDATE audit_events
SET actor_subject_hash = NULL
WHERE id IN (
  SELECT id FROM audit_events
  WHERE actor_subject_hash = ?4
    AND EXISTS (
      SELECT 1 FROM account_deletion_jobs
      WHERE subject = ?1 AND state = 'running' AND attempt = ?2 AND available_at > ?3
    )
  ORDER BY created_at ASC, id ASC
  LIMIT ${ACCOUNT_DELETION_AUDIT_UNLINK_BATCH}
)`;

const DELETE_FINALIZED_ACCOUNT_USER = `
DELETE FROM users
WHERE id = ?1
  AND EXISTS (
    SELECT 1 FROM account_deletion_jobs
    WHERE subject = ?1 AND state = 'running' AND attempt = ?2 AND available_at > ?3
  )
  AND NOT EXISTS (SELECT 1 FROM authorization_requests WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM authorization_codes WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM device_grants WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM refresh_token_families WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM refresh_tokens WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM consents WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM revoked_access_tokens WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM storage_records WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM bounded_storage_records WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM bounded_storage_transaction_receipts WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM storage_files WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM storage_file_write_fences WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM storage_file_orphan_repairs WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM admin_operation_submissions WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM application_events WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE actor_subject_hash = ?4)`;

const COMPLETE_FINALIZED_ACCOUNT_JOB = `
UPDATE account_deletion_jobs
SET state = 'completed', available_at = NULL, updated_at = ?3, completed_at = ?3
WHERE subject = ?1 AND state = 'running' AND attempt = ?2 AND available_at > ?3
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = ?1)
  AND NOT EXISTS (SELECT 1 FROM authorization_requests WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM authorization_codes WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM device_grants WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM refresh_token_families WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM refresh_tokens WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM consents WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM revoked_access_tokens WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM storage_records WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM bounded_storage_records WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM bounded_storage_transaction_receipts WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM storage_files WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM storage_file_write_fences WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM storage_file_orphan_repairs WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM admin_operation_submissions WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM application_events WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE actor_subject_hash = ?4)`;

const SELECT_CLEAN_COMPLETED_ACCOUNT_JOB = `
SELECT 1 AS clean FROM account_deletion_jobs
WHERE subject = ?1 AND state = 'completed' AND attempt = ?2
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = ?1)
  AND NOT EXISTS (SELECT 1 FROM authorization_requests WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM authorization_codes WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM device_grants WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM refresh_token_families WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM refresh_tokens WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM consents WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM revoked_access_tokens WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM storage_records WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM bounded_storage_records WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM bounded_storage_transaction_receipts WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM storage_files WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM storage_file_write_fences WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM storage_file_orphan_repairs WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM admin_operation_submissions WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM application_events WHERE user_id = ?1)
  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE actor_subject_hash = ?4)`;

const UPSERT_STORAGE_RECORD_WITH_LIMITS = `
INSERT INTO storage_records (user_id, client_id, key, value_json, created_at, updated_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6
WHERE
  (SELECT COUNT(*) FROM storage_records) +
  (SELECT COUNT(*) FROM bounded_storage_records) +
  (SELECT COUNT(*) FROM storage_files) +
  CASE WHEN EXISTS (SELECT 1 FROM storage_records WHERE user_id = ?1 AND client_id = ?2 AND key = ?3) THEN 0 ELSE 1 END <= ?7
  AND (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records) +
  (SELECT COALESCE(SUM(value_bytes), 0) FROM bounded_storage_records) +
  (SELECT COALESCE(SUM(size), 0) FROM storage_files) -
  COALESCE((SELECT length(CAST(value_json AS BLOB)) FROM storage_records WHERE user_id = ?1 AND client_id = ?2 AND key = ?3), 0) +
  length(CAST(?4 AS BLOB)) <= ?8
  AND (SELECT COUNT(*) FROM storage_records WHERE user_id = ?1) +
  (SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1) +
  (SELECT COUNT(*) FROM storage_files WHERE user_id = ?1) +
  CASE WHEN EXISTS (SELECT 1 FROM storage_records WHERE user_id = ?1 AND client_id = ?2 AND key = ?3) THEN 0 ELSE 1 END <= ?9
  AND (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records WHERE user_id = ?1) +
  (SELECT COALESCE(SUM(value_bytes), 0) FROM bounded_storage_records WHERE user_id = ?1) +
  (SELECT COALESCE(SUM(size), 0) FROM storage_files WHERE user_id = ?1) -
  COALESCE((SELECT length(CAST(value_json AS BLOB)) FROM storage_records WHERE user_id = ?1 AND client_id = ?2 AND key = ?3), 0) +
  length(CAST(?4 AS BLOB)) <= ?10
  AND (SELECT COUNT(*) FROM storage_records WHERE user_id = ?1 AND client_id = ?2) +
  (SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1 AND client_id = ?2) +
  (SELECT COUNT(*) FROM storage_files WHERE user_id = ?1 AND client_id = ?2) +
  CASE WHEN EXISTS (SELECT 1 FROM storage_records WHERE user_id = ?1 AND client_id = ?2 AND key = ?3) THEN 0 ELSE 1 END <= ?11
  AND (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records WHERE user_id = ?1 AND client_id = ?2) +
  (SELECT COALESCE(SUM(value_bytes), 0) FROM bounded_storage_records WHERE user_id = ?1 AND client_id = ?2) +
  (SELECT COALESCE(SUM(size), 0) FROM storage_files WHERE user_id = ?1 AND client_id = ?2) -
  COALESCE((SELECT length(CAST(value_json AS BLOB)) FROM storage_records WHERE user_id = ?1 AND client_id = ?2 AND key = ?3), 0) +
  length(CAST(?4 AS BLOB)) <= ?12
ON CONFLICT(user_id, client_id, key) DO UPDATE SET
  value_json = excluded.value_json,
  updated_at = excluded.updated_at`;

const UPSERT_STORAGE_FILE_WITH_LIMITS = `
INSERT INTO storage_files (user_id, client_id, key, r2_key, content_type, size, sha256, created_at, updated_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
WHERE
  NOT EXISTS (SELECT 1 FROM storage_file_orphan_repairs WHERE r2_key = ?4)
  AND
  ((?10 IS NULL AND NOT EXISTS (SELECT 1 FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3))
    OR (?10 IS NOT NULL AND EXISTS (SELECT 1 FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3 AND r2_key = ?10)))
  AND
  (SELECT COUNT(*) FROM storage_records) +
  (SELECT COUNT(*) FROM bounded_storage_records) +
  (SELECT COUNT(*) FROM storage_files) +
  CASE WHEN EXISTS (SELECT 1 FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3) THEN 0 ELSE 1 END <= ?11
  AND (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records) +
  (SELECT COALESCE(SUM(value_bytes), 0) FROM bounded_storage_records) +
  (SELECT COALESCE(SUM(size), 0) FROM storage_files) -
  COALESCE((SELECT size FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3), 0) + ?6 <= ?12
  AND (SELECT COUNT(*) FROM storage_records WHERE user_id = ?1) +
  (SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1) +
  (SELECT COUNT(*) FROM storage_files WHERE user_id = ?1) +
  CASE WHEN EXISTS (SELECT 1 FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3) THEN 0 ELSE 1 END <= ?13
  AND (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records WHERE user_id = ?1) +
  (SELECT COALESCE(SUM(value_bytes), 0) FROM bounded_storage_records WHERE user_id = ?1) +
  (SELECT COALESCE(SUM(size), 0) FROM storage_files WHERE user_id = ?1) -
  COALESCE((SELECT size FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3), 0) + ?6 <= ?14
  AND (SELECT COUNT(*) FROM storage_records WHERE user_id = ?1 AND client_id = ?2) +
  (SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1 AND client_id = ?2) +
  (SELECT COUNT(*) FROM storage_files WHERE user_id = ?1 AND client_id = ?2) +
  CASE WHEN EXISTS (SELECT 1 FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3) THEN 0 ELSE 1 END <= ?15
  AND (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records WHERE user_id = ?1 AND client_id = ?2) +
  (SELECT COALESCE(SUM(value_bytes), 0) FROM bounded_storage_records WHERE user_id = ?1 AND client_id = ?2) +
  (SELECT COALESCE(SUM(size), 0) FROM storage_files WHERE user_id = ?1 AND client_id = ?2) -
  COALESCE((SELECT size FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3), 0) + ?6 <= ?16
ON CONFLICT(user_id, client_id, key) DO UPDATE SET
  r2_key = excluded.r2_key,
  content_type = excluded.content_type,
  size = excluded.size,
  sha256 = excluded.sha256,
  updated_at = excluded.updated_at
WHERE storage_files.r2_key = ?10`;

const UPSERT_STORAGE_FILE_COMPARE_AND_SET = `
INSERT INTO storage_files (user_id, client_id, key, r2_key, content_type, size, sha256, created_at, updated_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
WHERE
  NOT EXISTS (SELECT 1 FROM storage_file_orphan_repairs WHERE r2_key = ?4)
  AND
  ((?10 IS NULL AND NOT EXISTS (SELECT 1 FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3))
    OR (?10 IS NOT NULL AND EXISTS (SELECT 1 FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3 AND r2_key = ?10)))
ON CONFLICT(user_id, client_id, key) DO UPDATE SET
  r2_key = excluded.r2_key,
  content_type = excluded.content_type,
  size = excluded.size,
  sha256 = excluded.sha256,
  updated_at = excluded.updated_at
WHERE storage_files.r2_key = ?10`;

const BOUNDED_TRANSACTION_STATE = `
WITH mutations AS (
  SELECT
    CAST(entry.key AS INTEGER) AS ordinal,
    json_extract(entry.value, '$.type') AS mutation_type,
    json_extract(entry.value, '$.key.collection') AS collection,
    json_extract(entry.value, '$.key.id') AS record_id,
    CASE
      WHEN json_type(entry.value, '$.expected_revision') = 'null' THEN NULL
      ELSE CAST(json_extract(entry.value, '$.expected_revision') AS INTEGER)
    END AS expected_revision,
    CASE
      WHEN json_extract(entry.value, '$.type') = 'put'
      THEN json(json_extract(entry.value, '$.value'))
      ELSE NULL
    END AS value_json
  FROM json_each(?6) AS entry
), current_state AS (
  SELECT
    mutation.*,
    record.value_json AS current_value_json,
    record.value_bytes AS current_value_bytes,
    record.revision AS current_revision,
    record.created_at AS current_created_at
  FROM mutations AS mutation
  LEFT JOIN bounded_storage_records AS record
    ON record.user_id = ?1
   AND record.client_id = ?2
   AND record.collection = mutation.collection
   AND record.record_id = mutation.record_id
), evaluated AS (
  SELECT
    state.*,
    CASE
      WHEN state.mutation_type = 'put'
       AND state.expected_revision IS NULL
       AND state.current_revision IS NOT NULL
      THEN 'conflict'
      WHEN state.mutation_type = 'check'
       AND state.expected_revision IS NULL
       AND state.current_revision IS NOT NULL
      THEN 'precondition_failed'
      WHEN state.expected_revision IS NOT NULL
       AND (state.current_revision IS NULL OR state.current_revision <> state.expected_revision)
      THEN 'precondition_failed'
      WHEN state.mutation_type = 'put'
       AND state.current_revision >= 9007199254740991
      THEN 'unavailable'
      ELSE NULL
    END AS failure,
    CASE
      WHEN state.mutation_type = 'put' AND state.current_revision IS NULL THEN 1
      WHEN state.mutation_type = 'delete' THEN -1
      ELSE 0
    END AS item_delta,
    CASE
      WHEN state.mutation_type = 'put'
      THEN length(CAST(state.value_json AS BLOB)) - COALESCE(state.current_value_bytes, 0)
      WHEN state.mutation_type = 'delete'
      THEN -COALESCE(state.current_value_bytes, 0)
      ELSE 0
    END AS byte_delta,
    CASE
      WHEN state.mutation_type = 'put' THEN json_object(
        'key', json_object('collection', state.collection, 'id', state.record_id),
        'revision', COALESCE(state.current_revision, 0) + 1,
        'value', json(state.value_json)
      )
      WHEN state.mutation_type = 'check' AND state.expected_revision IS NOT NULL THEN json_object(
        'key', json_object('collection', state.collection, 'id', state.record_id),
        'revision', state.current_revision,
        'value', json(state.current_value_json)
      )
      ELSE 'null'
    END AS result_json
  FROM current_state AS state
), summary AS (
  SELECT
    COUNT(*) AS mutation_count,
    COALESCE(SUM(failure = 'conflict'), 0) AS conflict_count,
    COALESCE(SUM(failure = 'precondition_failed'), 0) AS precondition_count,
    COALESCE(SUM(failure = 'unavailable'), 0) AS unavailable_count,
    COALESCE(SUM(mutation_type = 'put'), 0) AS put_count,
    COALESCE(SUM(mutation_type = 'delete'), 0) AS delete_count,
    COALESCE(SUM(item_delta), 0) AS item_delta,
    COALESCE(SUM(byte_delta), 0) AS byte_delta,
    '[' || COALESCE(group_concat(result_json, ','), '') || ']' AS result_json
  FROM (
    SELECT * FROM evaluated ORDER BY ordinal ASC LIMIT 25
  )
), candidate AS (
  SELECT
    summary.*,
    length(CAST(summary.result_json AS BLOB)) AS result_bytes,
    EXISTS (SELECT 1 FROM users WHERE id = ?1) AS subject_active,
    EXISTS (
      SELECT 1 FROM oauth_clients WHERE id = ?2 AND disabled_at IS NULL
    ) AS client_active,
    NOT EXISTS (
      SELECT 1 FROM account_deletion_jobs WHERE subject = ?1
    ) AS deletion_inactive,
    (
      summary.delete_count = summary.mutation_count
      OR
      (
      (SELECT COUNT(*) FROM storage_records) +
      (SELECT COUNT(*) FROM bounded_storage_records) +
      (SELECT COUNT(*) FROM storage_files) + summary.item_delta <= ?11
      AND
      (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records) +
      (SELECT COALESCE(SUM(value_bytes), 0) FROM bounded_storage_records) +
      (SELECT COALESCE(SUM(size), 0) FROM storage_files) + summary.byte_delta <= ?12
      AND
      (SELECT COUNT(*) FROM storage_records WHERE user_id = ?1) +
      (SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1) +
      (SELECT COUNT(*) FROM storage_files WHERE user_id = ?1) + summary.item_delta <= ?13
      AND
      (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records WHERE user_id = ?1) +
      (SELECT COALESCE(SUM(value_bytes), 0) FROM bounded_storage_records WHERE user_id = ?1) +
      (SELECT COALESCE(SUM(size), 0) FROM storage_files WHERE user_id = ?1) + summary.byte_delta <= ?14
      AND
      (SELECT COUNT(*) FROM storage_records WHERE user_id = ?1 AND client_id = ?2) +
      (SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1 AND client_id = ?2) +
      (SELECT COUNT(*) FROM storage_files WHERE user_id = ?1 AND client_id = ?2) + summary.item_delta <= ?15
      AND
      (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records WHERE user_id = ?1 AND client_id = ?2) +
      (SELECT COALESCE(SUM(value_bytes), 0) FROM bounded_storage_records WHERE user_id = ?1 AND client_id = ?2) +
      (SELECT COALESCE(SUM(size), 0) FROM storage_files WHERE user_id = ?1 AND client_id = ?2) + summary.byte_delta <= ?16
      )
    ) AS record_quota_ok,
    (
      (SELECT COUNT(*) FROM bounded_storage_transaction_receipts WHERE admission_class = 'ordinary') + 1 <= ?17
      AND
      (SELECT COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'ordinary') +
        length(CAST(summary.result_json AS BLOB)) <= ?18
      AND
      (SELECT COUNT(*) FROM bounded_storage_transaction_receipts WHERE admission_class = 'ordinary' AND user_id = ?1) + 1 <= ?19
      AND
      (SELECT COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'ordinary' AND user_id = ?1) +
        length(CAST(summary.result_json AS BLOB)) <= ?20
      AND
      (SELECT COUNT(*) FROM bounded_storage_transaction_receipts WHERE admission_class = 'ordinary' AND user_id = ?1 AND client_id = ?2) + 1 <= ?21
      AND
      (SELECT COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'ordinary' AND user_id = ?1 AND client_id = ?2) +
        length(CAST(summary.result_json AS BLOB)) <= ?22
    ) AS ordinary_receipt_quota_ok,
    (
      summary.delete_count = summary.mutation_count
      AND
      (SELECT COUNT(*) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve') + 1 <= ?24
      AND
      (SELECT COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve') +
        length(CAST(summary.result_json AS BLOB)) <= ?25
      AND
      (SELECT COUNT(*) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve' AND user_id = ?1) + 1 <= ?26
      AND
      (SELECT COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve' AND user_id = ?1) +
        length(CAST(summary.result_json AS BLOB)) <= ?27
      AND
      (SELECT COUNT(*) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve' AND user_id = ?1 AND client_id = ?2) + 1 <= ?28
      AND
      (SELECT COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve' AND user_id = ?1 AND client_id = ?2) +
        length(CAST(summary.result_json AS BLOB)) <= ?29
    ) AS delete_receipt_reserve_ok,
    ?23 AS receipt_expires_at
  FROM summary
), capacity AS (
  SELECT
    candidate.*,
    (
      (
        (SELECT COUNT(*) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve') +
          (SELECT COUNT(*) FROM bounded_storage_records) + candidate.item_delta <= ?11
        OR candidate.item_delta <= 0
      )
      AND
      (
        (SELECT COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve') +
          ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD} * ((SELECT COUNT(*) FROM bounded_storage_records) + candidate.item_delta) <=
            ?11 * ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD}
        OR candidate.item_delta <= 0
      )
      AND
      (
        (SELECT COUNT(*) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve' AND user_id = ?1) +
          (SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1) + candidate.item_delta <= ?13
        OR candidate.item_delta <= 0
      )
      AND
      (
        (SELECT COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve' AND user_id = ?1) +
          ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD} * ((SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1) + candidate.item_delta) <=
            ?13 * ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD}
        OR candidate.item_delta <= 0
      )
      AND
      (
        (SELECT COUNT(*) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve' AND user_id = ?1 AND client_id = ?2) +
          (SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1 AND client_id = ?2) + candidate.item_delta <= ?15
        OR candidate.item_delta <= 0
      )
      AND
      (
        (SELECT COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve' AND user_id = ?1 AND client_id = ?2) +
          ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD} * ((SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1 AND client_id = ?2) + candidate.item_delta) <=
            ?15 * ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD}
        OR candidate.item_delta <= 0
      )
    ) AS ordinary_delete_capacity_ok,
    (
      (
        (SELECT COUNT(*) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve') + 1 +
          (SELECT COUNT(*) FROM bounded_storage_records) + candidate.item_delta <= ?11
        OR 1 + candidate.item_delta <= 0
      )
      AND
      (
        (SELECT COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve') +
          candidate.result_bytes +
          ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD} * ((SELECT COUNT(*) FROM bounded_storage_records) + candidate.item_delta) <=
            ?11 * ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD}
        OR candidate.result_bytes +
            ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD} * candidate.item_delta <= 0
      )
      AND
      (
        (SELECT COUNT(*) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve' AND user_id = ?1) + 1 +
          (SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1) + candidate.item_delta <= ?13
        OR 1 + candidate.item_delta <= 0
      )
      AND
      (
        (SELECT COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve' AND user_id = ?1) +
          candidate.result_bytes +
          ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD} * ((SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1) + candidate.item_delta) <=
            ?13 * ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD}
        OR candidate.result_bytes +
            ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD} * candidate.item_delta <= 0
      )
      AND
      (
        (SELECT COUNT(*) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve' AND user_id = ?1 AND client_id = ?2) + 1 +
          (SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1 AND client_id = ?2) + candidate.item_delta <= ?15
        OR 1 + candidate.item_delta <= 0
      )
      AND
      (
        (SELECT COALESCE(SUM(result_bytes), 0) FROM bounded_storage_transaction_receipts WHERE admission_class = 'delete-reserve' AND user_id = ?1 AND client_id = ?2) +
          candidate.result_bytes +
          ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD} * ((SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1 AND client_id = ?2) + candidate.item_delta) <=
            ?15 * ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD}
        OR candidate.result_bytes +
            ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD} * candidate.item_delta <= 0
      )
    ) AS reserve_delete_capacity_ok
  FROM candidate
), admission AS (
  SELECT
    capacity.*,
    CASE
      WHEN capacity.ordinary_receipt_quota_ok = 1
        AND capacity.ordinary_delete_capacity_ok = 1
      THEN 'ordinary'
      WHEN (
        capacity.delete_receipt_reserve_ok = 1
        OR (
          capacity.delete_count = capacity.mutation_count
          AND 1 + capacity.item_delta <= 0
          AND capacity.result_bytes +
            ${BOUNDED_RECORD_DELETE_RECEIPT_BYTES_PER_RECORD} * capacity.item_delta <= 0
        )
      )
        AND capacity.reserve_delete_capacity_ok = 1
      THEN 'delete-reserve'
      ELSE NULL
    END AS receipt_admission_class
  FROM capacity
)`;

const BOUNDED_TRANSACTION_PREFLIGHT = `${BOUNDED_TRANSACTION_STATE}
SELECT
  CASE
    WHEN admission.subject_active = 0
      OR admission.client_active = 0
      OR admission.deletion_inactive = 0
    THEN 'unavailable'
    WHEN EXISTS (
      SELECT 1 FROM bounded_storage_transaction_receipts
      WHERE user_id = ?1 AND client_id = ?2 AND operation_id_hash = ?3
        AND request_hash <> ?4
    ) THEN 'conflict'
    WHEN EXISTS (
      SELECT 1 FROM bounded_storage_transaction_receipts
      WHERE user_id = ?1 AND client_id = ?2 AND operation_id_hash = ?3
        AND request_hash = ?4 AND status = 'committed'
    ) THEN 'replayed'
    WHEN EXISTS (
      SELECT 1 FROM bounded_storage_transaction_receipts
      WHERE user_id = ?1 AND client_id = ?2 AND operation_id_hash = ?3
    ) THEN 'unavailable'
    WHEN ?10 = 0 AND admission.put_count > 0 THEN 'unavailable'
    WHEN admission.conflict_count > 0 THEN 'conflict'
    WHEN admission.precondition_count > 0 THEN 'precondition_failed'
    WHEN admission.unavailable_count > 0 THEN 'unavailable'
    WHEN admission.mutation_count <> ?7
      OR admission.result_bytes > ?9
      OR admission.record_quota_ok = 0
      OR admission.receipt_admission_class IS NULL
    THEN 'quota_exceeded'
    ELSE 'created'
  END AS outcome,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM bounded_storage_transaction_receipts
      WHERE user_id = ?1 AND client_id = ?2 AND operation_id_hash = ?3
        AND request_hash = ?4 AND status = 'committed'
    ) THEN (
      SELECT result_json FROM bounded_storage_transaction_receipts
      WHERE user_id = ?1 AND client_id = ?2 AND operation_id_hash = ?3
    )
    ELSE admission.result_json
  END AS result_json
FROM admission`;

const BOUNDED_TRANSACTION_INSERT_RECEIPT = `${BOUNDED_TRANSACTION_STATE}
INSERT INTO bounded_storage_transaction_receipts (
  user_id, client_id, operation_id_hash, request_hash, attempt_hash,
  mutation_count, result_json, result_bytes, status, created_at, committed_at,
  expires_at, admission_class
)
SELECT
  ?1, ?2, ?3, ?4, ?5, admission.mutation_count,
  admission.result_json, admission.result_bytes, 'pending', ?8, NULL,
  admission.receipt_expires_at, admission.receipt_admission_class
FROM admission
WHERE admission.subject_active = 1
  AND admission.client_active = 1
  AND admission.deletion_inactive = 1
  AND (?10 = 1 OR admission.put_count = 0)
  AND admission.conflict_count = 0
  AND admission.precondition_count = 0
  AND admission.unavailable_count = 0
  AND admission.mutation_count = ?7
  AND admission.result_bytes <= ?9
  AND admission.record_quota_ok = 1
  AND admission.receipt_admission_class IS NOT NULL
ON CONFLICT(user_id, client_id, operation_id_hash) DO NOTHING`;

const BOUNDED_TRANSACTION_PUT = `
INSERT INTO bounded_storage_records (
  user_id, client_id, collection, record_id, value_json, value_bytes,
  revision, created_at, updated_at
)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7
WHERE EXISTS (
  SELECT 1 FROM bounded_storage_transaction_receipts
  WHERE user_id = ?1 AND client_id = ?2 AND operation_id_hash = ?8
    AND request_hash = ?9 AND attempt_hash = ?10 AND status = 'pending'
)
AND (
  (?11 IS NULL AND NOT EXISTS (
    SELECT 1 FROM bounded_storage_records
    WHERE user_id = ?1 AND client_id = ?2 AND collection = ?3 AND record_id = ?4
  ))
  OR
  (?11 IS NOT NULL AND EXISTS (
    SELECT 1 FROM bounded_storage_records
    WHERE user_id = ?1 AND client_id = ?2 AND collection = ?3 AND record_id = ?4
      AND revision = ?11
  ))
)
ON CONFLICT(user_id, client_id, collection, record_id) DO UPDATE SET
  value_json = excluded.value_json,
  value_bytes = excluded.value_bytes,
  revision = bounded_storage_records.revision + 1,
  updated_at = excluded.updated_at
WHERE ?11 IS NOT NULL AND bounded_storage_records.revision = ?11`;

const BOUNDED_TRANSACTION_DELETE = `
DELETE FROM bounded_storage_records
WHERE user_id = ?1 AND client_id = ?2 AND collection = ?3 AND record_id = ?4
  AND revision = ?5
  AND EXISTS (
    SELECT 1 FROM bounded_storage_transaction_receipts
    WHERE user_id = ?1 AND client_id = ?2 AND operation_id_hash = ?6
      AND request_hash = ?7 AND attempt_hash = ?8 AND status = 'pending'
  )`;

const BOUNDED_TRANSACTION_ABORT_PENDING = `
UPDATE bounded_storage_transaction_receipts
SET status = 'committed', committed_at = -1
WHERE user_id = ?1 AND client_id = ?2 AND operation_id_hash = ?3
  AND request_hash = ?4 AND attempt_hash = ?5 AND status = 'pending'`;

const BOUNDED_TRANSACTION_SELECT_RECEIPT = `
SELECT request_hash, attempt_hash, status, result_json
FROM bounded_storage_transaction_receipts
WHERE user_id = ?1 AND client_id = ?2 AND operation_id_hash = ?3`;

export class D1AuthStore implements AuthStore {
  constructor(private readonly db: D1Database) {}

  async cleanup(now: number): Promise<CleanupReport> {
    const stagedFences = await this.db
      .prepare(
        "INSERT INTO storage_file_orphan_repairs (r2_key, user_id, client_id, created_at, updated_at) SELECT r2_key, user_id, client_id, created_at, ? FROM storage_file_write_fences WHERE expires_at <= ? ORDER BY expires_at ASC, r2_key ASC LIMIT ? ON CONFLICT(r2_key) DO UPDATE SET updated_at = MAX(storage_file_orphan_repairs.updated_at, excluded.updated_at) WHERE storage_file_orphan_repairs.user_id = excluded.user_id AND storage_file_orphan_repairs.client_id = excluded.client_id",
      )
      .bind(now, now, STORAGE_FILE_WRITE_FENCE_CLEANUP_BATCH)
      .run();
    assertCleanupMutationSucceeded(stagedFences);
    const deletedFences = await this.db
      .prepare(
        "DELETE FROM storage_file_write_fences WHERE r2_key IN (SELECT fence.r2_key FROM storage_file_write_fences fence WHERE fence.expires_at <= ? AND EXISTS (SELECT 1 FROM storage_file_orphan_repairs repair WHERE repair.r2_key = fence.r2_key AND repair.user_id = fence.user_id AND repair.client_id = fence.client_id) ORDER BY fence.expires_at ASC, fence.r2_key ASC LIMIT ?)",
      )
      .bind(now, STORAGE_FILE_WRITE_FENCE_CLEANUP_BATCH)
      .run();
    const counts: Record<CleanupCategory, number | null> = {
      "file-write-fences": cleanupMutationCount(
        deletedFences,
        "file-write-fences",
      ),
      "application-events": null,
      "bounded-transaction-receipts": null,
      "authorization-codes": null,
      "authorization-requests": null,
      "device-grants": null,
      "refresh-tokens": null,
      "refresh-token-families": null,
      "revoked-access-tokens": null,
      "audit-events": null,
      "rate-limit-counters": null,
      "admin-submissions": null,
    };
    const deletions: Array<[CleanupCategory, string, ...unknown[]]> = [
      [
        "application-events",
        "DELETE FROM application_events WHERE sequence IN (SELECT sequence FROM application_events WHERE expires_at <= ? ORDER BY expires_at ASC, sequence ASC LIMIT ?)",
        now,
        APPLICATION_EVENT_CLEANUP_BATCH_SIZE,
      ],
      [
        "bounded-transaction-receipts",
        "DELETE FROM bounded_storage_transaction_receipts WHERE (user_id, client_id, operation_id_hash) IN (SELECT user_id, client_id, operation_id_hash FROM bounded_storage_transaction_receipts WHERE expires_at <= ? ORDER BY expires_at ASC, created_at ASC, user_id ASC, client_id ASC, operation_id_hash ASC LIMIT ?)",
        now,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "authorization-codes",
        "DELETE FROM authorization_codes WHERE rowid IN (SELECT rowid FROM authorization_codes WHERE expires_at <= ? ORDER BY expires_at ASC, rowid ASC LIMIT ?)",
        now,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "authorization-requests",
        "DELETE FROM authorization_requests WHERE rowid IN (SELECT ar.rowid FROM authorization_requests ar WHERE ar.expires_at <= ? AND NOT EXISTS (SELECT 1 FROM authorization_codes ac WHERE ac.auth_request_id = ar.id AND ac.expires_at > ?) ORDER BY ar.expires_at ASC, ar.rowid ASC LIMIT ?)",
        now,
        now,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "device-grants",
        "DELETE FROM device_grants WHERE rowid IN (SELECT rowid FROM device_grants WHERE expires_at <= ? ORDER BY expires_at ASC, rowid ASC LIMIT ?)",
        now,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "refresh-tokens",
        "DELETE FROM refresh_tokens WHERE rowid IN (SELECT rowid FROM refresh_tokens WHERE expires_at <= ? ORDER BY expires_at ASC, rowid ASC LIMIT ?)",
        now,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "refresh-token-families",
        "DELETE FROM refresh_token_families WHERE rowid IN (SELECT rtf.rowid FROM refresh_token_families rtf WHERE rtf.created_at <= ? AND NOT EXISTS (SELECT 1 FROM refresh_tokens rt WHERE rt.family_id = rtf.id) ORDER BY rtf.created_at ASC, rtf.rowid ASC LIMIT ?)",
        now - REFRESH_FAMILY_ORPHAN_GRACE_SECONDS,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "revoked-access-tokens",
        "DELETE FROM revoked_access_tokens WHERE rowid IN (SELECT rowid FROM revoked_access_tokens WHERE expires_at <= ? ORDER BY expires_at ASC, rowid ASC LIMIT ?)",
        now,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "audit-events",
        "DELETE FROM audit_events WHERE rowid IN (SELECT rowid FROM audit_events WHERE created_at <= ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
        now - AUDIT_RETENTION_SECONDS,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "rate-limit-counters",
        "DELETE FROM rate_limit_counters WHERE rowid IN (SELECT rowid FROM rate_limit_counters WHERE window_start <= ? ORDER BY window_start ASC, rowid ASC LIMIT ?)",
        now - RATE_COUNTER_RETENTION_SECONDS,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "admin-submissions",
        "DELETE FROM admin_operation_submissions WHERE rowid IN (SELECT rowid FROM admin_operation_submissions WHERE expires_at <= ? ORDER BY expires_at ASC, rowid ASC LIMIT ?)",
        now,
        CLEANUP_BATCH_SIZE,
      ],
    ];
    for (const [category, sql, ...values] of deletions) {
      const result = await this.db
        .prepare(sql)
        .bind(...values)
        .run();
      counts[category] = cleanupMutationCount(result, category);
    }
    return createCleanupReport(counts);
  }

  async rateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    now: number,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        "INSERT INTO rate_limit_counters (key, count, window_start) SELECT ?, 1, ? WHERE EXISTS (SELECT 1 FROM rate_limit_counters WHERE key = ?) OR (SELECT COUNT(*) FROM rate_limit_counters) < ? ON CONFLICT(key) DO UPDATE SET count = CASE WHEN rate_limit_counters.window_start + ? <= ? THEN 1 ELSE rate_limit_counters.count + 1 END, window_start = CASE WHEN rate_limit_counters.window_start + ? <= ? THEN excluded.window_start ELSE rate_limit_counters.window_start END RETURNING count",
      )
      .bind(
        key,
        now,
        key,
        MAX_RATE_COUNTERS,
        windowSeconds,
        now,
        windowSeconds,
        now,
      )
      .first<Row>();
    return Boolean(row && Number(row.count) <= limit);
  }

  async audit(
    type: string,
    data: Record<string, unknown>,
    now: number,
    attribution?: AuditEventAttribution,
  ): Promise<void> {
    assertAuditEventAttribution(attribution);
    await this.db
      .prepare(
        "INSERT INTO audit_events (type, data_json, actor_subject_hash, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(
        type,
        JSON.stringify(redactAuditData(data)),
        attribution?.actorSubjectHash ?? null,
        now,
      )
      .run();
  }

  async findOrCreateUser(
    identity: UpstreamIdentity,
    now: number,
  ): Promise<LocalUser> {
    const result = await this.db
      .prepare(RESOLVE_LOCAL_USER)
      .bind(uuid(), identity.email, identity.displayName, now)
      .all<Row>();
    if (
      !result ||
      result.success !== true ||
      !Array.isArray(result.results) ||
      result.results.length !== 1
    ) {
      throw new Error("user_resolution_failed");
    }
    return rowToResolvedUser(result.results[0], identity, now);
  }

  async getUser(id: string): Promise<LocalUser | null> {
    const row = await this.db
      .prepare("SELECT * FROM users WHERE id = ? AND principal_type = 'user'")
      .bind(id)
      .first<Row>();
    return row ? rowToUser(row) : null;
  }

  async getUserByEmail(email: string): Promise<LocalUser | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM users WHERE email = ? AND principal_type = 'user'",
      )
      .bind(email)
      .first<Row>();
    return row ? rowToUser(row) : null;
  }

  async countUsers(): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS identity_count FROM users WHERE principal_type = 'user'",
      )
      .first<Row>();
    return Number(row?.identity_count ?? 0);
  }

  async startAccountDeletionJob(
    subject: string,
    now: number,
  ): Promise<AccountDeletionJobStartResult> {
    assertAccountDeletionNow(now);
    const inserted = await this.db
      .prepare(
        "INSERT INTO account_deletion_jobs (subject, state, attempt, available_at, created_at, updated_at, completed_at) SELECT ?, 'pending', 0, ?, ?, ?, NULL FROM users WHERE id = ? AND principal_type = 'user' ON CONFLICT(subject) DO NOTHING RETURNING subject, state, attempt, available_at, created_at, updated_at, completed_at",
      )
      .bind(subject, now, now, now, subject)
      .first<Row>();
    if (inserted) {
      return { created: true, job: rowToAccountDeletionJob(inserted) };
    }

    const existing = await this.getAccountDeletionJob(subject);
    if (existing) return { created: false, job: existing };
    throw new Error("account_deletion_subject_not_found");
  }

  async getAccountDeletionJob(
    subject: string,
  ): Promise<AccountDeletionJob | null> {
    const row = await this.db
      .prepare(
        "SELECT subject, state, attempt, available_at, created_at, updated_at, completed_at FROM account_deletion_jobs WHERE subject = ?",
      )
      .bind(subject)
      .first<Row>();
    return row ? rowToAccountDeletionJob(row) : null;
  }

  async claimAccountDeletionJobs(
    now: number,
    leaseSeconds: number,
    limit: number,
  ): Promise<AccountDeletionJob[]> {
    const leaseExpiresAt = accountDeletionClaimExpiry(now, leaseSeconds, limit);
    const rows = await this.db
      .prepare(
        "UPDATE account_deletion_jobs SET state = 'running', attempt = attempt + 1, available_at = ?, updated_at = ? WHERE subject IN (SELECT subject FROM account_deletion_jobs WHERE state IN ('pending', 'running', 'retryable') AND available_at <= ? ORDER BY available_at ASC, created_at ASC, subject ASC LIMIT ?) AND state IN ('pending', 'running', 'retryable') AND available_at <= ? RETURNING subject, state, attempt, available_at, created_at, updated_at, completed_at",
      )
      .bind(leaseExpiresAt, now, now, limit, now)
      .all<Row>();
    return (rows.results ?? [])
      .map(rowToAccountDeletionJob)
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.subject.localeCompare(right.subject),
      );
  }

  async retryAccountDeletionJob(
    subject: string,
    attempt: number,
    now: number,
    retryAt: number,
  ): Promise<boolean> {
    assertAccountDeletionRetryAt(now, retryAt);
    if (!Number.isSafeInteger(attempt) || attempt < 1) return false;
    const result = await this.db
      .prepare(
        "UPDATE account_deletion_jobs SET state = 'retryable', available_at = ?, updated_at = ? WHERE subject = ? AND state = 'running' AND attempt = ? AND available_at > ?",
      )
      .bind(retryAt, now, subject, attempt, now)
      .run();
    return mutationChanges(result) === 1;
  }

  async finalizeAccountDeletion(
    subject: string,
    attempt: number,
    now: number,
  ): Promise<boolean> {
    assertAccountDeletionNow(now);
    if (
      subject.length === 0 ||
      subject.length > 128 ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1
    ) {
      return false;
    }
    if (!this.db.batch) {
      throw new Error("account_deletion_finalization_batch_unavailable");
    }

    const actorSubjectHash = await sha256(subject);

    const results = await this.db.batch([
      this.db
        .prepare(UNLINK_FINALIZED_ACCOUNT_AUDITS)
        .bind(subject, attempt, now, actorSubjectHash),
      this.db
        .prepare(DELETE_FINALIZED_ACCOUNT_USER)
        .bind(subject, attempt, now, actorSubjectHash),
      this.db
        .prepare(COMPLETE_FINALIZED_ACCOUNT_JOB)
        .bind(subject, attempt, now, actorSubjectHash),
    ]);
    if (results.length !== 3 || results.some((result) => !result.success)) {
      throw new Error("account_deletion_finalization_failed");
    }
    const unlinkedAudits = requiredMutationChanges(
      results[0]!,
      "account_deletion_finalization_failed",
    );
    const deletedUsers = requiredMutationChanges(
      results[1]!,
      "account_deletion_finalization_failed",
    );
    const completedJobs = requiredMutationChanges(
      results[2]!,
      "account_deletion_finalization_failed",
    );
    if (
      unlinkedAudits < 0 ||
      unlinkedAudits > ACCOUNT_DELETION_AUDIT_UNLINK_BATCH
    ) {
      throw new Error("account_deletion_finalization_failed");
    }
    if (completedJobs === 1 && (deletedUsers === 0 || deletedUsers === 1)) {
      return true;
    }
    if (deletedUsers !== 0 || completedJobs !== 0) {
      throw new Error("account_deletion_finalization_failed");
    }
    if (unlinkedAudits > 0) return false;
    const completed = await this.db
      .prepare(SELECT_CLEAN_COMPLETED_ACCOUNT_JOB)
      .bind(subject, attempt, now, actorSubjectHash)
      .first<Row>();
    return Boolean(completed);
  }

  async purgeAccountCredentialsAndGrants(
    subject: string,
    limit: number,
  ): Promise<AccountCredentialPurgeBatchResult> {
    assertAccountCredentialPurgeLimit(limit);
    let job: AccountDeletionJob | null;
    try {
      job = await this.getAccountDeletionJob(subject);
    } catch {
      throw new AccountCredentialPurgeFailure("job");
    }
    if (!job) {
      throw accountCredentialPurgeUnavailable();
    }

    let deletedCount = 0;
    for (const { phase, sql } of ACCOUNT_CREDENTIAL_PURGE_DELETIONS) {
      const remaining = limit - deletedCount;
      if (remaining === 0) break;
      try {
        const result = await this.db
          .prepare(sql)
          .bind(subject, remaining)
          .run();
        const changes = mutationChanges(result);
        if (changes < 0 || changes > remaining) {
          throw new Error("account_credential_purge_failed");
        }
        deletedCount += changes;
      } catch {
        throw new AccountCredentialPurgeFailure(phase);
      }
    }

    let remaining: Row | null;
    try {
      remaining = await this.db
        .prepare(ACCOUNT_CREDENTIAL_PURGE_REMAINS)
        .bind(subject)
        .first<Row>();
    } catch {
      throw new AccountCredentialPurgeFailure("remaining-check");
    }
    return { deletedCount, done: !remaining };
  }

  async purgeAccountRecords(
    subject: string,
    limit: number,
  ): Promise<AccountRecordPurgeBatch> {
    assertAccountRecordPurgeInput(subject, limit);
    if (!(await this.getAccountDeletionJob(subject))) {
      throw accountRecordPurgeUnavailable();
    }
    if (!this.db.batch) throw new Error("account_record_purge_failed");

    const receiptCountRow = await this.db
      .prepare(
        "SELECT MIN(COUNT(*), ?) AS selected FROM bounded_storage_transaction_receipts WHERE user_id = ?",
      )
      .bind(limit, subject)
      .first<Row>();
    const receiptLimit = Number(receiptCountRow?.selected ?? 0);
    if (
      !Number.isSafeInteger(receiptLimit) ||
      receiptLimit < 0 ||
      receiptLimit > limit
    ) {
      throw new Error("account_record_purge_failed");
    }
    const boundedCountRow = await this.db
      .prepare(
        "SELECT MIN(COUNT(*), ?) AS selected FROM bounded_storage_records WHERE user_id = ?",
      )
      .bind(limit - receiptLimit, subject)
      .first<Row>();
    const boundedLimit = Number(boundedCountRow?.selected ?? 0);
    if (
      !Number.isSafeInteger(boundedLimit) ||
      boundedLimit < 0 ||
      boundedLimit > limit - receiptLimit
    ) {
      throw new Error("account_record_purge_failed");
    }
    const legacyLimit = limit - receiptLimit - boundedLimit;
    const statements: D1PreparedStatement[] = [];
    if (receiptLimit > 0) {
      statements.push(
        this.db
          .prepare(
            "DELETE FROM bounded_storage_transaction_receipts WHERE (user_id, client_id, operation_id_hash) IN (SELECT user_id, client_id, operation_id_hash FROM bounded_storage_transaction_receipts WHERE user_id = ? ORDER BY client_id ASC, created_at ASC, operation_id_hash ASC LIMIT ?)",
          )
          .bind(subject, receiptLimit),
      );
    }
    if (boundedLimit > 0) {
      statements.push(
        this.db
          .prepare(
            "DELETE FROM bounded_storage_records WHERE (user_id, client_id, collection, record_id) IN (SELECT user_id, client_id, collection, record_id FROM bounded_storage_records WHERE user_id = ? ORDER BY client_id ASC, collection ASC, record_id ASC LIMIT ?)",
          )
          .bind(subject, boundedLimit),
      );
    }
    if (legacyLimit > 0) {
      statements.push(
        this.db
          .prepare(
            "DELETE FROM storage_records WHERE rowid IN (SELECT rowid FROM storage_records WHERE user_id = ? ORDER BY client_id ASC, key ASC LIMIT ?)",
          )
          .bind(subject, legacyLimit),
      );
    }
    const results = await this.db.batch(statements);
    if (
      results.length !== statements.length ||
      results.some((result) => !result.success)
    ) {
      throw new Error("account_record_purge_failed");
    }
    const deletedCount = results.reduce(
      (total, result) =>
        total + requiredMutationChanges(result, "account_record_purge_failed"),
      0,
    );
    if (deletedCount < limit) {
      const remaining = await this.db
        .prepare(
          "SELECT 1 AS remaining WHERE EXISTS (SELECT 1 FROM bounded_storage_transaction_receipts WHERE user_id = ?1) OR EXISTS (SELECT 1 FROM bounded_storage_records WHERE user_id = ?1) OR EXISTS (SELECT 1 FROM storage_records WHERE user_id = ?1)",
        )
        .bind(subject)
        .first<Row>();
      if (remaining) return { deletedCount, done: false };
    }
    return accountRecordPurgeBatch(deletedCount, limit);
  }

  async purgeAccountEvents(
    subject: string,
    attempt: number,
    now: number,
    limit: number,
  ): Promise<AccountEventPurgeBatch> {
    assertAccountEventPurgeInput(subject, attempt, now, limit);
    let deletedCount: number;
    try {
      const result = await this.db
        .prepare(
          "DELETE FROM application_events WHERE sequence IN (SELECT event.sequence FROM application_events event WHERE event.user_id = ?1 AND EXISTS (SELECT 1 FROM account_deletion_jobs job JOIN users owner ON owner.id = job.subject AND owner.principal_type = 'user' WHERE job.subject = ?1 AND job.state = 'running' AND job.attempt = ?2 AND job.available_at > ?3) ORDER BY event.client_id ASC, event.sequence ASC LIMIT ?4)",
        )
        .bind(subject, attempt, now, limit)
        .run();
      deletedCount = requiredMutationChanges(
        result,
        "account_event_purge_failed",
      );
    } catch {
      throw new Error("account_event_purge_failed");
    }

    if (deletedCount === 0) {
      let active: Row | null;
      try {
        active = await this.db
          .prepare(
            "SELECT 1 AS active FROM account_deletion_jobs job JOIN users owner ON owner.id = job.subject AND owner.principal_type = 'user' WHERE job.subject = ?1 AND job.state = 'running' AND job.attempt = ?2 AND job.available_at > ?3 LIMIT 1",
          )
          .bind(subject, attempt, now)
          .first<Row>();
      } catch {
        throw new Error("account_event_purge_failed");
      }
      if (!active) throw accountEventPurgeUnavailable();
    }
    return accountEventPurgeBatch(deletedCount, limit);
  }

  async stageAccountFilePurgeBatch(
    subject: string,
    attempt: number,
    now: number,
    limit: number,
  ): Promise<AccountFilePurgeStageResult> {
    assertAccountFilePurgeInput(subject, attempt, now, limit);
    const files = await this.db
      .prepare(
        "SELECT sf.* FROM storage_files sf WHERE sf.user_id = ? AND EXISTS (SELECT 1 FROM account_deletion_jobs adj WHERE adj.subject = ? AND adj.state = 'running' AND adj.attempt = ? AND adj.available_at > ?) ORDER BY sf.client_id ASC, sf.key ASC, sf.r2_key ASC LIMIT ?",
      )
      .bind(subject, subject, attempt, now, limit)
      .all<Row>();
    const selected = (files.results ?? []).map(rowToStorageFile);
    if (selected.length === 0) return { selected: 0, staged: 0 };

    if (!this.db.batch) throw new Error("account_file_purge_batch_unavailable");
    const statements: D1PreparedStatement[] = [];
    for (const file of selected) {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO storage_file_orphan_repairs (r2_key, user_id, client_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(r2_key) DO UPDATE SET updated_at = MAX(storage_file_orphan_repairs.updated_at, excluded.updated_at) WHERE storage_file_orphan_repairs.user_id = excluded.user_id AND storage_file_orphan_repairs.client_id = excluded.client_id",
          )
          .bind(file.r2Key, file.userId, file.clientId, now, now),
        this.db
          .prepare(
            "DELETE FROM storage_files WHERE user_id = ? AND client_id = ? AND key = ? AND r2_key = ? AND EXISTS (SELECT 1 FROM storage_file_orphan_repairs repair WHERE repair.r2_key = ? AND repair.user_id = ? AND repair.client_id = ?) AND EXISTS (SELECT 1 FROM account_deletion_jobs adj WHERE adj.subject = ? AND adj.state = 'running' AND adj.attempt = ? AND adj.available_at > ?)",
          )
          .bind(
            file.userId,
            file.clientId,
            file.key,
            file.r2Key,
            file.r2Key,
            file.userId,
            file.clientId,
            subject,
            attempt,
            now,
          ),
      );
    }
    const results = await this.db.batch(statements);
    if (
      results.length !== statements.length ||
      results.some((result) => !result.success)
    ) {
      throw new Error("account_file_purge_batch_failed");
    }
    let staged = 0;
    for (let index = 1; index < results.length; index += 2) {
      staged += mutationChanges(results[index]!);
    }
    return { selected: selected.length, staged };
  }

  async stageExpiredAccountFileWriteFences(
    subject: string,
    attempt: number,
    now: number,
    limit: number,
  ): Promise<number> {
    assertStorageFileWriteFenceBatchLimit(limit);
    assertAccountDeletionNow(now);
    if (!Number.isSafeInteger(attempt) || attempt < 1) return 0;
    if (!this.db.batch) {
      throw new Error("storage_file_write_fence_batch_unavailable");
    }
    const results = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO storage_file_orphan_repairs (r2_key, user_id, client_id, created_at, updated_at) SELECT fence.r2_key, fence.user_id, fence.client_id, fence.created_at, ?3 FROM storage_file_write_fences fence WHERE fence.user_id = ?1 AND fence.expires_at <= ?3 AND EXISTS (SELECT 1 FROM account_deletion_jobs job WHERE job.subject = ?1 AND job.state = 'running' AND job.attempt = ?2 AND job.available_at > ?3) ORDER BY fence.expires_at ASC, fence.r2_key ASC LIMIT ?4 ON CONFLICT(r2_key) DO UPDATE SET updated_at = MAX(storage_file_orphan_repairs.updated_at, excluded.updated_at) WHERE storage_file_orphan_repairs.user_id = excluded.user_id AND storage_file_orphan_repairs.client_id = excluded.client_id",
        )
        .bind(subject, attempt, now, limit),
      this.db
        .prepare(
          "DELETE FROM storage_file_write_fences WHERE r2_key IN (SELECT fence.r2_key FROM storage_file_write_fences fence WHERE fence.user_id = ?1 AND fence.expires_at <= ?3 AND EXISTS (SELECT 1 FROM account_deletion_jobs job WHERE job.subject = ?1 AND job.state = 'running' AND job.attempt = ?2 AND job.available_at > ?3) AND EXISTS (SELECT 1 FROM storage_file_orphan_repairs repair WHERE repair.r2_key = fence.r2_key AND repair.user_id = fence.user_id AND repair.client_id = fence.client_id) ORDER BY fence.expires_at ASC, fence.r2_key ASC LIMIT ?4)",
        )
        .bind(subject, attempt, now, limit),
    ]);
    if (results.length !== 2 || results.some((result) => !result.success)) {
      throw new Error("storage_file_write_fence_conversion_failed");
    }
    return requiredMutationChanges(
      results[1]!,
      "storage_file_write_fence_conversion_failed",
    );
  }

  async hasStorageFilesForSubject(subject: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 AS present FROM storage_files WHERE user_id = ? LIMIT 1",
      )
      .bind(subject)
      .first<Row>();
    return Boolean(row);
  }

  async createClient(
    input: ClientRegistrationInput,
    secretHash: string | null,
    now: number,
  ): Promise<ClientView> {
    const client: ClientView = {
      id: uuid(),
      type: input.type,
      name: input.name,
      disabledAt: null,
      redirectUris: [...input.redirectUris],
      scopes: [...input.scopes],
      origins: [...input.origins],
      createdAt: now,
    };
    if (client.type !== "service") {
      await this.db
        .prepare(
          "INSERT INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(client.id, client.type, client.name, secretHash, null, now)
        .run();
      for (const uri of client.redirectUris) {
        await this.db
          .prepare(
            "INSERT INTO client_redirect_uris (client_id, redirect_uri) VALUES (?, ?)",
          )
          .bind(client.id, uri)
          .run();
      }
      for (const scope of client.scopes) {
        await this.db
          .prepare("INSERT INTO client_scopes (client_id, scope) VALUES (?, ?)")
          .bind(client.id, scope)
          .run();
      }
      for (const origin of client.origins) {
        await this.db
          .prepare(
            "INSERT INTO client_origins (client_id, origin) VALUES (?, ?)",
          )
          .bind(client.id, origin)
          .run();
      }
      return client;
    }

    if (!this.db.batch) throw new Error("client_creation_batch_unavailable");
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          "INSERT INTO users (id, email, display_name, created_at, updated_at, principal_type) VALUES (?, ?, ?, ?, ?, 'service')",
        )
        .bind(client.id, `service:${client.id}`, client.name, now, now),
    ];
    statements.push(
      this.db
        .prepare(
          "INSERT INTO oauth_clients (id, type, name, secret_hash, disabled_at, created_at, client_kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          client.id,
          "confidential",
          client.name,
          secretHash,
          null,
          now,
          "service",
        ),
    );
    for (const scope of client.scopes) {
      statements.push(
        this.db
          .prepare("INSERT INTO client_scopes (client_id, scope) VALUES (?, ?)")
          .bind(client.id, scope),
      );
    }
    const results = await this.db.batch(statements);
    if (
      results.length !== statements.length ||
      results.some((row) => !row.success)
    ) {
      throw new Error("client_creation_failed");
    }
    return client;
  }

  async listClients(): Promise<ClientView[]> {
    const rows = await this.db
      .prepare(
        "SELECT * FROM oauth_clients WHERE id <> ? ORDER BY created_at DESC",
      )
      .bind(BROWSER_SESSION_CLIENT_ID)
      .all<Row>();
    return Promise.all(
      (rows.results ?? []).map((row) => this.hydrateClient(row)),
    );
  }

  async getClient(id: string): Promise<ClientView | null> {
    const row = await this.db
      .prepare("SELECT * FROM oauth_clients WHERE id = ?")
      .bind(id)
      .first<Row>();
    return row ? this.hydrateClient(row) : null;
  }

  async getClientSecretHash(id: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT secret_hash FROM oauth_clients WHERE id = ?")
      .bind(id)
      .first<Row>();
    return typeof row?.secret_hash === "string" ? row.secret_hash : null;
  }

  async hasServicePrincipal(id: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 AS present FROM users WHERE id = ? AND principal_type = 'service' LIMIT 1",
      )
      .bind(id)
      .first<Row>();
    return Boolean(row);
  }

  async hasActiveClientOrigin(origin: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 AS allowed FROM client_origins co JOIN oauth_clients oc ON oc.id = co.client_id WHERE co.origin = ? AND oc.disabled_at IS NULL LIMIT 1",
      )
      .bind(origin)
      .first<Row>();
    return Boolean(row);
  }

  async setClientDisabled(
    id: string,
    disabledAt: number | null,
  ): Promise<void> {
    if (isBrowserSessionClientId(id)) return;
    await this.db
      .prepare("UPDATE oauth_clients SET disabled_at = ? WHERE id = ?")
      .bind(disabledAt, id)
      .run();
  }

  async rotateClientSecret(id: string, secretHash: string): Promise<void> {
    if (isBrowserSessionClientId(id)) return;
    await this.db
      .prepare("UPDATE oauth_clients SET secret_hash = ? WHERE id = ?")
      .bind(secretHash, id)
      .run();
  }

  async revokeClientGrants(clientId: string, now: number): Promise<void> {
    if (isBrowserSessionClientId(clientId)) return;
    await this.db
      .prepare(
        "UPDATE refresh_token_families SET status = 'revoked' WHERE client_id = ?",
      )
      .bind(clientId)
      .run();
    await this.db
      .prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE client_id = ?")
      .bind(now, clientId)
      .run();
  }

  async claimAdminOperationSubmission(
    tokenHash: string,
    userId: string,
    now: number,
    expiresAt: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "INSERT INTO admin_operation_submissions (token_hash, user_id, created_at, expires_at, result_consumed_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(token_hash) DO NOTHING",
      )
      .bind(tokenHash, userId, now, expiresAt)
      .run();
    return mutationChanges(result) === 1;
  }

  async consumeAdminOperationResult(
    tokenHash: string,
    userId: string,
    now: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE admin_operation_submissions SET result_consumed_at = ? WHERE token_hash = ? AND user_id = ? AND result_consumed_at IS NULL AND expires_at > ?",
      )
      .bind(now, tokenHash, userId, now)
      .run();
    return mutationChanges(result) === 1;
  }

  async createDeviceGrant(grant: DeviceGrant): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO device_grants (id, device_code_hash, user_code_hash, user_code_display, client_id, scope, status, user_id, created_at, expires_at, interval_seconds, last_poll_at, slow_down_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        grant.id,
        grant.deviceCodeHash,
        grant.userCodeHash,
        grant.userCodeDisplay,
        grant.clientId,
        grant.scope,
        grant.status,
        grant.userId,
        grant.createdAt,
        grant.expiresAt,
        grant.intervalSeconds,
        grant.lastPollAt,
        grant.slowDownCount,
      )
      .run();
  }

  async getDeviceGrantByDeviceHash(hash: string): Promise<DeviceGrant | null> {
    const row = await this.db
      .prepare("SELECT * FROM device_grants WHERE device_code_hash = ?")
      .bind(hash)
      .first<Row>();
    return row ? rowToDevice(row) : null;
  }

  async getDeviceGrantByUserCodeHash(
    hash: string,
  ): Promise<DeviceGrant | null> {
    const row = await this.db
      .prepare("SELECT * FROM device_grants WHERE user_code_hash = ?")
      .bind(hash)
      .first<Row>();
    return row ? rowToDevice(row) : null;
  }

  async updateDeviceGrant(grant: DeviceGrant): Promise<void> {
    await this.db
      .prepare(
        "UPDATE device_grants SET last_poll_at = ?, slow_down_count = ? WHERE id = ?",
      )
      .bind(grant.lastPollAt, grant.slowDownCount, grant.id)
      .run();
  }

  async transitionDeviceGrant(
    userCodeHash: string,
    status: "approved" | "denied",
    userId: string | null,
    now: number,
  ): Promise<DeviceGrant | null> {
    const result = await this.db
      .prepare(
        "UPDATE device_grants SET status = ?, user_id = ? WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?",
      )
      .bind(status, userId, userCodeHash, now)
      .run();
    if (mutationChanges(result) !== 1) return null;
    return this.getDeviceGrantByUserCodeHash(userCodeHash);
  }

  async consumeDeviceGrant(
    deviceCodeHash: string,
    clientId: string,
    now: number,
  ): Promise<DeviceGrant | null> {
    const result = await this.db
      .prepare(
        "UPDATE device_grants SET status = 'used' WHERE device_code_hash = ? AND client_id = ? AND status = 'approved' AND user_id IS NOT NULL AND expires_at > ?",
      )
      .bind(deviceCodeHash, clientId, now)
      .run();
    if (mutationChanges(result) !== 1) return null;
    return this.getDeviceGrantByDeviceHash(deviceCodeHash);
  }

  async createAuthorizationRequest(
    request: AuthorizationRequest,
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO authorization_requests (id, client_id, redirect_uri, scope, state, nonce, code_challenge, created_at, expires_at, user_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        request.id,
        request.clientId,
        request.redirectUri,
        request.scope,
        request.state,
        request.nonce,
        request.codeChallenge,
        request.createdAt,
        request.expiresAt,
        request.userId,
        request.status,
      )
      .run();
  }

  async getAuthorizationRequest(
    id: string,
  ): Promise<AuthorizationRequest | null> {
    const row = await this.db
      .prepare("SELECT * FROM authorization_requests WHERE id = ?")
      .bind(id)
      .first<Row>();
    return row ? rowToAuthRequest(row) : null;
  }

  async transitionAuthorizationRequest(
    id: string,
    status: "approved" | "denied",
    userId: string | null,
    now: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE authorization_requests SET status = ?, user_id = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
      )
      .bind(status, userId, id, now)
      .run();
    return mutationChanges(result) === 1;
  }

  async createAuthorizationCode(code: AuthorizationCode): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO authorization_codes (code_hash, auth_request_id, client_id, redirect_uri, user_id, scope, nonce, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        code.codeHash,
        code.authRequestId,
        code.clientId,
        code.redirectUri,
        code.userId,
        code.scope,
        code.nonce,
        code.expiresAt,
        code.consumedAt,
      )
      .run();
  }

  async consumeAuthorizationCode(
    hash: string,
    clientId: string,
    redirectUri: string,
    now: number,
  ): Promise<AuthorizationCode | null> {
    const result = await this.db
      .prepare(
        "UPDATE authorization_codes SET consumed_at = ? WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND consumed_at IS NULL AND expires_at > ?",
      )
      .bind(now, hash, clientId, redirectUri, now)
      .run();
    if (mutationChanges(result) !== 1) return null;
    const row = await this.db
      .prepare("SELECT * FROM authorization_codes WHERE code_hash = ?")
      .bind(hash)
      .first<Row>();
    return row ? rowToAuthCode(row) : null;
  }

  async hasConsent(
    userId: string,
    clientId: string,
    scope: string,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 AS ok FROM consents WHERE user_id = ? AND client_id = ? AND scope = ?",
      )
      .bind(userId, clientId, scope)
      .first<Row>();
    return Boolean(row);
  }

  async saveConsent(
    userId: string,
    clientId: string,
    scope: string,
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO consents (user_id, client_id, scope, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, client_id, scope) DO NOTHING",
      )
      .bind(userId, clientId, scope, now)
      .run();
  }

  async createRefreshFamily(family: RefreshTokenFamily): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO refresh_token_families (id, user_id, client_id, status, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        family.id,
        family.userId,
        family.clientId,
        family.status,
        family.createdAt,
      )
      .run();
  }

  async createRefreshToken(token: RefreshTokenRecord): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO refresh_tokens (id, family_id, token_hash, user_id, client_id, scope, expires_at, used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        token.id,
        token.familyId,
        token.tokenHash,
        token.userId,
        token.clientId,
        token.scope,
        token.expiresAt,
        token.usedAt,
        token.revokedAt,
      )
      .run();
  }

  async consumeRefreshToken(
    hash: string,
    clientId: string,
    now: number,
  ): Promise<RefreshTokenRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT rt.*, rtf.status AS family_status FROM refresh_tokens rt JOIN refresh_token_families rtf ON rtf.id = rt.family_id WHERE rt.token_hash = ? AND rt.client_id = ?",
      )
      .bind(hash, clientId)
      .first<Row>();
    if (
      !row ||
      Number(row.expires_at) <= now ||
      row.revoked_at ||
      row.family_status !== "active"
    )
      return null;
    if (row.used_at) {
      await this.revokeRefreshFamily(String(row.family_id), now);
      return null;
    }
    const result = await this.db
      .prepare(
        "UPDATE refresh_tokens SET used_at = ? WHERE token_hash = ? AND client_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM refresh_token_families WHERE id = refresh_tokens.family_id AND status = 'active')",
      )
      .bind(now, hash, clientId, now)
      .run();
    if (mutationChanges(result) !== 1) {
      const raced = await this.db
        .prepare(
          "SELECT rt.*, rtf.status AS family_status FROM refresh_tokens rt JOIN refresh_token_families rtf ON rtf.id = rt.family_id WHERE rt.token_hash = ? AND rt.client_id = ?",
        )
        .bind(hash, clientId)
        .first<Row>();
      if (raced?.used_at) {
        await this.revokeRefreshFamily(String(raced.family_id), now);
      }
      return null;
    }
    return rowToRefresh({ ...row, used_at: now });
  }

  async revokeRefreshFamily(familyId: string, now: number): Promise<void> {
    await this.db
      .prepare(
        "UPDATE refresh_token_families SET status = 'revoked' WHERE id = ?",
      )
      .bind(familyId)
      .run();
    await this.db
      .prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ?")
      .bind(now, familyId)
      .run();
  }

  async revokeRefreshToken(
    hash: string,
    clientId: string,
    now: number,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT family_id FROM refresh_tokens WHERE token_hash = ? AND client_id = ?",
      )
      .bind(hash, clientId)
      .first<Row>();
    if (!row) return false;
    await this.revokeRefreshFamily(String(row.family_id), now);
    return true;
  }

  async revokeAccessTokenJti(
    jti: string,
    subject: string,
    expiresAt: number,
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO revoked_access_tokens (jti, user_id, expires_at, revoked_at) VALUES (?, ?, ?, ?) ON CONFLICT(jti) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at WHERE revoked_access_tokens.user_id IS NULL OR revoked_access_tokens.user_id = excluded.user_id",
      )
      .bind(jti, subject, expiresAt, now)
      .run();
  }

  async isAccessTokenJtiRevoked(jti: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS ok FROM revoked_access_tokens WHERE jti = ?")
      .bind(jti)
      .first<Row>();
    return Boolean(row);
  }

  async listApplicationEvents(
    userId: string,
    clientId: string,
    afterSequence: number | null,
    limit: number,
    eventType: string | null = null,
  ): Promise<ApplicationEventPage> {
    assertApplicationEventPageInput(
      userId,
      clientId,
      afterSequence,
      limit,
      eventType,
    );
    const rows = await this.db
      .prepare(
        eventType === null
          ? afterSequence === null
            ? "SELECT * FROM application_events WHERE user_id = ? AND client_id = ? ORDER BY sequence ASC LIMIT ?"
            : "SELECT * FROM application_events WHERE user_id = ? AND client_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?"
          : afterSequence === null
            ? "SELECT * FROM application_events WHERE user_id = ? AND client_id = ? AND event_type = ? ORDER BY sequence ASC LIMIT ?"
            : "SELECT * FROM application_events WHERE user_id = ? AND client_id = ? AND event_type = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
      )
      .bind(
        ...[
          userId,
          clientId,
          ...(eventType === null ? [] : [eventType]),
          ...(afterSequence === null ? [] : [afterSequence]),
          limit + 1,
        ],
      )
      .all<Row>();
    const selected = (rows.results ?? []).map(rowToApplicationEvent);
    return {
      items: selected.slice(0, limit),
      hasMore: selected.length > limit,
    };
  }

  async getApplicationEvent(
    userId: string,
    clientId: string,
    id: string,
  ): Promise<ApplicationEvent | null> {
    assertApplicationEventLookupInput(userId, clientId, id);
    const row = await this.db
      .prepare(
        "SELECT * FROM application_events WHERE user_id = ? AND client_id = ? AND id = ? LIMIT 1",
      )
      .bind(userId, clientId, id)
      .first<Row>();
    return row ? rowToApplicationEvent(row) : null;
  }

  async appendApplicationEvent(
    input: ApplicationEventInput,
    limits: ApplicationEventLimits,
  ): Promise<ApplicationEventAppendResult> {
    assertApplicationEventInput(input);
    assertApplicationEventLimits(limits);
    let inserted: Row | null;
    try {
      inserted = await this.db
        .prepare(APPEND_APPLICATION_EVENT)
        .bind(
          input.id,
          input.userId,
          input.clientId,
          input.type,
          input.dataJson,
          input.dataBytes,
          input.idempotencyKeyHash,
          input.requestHash,
          input.createdAt,
          input.expiresAt,
          limits.globalMaxItems,
          limits.globalMaxBytes,
          limits.userMaxItems,
          limits.userMaxBytes,
          limits.namespaceMaxItems,
          limits.namespaceMaxBytes,
        )
        .first<Row>();
    } catch (error) {
      if (isInactiveApplicationEventInsert(error)) {
        return { status: "unavailable" };
      }
      throw error;
    }
    if (inserted) {
      const event = rowToApplicationEvent(inserted);
      if (!sameApplicationEventInput(event, input)) {
        throw new Error("application_event_append_result_invalid");
      }
      return { status: "created", event };
    }
    if (input.idempotencyKeyHash === null) {
      return this.classifyApplicationEventAdmission(input, limits);
    }

    const existing = await this.db
      .prepare(SELECT_APPLICATION_EVENT_REPLAY)
      .bind(input.userId, input.clientId, input.idempotencyKeyHash)
      .first<Row>();
    if (!existing) return this.classifyApplicationEventAdmission(input, limits);
    const event = rowToApplicationEvent(existing);
    if (
      event.userId !== input.userId ||
      event.clientId !== input.clientId ||
      event.idempotencyKeyHash !== input.idempotencyKeyHash
    ) {
      throw new Error("application_event_append_result_invalid");
    }
    return event.requestHash === input.requestHash
      ? { status: "replayed", event }
      : { status: "conflict" };
  }

  private async classifyApplicationEventAdmission(
    input: ApplicationEventInput,
    limits: ApplicationEventLimits,
  ): Promise<ApplicationEventAppendResult> {
    const row = await this.db
      .prepare(CLASSIFY_APPLICATION_EVENT_ADMISSION)
      .bind(
        input.userId,
        input.clientId,
        input.id,
        input.dataBytes,
        limits.globalMaxItems,
        limits.globalMaxBytes,
        limits.userMaxItems,
        limits.userMaxBytes,
        limits.namespaceMaxItems,
        limits.namespaceMaxBytes,
      )
      .first<Row>();
    if (!row) throw new Error("application_event_admission_result_invalid");
    const active = sqlBoolean(row.active);
    const idExists = sqlBoolean(row.id_exists);
    const quotaExceeded = sqlBoolean(row.quota_exceeded);
    if (active === null || idExists === null || quotaExceeded === null) {
      throw new Error("application_event_admission_result_invalid");
    }
    if (!active || idExists) return { status: "unavailable" };
    return quotaExceeded
      ? { status: "quota_exceeded" }
      : { status: "unavailable" };
  }

  async listStorageRecords(
    userId: string,
    clientId: string,
    after: StorageListPosition | null,
    limit: number,
  ): Promise<StorageListPage<StorageRecord>> {
    const rows = await this.db
      .prepare(
        after
          ? "SELECT * FROM storage_records WHERE user_id = ? AND client_id = ? AND (updated_at < ? OR (updated_at = ? AND key > ?)) ORDER BY updated_at DESC, key ASC LIMIT ?"
          : "SELECT * FROM storage_records WHERE user_id = ? AND client_id = ? ORDER BY updated_at DESC, key ASC LIMIT ?",
      )
      .bind(
        ...(after
          ? [
              userId,
              clientId,
              after.updatedAt,
              after.updatedAt,
              after.key,
              limit + 1,
            ]
          : [userId, clientId, limit + 1]),
      )
      .all<Row>();
    const items = (rows.results ?? []).map(rowToStorageRecord);
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  }

  async getStorageRecord(
    userId: string,
    clientId: string,
    key: string,
  ): Promise<StorageRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM storage_records WHERE user_id = ? AND client_id = ? AND key = ?",
      )
      .bind(userId, clientId, key)
      .first<Row>();
    return row ? rowToStorageRecord(row) : null;
  }

  async upsertStorageRecord(
    record: StorageRecord,
    limits: StorageLimits,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(UPSERT_STORAGE_RECORD_WITH_LIMITS)
      .bind(
        record.userId,
        record.clientId,
        record.key,
        record.valueJson,
        record.createdAt,
        record.updatedAt,
        limits.globalMaxItems,
        limits.globalMaxBytes,
        limits.userMaxItems,
        limits.userMaxBytes,
        limits.namespaceMaxItems,
        limits.namespaceMaxBytes,
      )
      .run();
    return mutationChanges(result) === 1;
  }

  async deleteStorageRecord(
    userId: string,
    clientId: string,
    key: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM storage_records WHERE user_id = ? AND client_id = ? AND key = ?",
      )
      .bind(userId, clientId, key)
      .run();
  }

  async getBoundedStorageRecord(
    userId: string,
    clientId: string,
    collection: string,
    id: string,
  ): Promise<BoundedStorageRecord | null> {
    assertBoundedStorageKey(collection, id);
    const row = await this.db
      .prepare(
        "SELECT * FROM bounded_storage_records WHERE user_id = ? AND client_id = ? AND collection = ? AND record_id = ?",
      )
      .bind(userId, clientId, collection, id)
      .first<Row>();
    return row ? rowToBoundedStorageRecord(row) : null;
  }

  async listBoundedStorageRecords(
    userId: string,
    clientId: string,
    collection: string,
    afterId: string | null,
    limit: number,
  ): Promise<BoundedStorageRecordPage> {
    assertBoundedStoragePage(collection, afterId, limit);
    const rows = await this.db
      .prepare(
        afterId === null
          ? "SELECT * FROM bounded_storage_records WHERE user_id = ? AND client_id = ? AND collection = ? ORDER BY record_id ASC LIMIT ?"
          : "SELECT * FROM bounded_storage_records WHERE user_id = ? AND client_id = ? AND collection = ? AND record_id > ? ORDER BY record_id ASC LIMIT ?",
      )
      .bind(
        ...(afterId === null
          ? [userId, clientId, collection, limit + 1]
          : [userId, clientId, collection, afterId, limit + 1]),
      )
      .all<Row>();
    const items = (rows.results ?? []).map(rowToBoundedStorageRecord);
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  }

  async transactBoundedStorageRecords(
    userId: string,
    clientId: string,
    command: Readonly<BoundedRecordTransactionCommand>,
    limits: Readonly<StorageLimits>,
    now: number,
    options?: Readonly<BoundedStorageTransactionOptions>,
  ): Promise<BoundedStorageTransactionResult> {
    const prepared = await prepareBoundedStorageTransaction({
      userId,
      clientId,
      command,
      limits,
      receiptLimits:
        options?.receiptLimits ?? BOUNDED_RECORD_RECEIPT_DEFAULT_LIMITS,
      receiptRetentionSeconds:
        options?.receiptRetentionSeconds ??
        BOUNDED_RECORD_RECEIPT_DEFAULT_RETENTION_SECONDS,
      now,
    });
    if (!this.db.batch) return { status: "unavailable" };

    const commonBindings = boundedTransactionBindings(prepared, limits);
    const statements: D1PreparedStatement[] = [
      this.db.prepare(BOUNDED_TRANSACTION_PREFLIGHT).bind(...commonBindings),
      this.db
        .prepare(BOUNDED_TRANSACTION_INSERT_RECEIPT)
        .bind(...commonBindings),
    ];
    const mutationIndexes: number[] = [];
    for (const mutation of prepared.command.transaction.mutations) {
      const statement = boundedTransactionMutationStatement(
        this.db,
        prepared,
        mutation,
      );
      if (statement) {
        mutationIndexes.push(statements.length);
        statements.push(statement);
      }
    }
    const commitIndex = statements.length;
    statements.push(
      boundedTransactionCommitStatement(
        this.db,
        prepared,
        prepared.command.transaction.mutations,
      ),
    );
    const abortIndex = statements.length;
    statements.push(
      this.db
        .prepare(BOUNDED_TRANSACTION_ABORT_PENDING)
        .bind(
          prepared.userId,
          prepared.clientId,
          prepared.operationIdHash,
          prepared.requestHash,
          prepared.attemptHash,
        ),
    );
    const receiptIndex = statements.length;
    statements.push(
      this.db
        .prepare(BOUNDED_TRANSACTION_SELECT_RECEIPT)
        .bind(prepared.userId, prepared.clientId, prepared.operationIdHash),
    );

    let results: D1Result[];
    try {
      results = await this.db.batch(statements);
    } catch {
      return { status: "unavailable" };
    }
    if (
      results.length !== statements.length ||
      results.some((result) => result.success !== true)
    ) {
      return { status: "unavailable" };
    }

    const preflight = firstBatchRow(results[0]!);
    const outcome = preflight?.outcome;
    if (
      outcome !== "created" &&
      outcome !== "replayed" &&
      outcome !== "conflict" &&
      outcome !== "precondition_failed" &&
      outcome !== "quota_exceeded" &&
      outcome !== "unavailable"
    ) {
      return { status: "unavailable" };
    }
    const receipt = firstBatchRow(results[receiptIndex]!);
    const inserted = mutationChanges(results[1]!);
    const committed = mutationChanges(results[commitIndex]!);
    const aborted = mutationChanges(results[abortIndex]!);
    const changedRecords = mutationIndexes.map((index) =>
      mutationChanges(results[index]!),
    );

    if (outcome === "created") {
      if (
        inserted !== 1 ||
        committed !== 1 ||
        aborted !== 0 ||
        changedRecords.some((changes) => changes !== 1) ||
        !isCommittedBoundedTransactionReceipt(
          receipt,
          prepared.requestHash,
          prepared.attemptHash,
        )
      ) {
        return { status: "unavailable" };
      }
      try {
        return {
          status: "created",
          records: parseBoundedStorageTransactionResult(
            String(receipt.result_json),
            prepared.command,
          ),
        };
      } catch {
        return { status: "unavailable" };
      }
    }

    if (outcome === "replayed") {
      if (
        inserted !== 0 ||
        committed !== 0 ||
        aborted !== 0 ||
        changedRecords.some((changes) => changes !== 0) ||
        !isCommittedBoundedTransactionReceipt(
          receipt,
          prepared.requestHash,
          null,
        ) ||
        receipt.attempt_hash === prepared.attemptHash
      ) {
        return { status: "unavailable" };
      }
      try {
        return {
          status: "replayed",
          records: parseBoundedStorageTransactionResult(
            String(receipt.result_json),
            prepared.command,
          ),
        };
      } catch {
        return { status: "unavailable" };
      }
    }

    if (
      inserted !== 0 ||
      committed !== 0 ||
      aborted !== 0 ||
      changedRecords.some((changes) => changes !== 0)
    ) {
      return { status: "unavailable" };
    }
    return { status: outcome };
  }

  async listStorageFiles(
    userId: string,
    clientId: string,
    after: StorageListPosition | null,
    limit: number,
  ): Promise<StorageListPage<StorageFileMetadata>> {
    const rows = await this.db
      .prepare(
        after
          ? "SELECT * FROM storage_files WHERE user_id = ? AND client_id = ? AND (updated_at < ? OR (updated_at = ? AND key > ?)) ORDER BY updated_at DESC, key ASC LIMIT ?"
          : "SELECT * FROM storage_files WHERE user_id = ? AND client_id = ? ORDER BY updated_at DESC, key ASC LIMIT ?",
      )
      .bind(
        ...(after
          ? [
              userId,
              clientId,
              after.updatedAt,
              after.updatedAt,
              after.key,
              limit + 1,
            ]
          : [userId, clientId, limit + 1]),
      )
      .all<Row>();
    const items = (rows.results ?? []).map(rowToStorageFile);
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  }

  async getStorageFileMetadata(
    userId: string,
    clientId: string,
    key: string,
  ): Promise<StorageFileMetadata | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM storage_files WHERE user_id = ? AND client_id = ? AND key = ?",
      )
      .bind(userId, clientId, key)
      .first<Row>();
    return row ? rowToStorageFile(row) : null;
  }

  async upsertStorageFileMetadata(
    file: StorageFileMetadata,
    expectedR2Key: string | null,
    limits?: StorageLimits,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        limits
          ? UPSERT_STORAGE_FILE_WITH_LIMITS
          : UPSERT_STORAGE_FILE_COMPARE_AND_SET,
      )
      .bind(
        file.userId,
        file.clientId,
        file.key,
        file.r2Key,
        file.contentType,
        file.size,
        file.sha256,
        file.createdAt,
        file.updatedAt,
        expectedR2Key,
        ...(limits
          ? [
              limits.globalMaxItems,
              limits.globalMaxBytes,
              limits.userMaxItems,
              limits.userMaxBytes,
              limits.namespaceMaxItems,
              limits.namespaceMaxBytes,
            ]
          : []),
      )
      .run();
    return mutationChanges(result) === 1;
  }

  async deleteStorageFileMetadata(
    userId: string,
    clientId: string,
    key: string,
    expectedR2Key: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "DELETE FROM storage_files WHERE user_id = ? AND client_id = ? AND key = ? AND r2_key = ?",
      )
      .bind(userId, clientId, key, expectedR2Key)
      .run();
    return mutationChanges(result) === 1;
  }

  async recordStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "INSERT INTO storage_file_orphan_repairs (r2_key, user_id, client_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(r2_key) DO UPDATE SET updated_at = MAX(storage_file_orphan_repairs.updated_at, excluded.updated_at) WHERE storage_file_orphan_repairs.user_id = excluded.user_id AND storage_file_orphan_repairs.client_id = excluded.client_id",
      )
      .bind(
        repair.r2Key,
        repair.userId,
        repair.clientId,
        repair.createdAt,
        repair.updatedAt,
      )
      .run();
    return mutationChanges(result) === 1;
  }

  async reserveStorageFileWriteFence(
    fence: StorageFileWriteFence,
  ): Promise<boolean> {
    assertStorageFileWriteFence(fence);
    const result = await this.db
      .prepare(
        "INSERT INTO storage_file_write_fences (r2_key, user_id, client_id, created_at, expires_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?) AND EXISTS (SELECT 1 FROM oauth_clients WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = ?) AND NOT EXISTS (SELECT 1 FROM storage_file_orphan_repairs WHERE r2_key = ?) ON CONFLICT(r2_key) DO NOTHING",
      )
      .bind(
        fence.r2Key,
        fence.userId,
        fence.clientId,
        fence.createdAt,
        fence.expiresAt,
        fence.userId,
        fence.clientId,
        fence.userId,
        fence.r2Key,
      )
      .run();
    return mutationChanges(result) === 1;
  }

  async completeStorageFileWriteFence(
    fence: StorageFileWriteFence,
  ): Promise<boolean> {
    assertStorageFileWriteFence(fence);
    const result = await this.db
      .prepare(
        "DELETE FROM storage_file_write_fences WHERE r2_key = ? AND user_id = ? AND client_id = ? AND created_at = ? AND expires_at = ?",
      )
      .bind(
        fence.r2Key,
        fence.userId,
        fence.clientId,
        fence.createdAt,
        fence.expiresAt,
      )
      .run();
    return mutationChanges(result) === 1;
  }

  async convertStorageFileWriteFenceToRepair(
    fence: StorageFileWriteFence,
    now: number,
  ): Promise<boolean> {
    assertStorageFileWriteFence(fence);
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError("storage_file_write_fence_now_invalid");
    }
    if (!this.db.batch) {
      throw new Error("storage_file_write_fence_batch_unavailable");
    }
    const results = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO storage_file_orphan_repairs (r2_key, user_id, client_id, created_at, updated_at) SELECT r2_key, user_id, client_id, created_at, ? FROM storage_file_write_fences WHERE r2_key = ? AND user_id = ? AND client_id = ? AND created_at = ? AND expires_at = ? ON CONFLICT(r2_key) DO UPDATE SET updated_at = MAX(storage_file_orphan_repairs.updated_at, excluded.updated_at) WHERE storage_file_orphan_repairs.user_id = excluded.user_id AND storage_file_orphan_repairs.client_id = excluded.client_id",
        )
        .bind(
          now,
          fence.r2Key,
          fence.userId,
          fence.clientId,
          fence.createdAt,
          fence.expiresAt,
        ),
      this.db
        .prepare(
          "DELETE FROM storage_file_write_fences WHERE r2_key = ? AND user_id = ? AND client_id = ? AND created_at = ? AND expires_at = ? AND EXISTS (SELECT 1 FROM storage_file_orphan_repairs WHERE r2_key = ? AND user_id = ? AND client_id = ?)",
        )
        .bind(
          fence.r2Key,
          fence.userId,
          fence.clientId,
          fence.createdAt,
          fence.expiresAt,
          fence.r2Key,
          fence.userId,
          fence.clientId,
        ),
    ]);
    if (results.length !== 2 || results.some((result) => !result.success)) {
      throw new Error("storage_file_write_fence_conversion_failed");
    }
    return mutationChanges(results[1]!) === 1;
  }

  async listStorageFileOrphanRepairs(
    limit: number,
  ): Promise<StorageFileOrphanRepair[]> {
    const rows = await this.db
      .prepare(
        "SELECT * FROM storage_file_orphan_repairs ORDER BY updated_at ASC, created_at ASC, r2_key ASC LIMIT ?",
      )
      .bind(limit)
      .all<Row>();
    return (rows.results ?? []).map(rowToStorageFileOrphanRepair);
  }

  async listStorageFileOrphanRepairsForSubject(
    subject: string,
    limit: number,
  ): Promise<StorageFileOrphanRepair[]> {
    const rows = await this.db
      .prepare(
        "SELECT * FROM storage_file_orphan_repairs WHERE user_id = ? ORDER BY updated_at ASC, created_at ASC, r2_key ASC LIMIT ?",
      )
      .bind(subject, limit)
      .all<Row>();
    return (rows.results ?? []).map(rowToStorageFileOrphanRepair);
  }

  async hasStorageFileOrphanRepairsForSubject(
    subject: string,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 AS present FROM storage_file_orphan_repairs WHERE user_id = ? LIMIT 1",
      )
      .bind(subject)
      .first<Row>();
    return Boolean(row);
  }

  async classifyStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
  ): Promise<StorageFileOrphanRepairDisposition> {
    const row = await this.db
      .prepare(
        "SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM storage_file_orphan_repairs WHERE r2_key = ?1 AND user_id = ?2 AND client_id = ?3) THEN 'missing' WHEN EXISTS (SELECT 1 FROM storage_files WHERE r2_key = ?1 AND (user_id <> ?2 OR client_id <> ?3)) THEN 'conflict' WHEN EXISTS (SELECT 1 FROM storage_files WHERE r2_key = ?1) THEN 'referenced' ELSE 'orphan' END AS disposition",
      )
      .bind(repair.r2Key, repair.userId, repair.clientId)
      .first<Row>();
    const disposition = row?.disposition;
    if (
      disposition !== "missing" &&
      disposition !== "referenced" &&
      disposition !== "conflict" &&
      disposition !== "orphan"
    ) {
      throw new Error("storage_file_orphan_repair_classification_failed");
    }
    return disposition;
  }

  async completeStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "DELETE FROM storage_file_orphan_repairs WHERE r2_key = ? AND user_id = ? AND client_id = ?",
      )
      .bind(repair.r2Key, repair.userId, repair.clientId)
      .run();
    return mutationChanges(result) === 1;
  }

  async deferStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
    now: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE storage_file_orphan_repairs SET updated_at = MAX(updated_at, ?) WHERE r2_key = ? AND user_id = ? AND client_id = ?",
      )
      .bind(now, repair.r2Key, repair.userId, repair.clientId)
      .run();
    return mutationChanges(result) === 1;
  }

  async getStorageUsage(
    userId: string,
    clientId: string,
  ): Promise<StorageUsage> {
    const row = await this.db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM storage_records WHERE user_id = ?1 AND client_id = ?2) + (SELECT COUNT(*) FROM bounded_storage_records WHERE user_id = ?1 AND client_id = ?2) + (SELECT COUNT(*) FROM storage_files WHERE user_id = ?1 AND client_id = ?2) AS item_count, (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records WHERE user_id = ?1 AND client_id = ?2) + (SELECT COALESCE(SUM(value_bytes), 0) FROM bounded_storage_records WHERE user_id = ?1 AND client_id = ?2) + (SELECT COALESCE(SUM(size), 0) FROM storage_files WHERE user_id = ?1 AND client_id = ?2) AS byte_count",
      )
      .bind(userId, clientId)
      .first<Row>();
    return {
      itemCount: Number(row?.item_count ?? 0),
      byteCount: Number(row?.byte_count ?? 0),
    };
  }

  private async hydrateClient(row: Row): Promise<ClientView> {
    const [redirectUris, scopes, origins] = await Promise.all([
      listColumn(
        this.db,
        "SELECT redirect_uri FROM client_redirect_uris WHERE client_id = ?",
        row.id,
      ),
      listColumn(
        this.db,
        "SELECT scope FROM client_scopes WHERE client_id = ?",
        row.id,
      ),
      listColumn(
        this.db,
        "SELECT origin FROM client_origins WHERE client_id = ?",
        row.id,
      ),
    ]);
    return {
      id: String(row.id),
      type:
        row.client_kind === "service"
          ? "service"
          : row.type === "confidential"
            ? "confidential"
            : "public",
      name: String(row.name),
      disabledAt: nullableNumber(row.disabled_at),
      redirectUris,
      scopes,
      origins,
      createdAt: Number(row.created_at),
    };
  }
}

function boundedTransactionBindings(
  prepared: Readonly<PreparedBoundedStorageTransaction>,
  limits: Readonly<StorageLimits>,
): (string | number)[] {
  return [
    prepared.userId,
    prepared.clientId,
    prepared.operationIdHash,
    prepared.requestHash,
    prepared.attemptHash,
    prepared.mutationsJson,
    prepared.command.transaction.mutations.length,
    prepared.now,
    prepared.maxResultBytes,
    limits.writesEnabled ? 1 : 0,
    limits.globalMaxItems,
    limits.globalMaxBytes,
    limits.userMaxItems,
    limits.userMaxBytes,
    limits.namespaceMaxItems,
    limits.namespaceMaxBytes,
    prepared.receiptLimits.globalMaxItems,
    prepared.receiptLimits.globalMaxBytes,
    prepared.receiptLimits.userMaxItems,
    prepared.receiptLimits.userMaxBytes,
    prepared.receiptLimits.namespaceMaxItems,
    prepared.receiptLimits.namespaceMaxBytes,
    prepared.receiptExpiresAt,
    prepared.deleteReceiptReserveLimits.globalMaxItems,
    prepared.deleteReceiptReserveLimits.globalMaxBytes,
    prepared.deleteReceiptReserveLimits.userMaxItems,
    prepared.deleteReceiptReserveLimits.userMaxBytes,
    prepared.deleteReceiptReserveLimits.namespaceMaxItems,
    prepared.deleteReceiptReserveLimits.namespaceMaxBytes,
  ];
}

function boundedTransactionMutationStatement(
  db: D1Database,
  prepared: Readonly<PreparedBoundedStorageTransaction>,
  mutation: Readonly<BoundedRecordMutation>,
): D1PreparedStatement | null {
  if (mutation.type === "check") return null;
  if (mutation.type === "delete") {
    return db
      .prepare(BOUNDED_TRANSACTION_DELETE)
      .bind(
        prepared.userId,
        prepared.clientId,
        mutation.key.collection,
        mutation.key.id,
        mutation.expected_revision,
        prepared.operationIdHash,
        prepared.requestHash,
        prepared.attemptHash,
      );
  }
  const valueJson = JSON.stringify(mutation.value);
  return db
    .prepare(BOUNDED_TRANSACTION_PUT)
    .bind(
      prepared.userId,
      prepared.clientId,
      mutation.key.collection,
      mutation.key.id,
      valueJson,
      new TextEncoder().encode(valueJson).byteLength,
      prepared.now,
      prepared.operationIdHash,
      prepared.requestHash,
      prepared.attemptHash,
      mutation.expected_revision,
    );
}

function boundedTransactionCommitStatement(
  db: D1Database,
  prepared: Readonly<PreparedBoundedStorageTransaction>,
  mutations: readonly Readonly<BoundedRecordMutation>[],
): D1PreparedStatement {
  let sql = `
UPDATE bounded_storage_transaction_receipts
SET status = 'committed', committed_at = ?
WHERE user_id = ? AND client_id = ? AND operation_id_hash = ?
  AND request_hash = ? AND attempt_hash = ? AND status = 'pending'`;
  const bindings: (string | number)[] = [
    prepared.now,
    prepared.userId,
    prepared.clientId,
    prepared.operationIdHash,
    prepared.requestHash,
    prepared.attemptHash,
  ];

  for (const mutation of mutations) {
    if (mutation.type === "delete") {
      sql += `
  AND NOT EXISTS (
    SELECT 1 FROM bounded_storage_records
    WHERE user_id = ? AND client_id = ? AND collection = ? AND record_id = ?
  )`;
      bindings.push(
        prepared.userId,
        prepared.clientId,
        mutation.key.collection,
        mutation.key.id,
      );
      continue;
    }
    if (mutation.type === "check" && mutation.expected_revision === null) {
      sql += `
  AND NOT EXISTS (
    SELECT 1 FROM bounded_storage_records
    WHERE user_id = ? AND client_id = ? AND collection = ? AND record_id = ?
  )`;
      bindings.push(
        prepared.userId,
        prepared.clientId,
        mutation.key.collection,
        mutation.key.id,
      );
      continue;
    }
    if (mutation.type === "check") {
      const expectedRevision = mutation.expected_revision;
      if (expectedRevision === null) {
        throw new Error("bounded_storage_transaction_command_invalid");
      }
      sql += `
  AND EXISTS (
    SELECT 1 FROM bounded_storage_records
    WHERE user_id = ? AND client_id = ? AND collection = ? AND record_id = ?
      AND revision = ?
  )`;
      bindings.push(
        prepared.userId,
        prepared.clientId,
        mutation.key.collection,
        mutation.key.id,
        expectedRevision,
      );
      continue;
    }

    const valueJson = JSON.stringify(mutation.value);
    sql += `
  AND EXISTS (
    SELECT 1 FROM bounded_storage_records
    WHERE user_id = ? AND client_id = ? AND collection = ? AND record_id = ?
      AND revision = ? AND value_json = ? AND value_bytes = ?
  )`;
    bindings.push(
      prepared.userId,
      prepared.clientId,
      mutation.key.collection,
      mutation.key.id,
      (mutation.expected_revision ?? 0) + 1,
      valueJson,
      new TextEncoder().encode(valueJson).byteLength,
    );
  }
  return db.prepare(sql).bind(...bindings);
}

function firstBatchRow(result: D1Result): Row | null {
  const rows = (result as D1Result<Row>).results;
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row = rows[0];
  return typeof row === "object" && row !== null ? row : null;
}

function isCommittedBoundedTransactionReceipt(
  row: Row | null,
  requestHash: string,
  attemptHash: string | null,
): row is Row & {
  request_hash: string;
  attempt_hash: string;
  status: "committed";
  result_json: string;
} {
  return (
    row !== null &&
    row.request_hash === requestHash &&
    typeof row.attempt_hash === "string" &&
    (attemptHash === null || row.attempt_hash === attemptHash) &&
    row.status === "committed" &&
    typeof row.result_json === "string"
  );
}

async function listColumn(
  db: D1Database,
  sql: string,
  id: unknown,
): Promise<string[]> {
  const rows = await db.prepare(sql).bind(id).all<Row>();
  return (rows.results ?? []).map((row) => String(Object.values(row)[0]));
}

function rowToUser(row: Row): LocalUser {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToResolvedUser(
  row: unknown,
  identity: UpstreamIdentity,
  now: number,
): LocalUser {
  if (
    !row ||
    typeof row !== "object" ||
    !("id" in row) ||
    typeof row.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      row.id,
    ) ||
    !("email" in row) ||
    row.email !== identity.email ||
    !("display_name" in row) ||
    row.display_name !== identity.displayName ||
    !("created_at" in row) ||
    typeof row.created_at !== "number" ||
    !Number.isSafeInteger(row.created_at) ||
    !("updated_at" in row) ||
    typeof row.updated_at !== "number" ||
    row.updated_at !== now ||
    !Number.isSafeInteger(row.updated_at)
  ) {
    throw new Error("user_resolution_failed");
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAccountDeletionJob(row: Row): AccountDeletionJob {
  const state = row.state;
  if (
    state !== "pending" &&
    state !== "running" &&
    state !== "retryable" &&
    state !== "completed"
  ) {
    throw new Error("account_deletion_job_state_invalid");
  }
  return {
    subject: String(row.subject),
    state,
    attempt: Number(row.attempt),
    availableAt: nullableNumber(row.available_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: nullableNumber(row.completed_at),
  };
}

function rowToDevice(row: Row): DeviceGrant {
  return {
    id: String(row.id),
    deviceCodeHash: String(row.device_code_hash),
    userCodeHash: String(row.user_code_hash),
    userCodeDisplay: String(row.user_code_display),
    clientId: String(row.client_id),
    scope: String(row.scope),
    status:
      row.status === "approved" ||
      row.status === "denied" ||
      row.status === "used"
        ? row.status
        : "pending",
    userId: typeof row.user_id === "string" ? row.user_id : null,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    intervalSeconds: Number(row.interval_seconds),
    lastPollAt: nullableNumber(row.last_poll_at),
    slowDownCount: Number(row.slow_down_count),
  };
}

function rowToAuthRequest(row: Row): AuthorizationRequest {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    redirectUri: String(row.redirect_uri),
    scope: String(row.scope),
    state: typeof row.state === "string" ? row.state : null,
    nonce: typeof row.nonce === "string" ? row.nonce : null,
    codeChallenge: String(row.code_challenge),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    userId: typeof row.user_id === "string" ? row.user_id : null,
    status:
      row.status === "approved" || row.status === "denied"
        ? row.status
        : "pending",
  };
}

function rowToAuthCode(row: Row): AuthorizationCode {
  return {
    codeHash: String(row.code_hash),
    authRequestId: String(row.auth_request_id),
    clientId: String(row.client_id),
    redirectUri: String(row.redirect_uri),
    userId: String(row.user_id),
    scope: String(row.scope),
    nonce: typeof row.nonce === "string" ? row.nonce : null,
    expiresAt: Number(row.expires_at),
    consumedAt: nullableNumber(row.consumed_at),
  };
}

function rowToRefresh(row: Row): RefreshTokenRecord {
  return {
    id: String(row.id),
    familyId: String(row.family_id),
    tokenHash: String(row.token_hash),
    userId: String(row.user_id),
    clientId: String(row.client_id),
    scope: String(row.scope),
    expiresAt: Number(row.expires_at),
    usedAt: nullableNumber(row.used_at),
    revokedAt: nullableNumber(row.revoked_at),
  };
}

function rowToStorageRecord(row: Row): StorageRecord {
  return {
    userId: String(row.user_id),
    clientId: String(row.client_id),
    key: String(row.key),
    valueJson: String(row.value_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function assertBoundedStorageKey(collection: string, id: string): void {
  try {
    decodeBoundedRecordKey({ collection, id });
  } catch {
    throw new RangeError("bounded_storage_record_key_invalid");
  }
}

function assertBoundedStoragePage(
  collection: string,
  afterId: string | null,
  limit: number,
): void {
  assertBoundedStorageKey(collection, afterId ?? "cursor-boundary");
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > BOUNDED_RECORD_MAX_PAGE_SIZE
  ) {
    throw new RangeError("bounded_storage_record_page_invalid");
  }
}

function rowToBoundedStorageRecord(row: Row): BoundedStorageRecord {
  if (
    typeof row.user_id !== "string" ||
    typeof row.client_id !== "string" ||
    typeof row.collection !== "string" ||
    typeof row.record_id !== "string" ||
    typeof row.value_json !== "string" ||
    typeof row.value_bytes !== "number" ||
    typeof row.revision !== "number" ||
    typeof row.created_at !== "number" ||
    typeof row.updated_at !== "number" ||
    !Number.isSafeInteger(row.value_bytes) ||
    row.value_bytes < 0 ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.created_at) ||
    row.created_at < 0 ||
    !Number.isSafeInteger(row.updated_at) ||
    row.updated_at < row.created_at ||
    new TextEncoder().encode(row.value_json).byteLength !== row.value_bytes
  ) {
    throw new Error("bounded_storage_record_row_invalid");
  }
  try {
    const key = decodeBoundedRecordKey({
      collection: row.collection,
      id: row.record_id,
    });
    const value: unknown = JSON.parse(row.value_json);
    boundedRecordDocument({
      key,
      revision: row.revision,
      value: value as BoundedRecordValue,
    });
  } catch {
    throw new Error("bounded_storage_record_row_invalid");
  }
  return {
    userId: row.user_id,
    clientId: row.client_id,
    collection: row.collection,
    id: row.record_id,
    valueJson: row.value_json,
    valueBytes: row.value_bytes,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToApplicationEvent(row: Row): ApplicationEvent {
  if (
    typeof row.sequence !== "number" ||
    typeof row.id !== "string" ||
    typeof row.user_id !== "string" ||
    typeof row.client_id !== "string" ||
    typeof row.event_type !== "string" ||
    typeof row.data_json !== "string" ||
    typeof row.data_bytes !== "number" ||
    (row.idempotency_key_hash !== null &&
      typeof row.idempotency_key_hash !== "string") ||
    typeof row.request_hash !== "string" ||
    typeof row.created_at !== "number" ||
    typeof row.expires_at !== "number"
  ) {
    throw new Error("application_event_row_invalid");
  }
  const event: ApplicationEvent = {
    sequence: row.sequence,
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    type: row.event_type,
    dataJson: row.data_json,
    dataBytes: row.data_bytes,
    idempotencyKeyHash: row.idempotency_key_hash,
    requestHash: row.request_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  try {
    assertApplicationEvent(event);
  } catch {
    throw new Error("application_event_row_invalid");
  }
  return event;
}

function rowToStorageFile(row: Row): StorageFileMetadata {
  return {
    userId: String(row.user_id),
    clientId: String(row.client_id),
    key: String(row.key),
    r2Key: String(row.r2_key),
    contentType: String(row.content_type),
    size: Number(row.size),
    sha256: String(row.sha256),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToStorageFileOrphanRepair(row: Row): StorageFileOrphanRepair {
  return {
    r2Key: String(row.r2_key),
    userId: String(row.user_id),
    clientId: String(row.client_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function sqlBoolean(value: unknown): boolean | null {
  if (value === 0) return false;
  if (value === 1) return true;
  return null;
}

function isInactiveApplicationEventInsert(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("account_deletion_subject_inactive")
  );
}

function sameApplicationEventInput(
  event: ApplicationEvent,
  input: ApplicationEventInput,
): boolean {
  return (
    event.id === input.id &&
    event.userId === input.userId &&
    event.clientId === input.clientId &&
    event.type === input.type &&
    event.dataJson === input.dataJson &&
    event.dataBytes === input.dataBytes &&
    event.idempotencyKeyHash === input.idempotencyKeyHash &&
    event.requestHash === input.requestHash &&
    event.createdAt === input.createdAt &&
    event.expiresAt === input.expiresAt
  );
}

function mutationChanges(result: D1Result): number {
  if (!result.success || !result.meta || typeof result.meta !== "object")
    return 0;
  const changes = (result.meta as { changes?: unknown }).changes;
  return typeof changes === "number" ? changes : 0;
}

function assertCleanupMutationSucceeded(result: D1Result): void {
  if (result.success !== true) throw new Error("cleanup_mutation_failed");
}

function cleanupMutationCount(
  result: D1Result,
  category: CleanupCategory,
): number | null {
  assertCleanupMutationSucceeded(result);
  if (
    !result.meta ||
    typeof result.meta !== "object" ||
    Array.isArray(result.meta)
  ) {
    return null;
  }
  const changes = (result.meta as { changes?: unknown }).changes;
  return typeof changes === "number" &&
    Number.isSafeInteger(changes) &&
    changes >= 0 &&
    changes <= CLEANUP_CATEGORY_LIMITS[category]
    ? changes
    : null;
}

function requiredMutationChanges(result: D1Result, error: string): number {
  if (!result.success || !result.meta || typeof result.meta !== "object") {
    throw new Error(error);
  }
  const changes = (result.meta as { changes?: unknown }).changes;
  if (typeof changes !== "number" || !Number.isSafeInteger(changes)) {
    throw new Error(error);
  }
  return changes;
}

function redactAuditData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "actor_subject_hash") continue;
    redacted[key] =
      /token|secret|code|cookie|authorization|password|credential|access_key/i.test(
        key,
      )
        ? "[REDACTED]"
        : value;
  }
  return redacted;
}
