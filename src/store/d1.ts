import { uuid } from "../crypto";
import { REFRESH_FAMILY_ORPHAN_GRACE_SECONDS } from "./cleanup";
import {
  accountDeletionClaimExpiry,
  assertAccountDeletionNow,
  assertAccountDeletionRetryAt,
} from "./account-deletion";
import {
  accountCredentialPurgeUnavailable,
  assertAccountCredentialPurgeLimit,
} from "./account-credential-purge";
import {
  accountRecordPurgeBatch,
  accountRecordPurgeUnavailable,
  assertAccountRecordPurgeInput,
} from "./account-record-purge";
import {
  BROWSER_SESSION_CLIENT_ID,
  isBrowserSessionClientId,
} from "../system-client";
import type {
  AccountDeletionJob,
  AccountDeletionJobStartResult,
  AccountCredentialPurgeBatchResult,
  AccountRecordPurgeBatch,
  AuthStore,
  AuthorizationCode,
  AuthorizationRequest,
  ClientRegistrationInput,
  ClientView,
  DeviceGrant,
  LocalUser,
  RefreshTokenFamily,
  RefreshTokenRecord,
  StorageFileMetadata,
  StorageFileOrphanRepair,
  StorageFileOrphanRepairDisposition,
  StorageLimits,
  StorageListPage,
  StorageListPosition,
  StorageRecord,
  StorageUsage,
  UpstreamIdentity,
} from "../types";

type Row = Record<string, unknown>;

const CLEANUP_BATCH_SIZE = 500;
const AUDIT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const RATE_COUNTER_RETENTION_SECONDS = 5 * 60;
const MAX_RATE_COUNTERS = 10_000;

const ACCOUNT_CREDENTIAL_PURGE_DELETIONS = [
  "DELETE FROM authorization_codes WHERE code_hash IN (SELECT code_hash FROM authorization_codes WHERE user_id = ? ORDER BY expires_at ASC, code_hash ASC LIMIT ?)",
  "DELETE FROM authorization_requests WHERE id IN (SELECT ar.id FROM authorization_requests ar WHERE ar.user_id = ? AND NOT EXISTS (SELECT 1 FROM authorization_codes ac WHERE ac.auth_request_id = ar.id) ORDER BY ar.expires_at ASC, ar.id ASC LIMIT ?)",
  "DELETE FROM device_grants WHERE id IN (SELECT id FROM device_grants WHERE user_id = ? ORDER BY expires_at ASC, id ASC LIMIT ?)",
  "DELETE FROM consents WHERE rowid IN (SELECT rowid FROM consents WHERE user_id = ? ORDER BY created_at ASC, client_id ASC, scope ASC LIMIT ?)",
  "DELETE FROM refresh_tokens WHERE id IN (SELECT id FROM refresh_tokens WHERE user_id = ? ORDER BY expires_at ASC, id ASC LIMIT ?)",
  "DELETE FROM refresh_token_families WHERE id IN (SELECT family.id FROM refresh_token_families family WHERE family.user_id = ? AND NOT EXISTS (SELECT 1 FROM refresh_tokens token WHERE token.family_id = family.id) ORDER BY family.created_at ASC, family.id ASC LIMIT ?)",
  "DELETE FROM revoked_access_tokens WHERE jti IN (SELECT jti FROM revoked_access_tokens WHERE user_id = ? ORDER BY revoked_at ASC, jti ASC LIMIT ?)",
] as const;

const ACCOUNT_CREDENTIAL_PURGE_REMAINS =
  "SELECT 1 AS remaining FROM authorization_codes WHERE user_id = ?1 UNION ALL SELECT 1 FROM authorization_requests WHERE user_id = ?1 UNION ALL SELECT 1 FROM device_grants WHERE user_id = ?1 UNION ALL SELECT 1 FROM consents WHERE user_id = ?1 UNION ALL SELECT 1 FROM refresh_tokens WHERE user_id = ?1 UNION ALL SELECT 1 FROM refresh_token_families WHERE user_id = ?1 UNION ALL SELECT 1 FROM revoked_access_tokens WHERE user_id = ?1 LIMIT 1";

const UPSERT_STORAGE_RECORD_WITH_LIMITS = `
INSERT INTO storage_records (user_id, client_id, key, value_json, created_at, updated_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6
WHERE
  (SELECT COUNT(*) FROM storage_records) +
  (SELECT COUNT(*) FROM storage_files) +
  CASE WHEN EXISTS (SELECT 1 FROM storage_records WHERE user_id = ?1 AND client_id = ?2 AND key = ?3) THEN 0 ELSE 1 END <= ?7
  AND (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records) +
  (SELECT COALESCE(SUM(size), 0) FROM storage_files) -
  COALESCE((SELECT length(CAST(value_json AS BLOB)) FROM storage_records WHERE user_id = ?1 AND client_id = ?2 AND key = ?3), 0) +
  length(CAST(?4 AS BLOB)) <= ?8
  AND (SELECT COUNT(*) FROM storage_records WHERE user_id = ?1) +
  (SELECT COUNT(*) FROM storage_files WHERE user_id = ?1) +
  CASE WHEN EXISTS (SELECT 1 FROM storage_records WHERE user_id = ?1 AND client_id = ?2 AND key = ?3) THEN 0 ELSE 1 END <= ?9
  AND (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records WHERE user_id = ?1) +
  (SELECT COALESCE(SUM(size), 0) FROM storage_files WHERE user_id = ?1) -
  COALESCE((SELECT length(CAST(value_json AS BLOB)) FROM storage_records WHERE user_id = ?1 AND client_id = ?2 AND key = ?3), 0) +
  length(CAST(?4 AS BLOB)) <= ?10
  AND (SELECT COUNT(*) FROM storage_records WHERE user_id = ?1 AND client_id = ?2) +
  (SELECT COUNT(*) FROM storage_files WHERE user_id = ?1 AND client_id = ?2) +
  CASE WHEN EXISTS (SELECT 1 FROM storage_records WHERE user_id = ?1 AND client_id = ?2 AND key = ?3) THEN 0 ELSE 1 END <= ?11
  AND (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records WHERE user_id = ?1 AND client_id = ?2) +
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
  (SELECT COUNT(*) FROM storage_files) +
  CASE WHEN EXISTS (SELECT 1 FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3) THEN 0 ELSE 1 END <= ?11
  AND (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records) +
  (SELECT COALESCE(SUM(size), 0) FROM storage_files) -
  COALESCE((SELECT size FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3), 0) + ?6 <= ?12
  AND (SELECT COUNT(*) FROM storage_records WHERE user_id = ?1) +
  (SELECT COUNT(*) FROM storage_files WHERE user_id = ?1) +
  CASE WHEN EXISTS (SELECT 1 FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3) THEN 0 ELSE 1 END <= ?13
  AND (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records WHERE user_id = ?1) +
  (SELECT COALESCE(SUM(size), 0) FROM storage_files WHERE user_id = ?1) -
  COALESCE((SELECT size FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3), 0) + ?6 <= ?14
  AND (SELECT COUNT(*) FROM storage_records WHERE user_id = ?1 AND client_id = ?2) +
  (SELECT COUNT(*) FROM storage_files WHERE user_id = ?1 AND client_id = ?2) +
  CASE WHEN EXISTS (SELECT 1 FROM storage_files WHERE user_id = ?1 AND client_id = ?2 AND key = ?3) THEN 0 ELSE 1 END <= ?15
  AND (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records WHERE user_id = ?1 AND client_id = ?2) +
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

export class D1AuthStore implements AuthStore {
  constructor(private readonly db: D1Database) {}

  async cleanup(now: number): Promise<void> {
    const deletions: Array<[string, ...unknown[]]> = [
      [
        "DELETE FROM authorization_codes WHERE rowid IN (SELECT rowid FROM authorization_codes WHERE expires_at <= ? ORDER BY expires_at ASC, rowid ASC LIMIT ?)",
        now,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "DELETE FROM authorization_requests WHERE rowid IN (SELECT ar.rowid FROM authorization_requests ar WHERE ar.expires_at <= ? AND NOT EXISTS (SELECT 1 FROM authorization_codes ac WHERE ac.auth_request_id = ar.id AND ac.expires_at > ?) ORDER BY ar.expires_at ASC, ar.rowid ASC LIMIT ?)",
        now,
        now,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "DELETE FROM device_grants WHERE rowid IN (SELECT rowid FROM device_grants WHERE expires_at <= ? ORDER BY expires_at ASC, rowid ASC LIMIT ?)",
        now,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "DELETE FROM refresh_tokens WHERE rowid IN (SELECT rowid FROM refresh_tokens WHERE expires_at <= ? ORDER BY expires_at ASC, rowid ASC LIMIT ?)",
        now,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "DELETE FROM refresh_token_families WHERE rowid IN (SELECT rtf.rowid FROM refresh_token_families rtf WHERE rtf.created_at <= ? AND NOT EXISTS (SELECT 1 FROM refresh_tokens rt WHERE rt.family_id = rtf.id) ORDER BY rtf.created_at ASC, rtf.rowid ASC LIMIT ?)",
        now - REFRESH_FAMILY_ORPHAN_GRACE_SECONDS,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "DELETE FROM revoked_access_tokens WHERE rowid IN (SELECT rowid FROM revoked_access_tokens WHERE expires_at <= ? ORDER BY expires_at ASC, rowid ASC LIMIT ?)",
        now,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "DELETE FROM audit_events WHERE rowid IN (SELECT rowid FROM audit_events WHERE created_at <= ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
        now - AUDIT_RETENTION_SECONDS,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "DELETE FROM rate_limit_counters WHERE rowid IN (SELECT rowid FROM rate_limit_counters WHERE window_start <= ? ORDER BY window_start ASC, rowid ASC LIMIT ?)",
        now - RATE_COUNTER_RETENTION_SECONDS,
        CLEANUP_BATCH_SIZE,
      ],
      [
        "DELETE FROM admin_operation_submissions WHERE rowid IN (SELECT rowid FROM admin_operation_submissions WHERE expires_at <= ? ORDER BY expires_at ASC, rowid ASC LIMIT ?)",
        now,
        CLEANUP_BATCH_SIZE,
      ],
    ];
    for (const [sql, ...values] of deletions) {
      await this.db
        .prepare(sql)
        .bind(...values)
        .run();
    }
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
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO audit_events (type, data_json, created_at) VALUES (?, ?, ?)",
      )
      .bind(type, JSON.stringify(redact(data)), now)
      .run();
  }

  async findOrCreateUser(
    identity: UpstreamIdentity,
    now: number,
  ): Promise<LocalUser> {
    const existing = await this.db
      .prepare("SELECT * FROM users WHERE email = ?")
      .bind(identity.email)
      .first<Row>();
    if (existing) {
      await this.db
        .prepare(
          "UPDATE users SET display_name = ?, updated_at = ? WHERE email = ?",
        )
        .bind(identity.displayName, now, identity.email)
        .run();
      return rowToUser({
        ...existing,
        display_name: identity.displayName,
        updated_at: now,
      });
    }
    const user: LocalUser = {
      id: uuid(),
      email: identity.email,
      displayName: identity.displayName,
      createdAt: now,
      updatedAt: now,
    };
    await this.db
      .prepare(
        "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        user.id,
        user.email,
        user.displayName,
        user.createdAt,
        user.updatedAt,
      )
      .run();
    return user;
  }

  async getUser(id: string): Promise<LocalUser | null> {
    const row = await this.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .bind(id)
      .first<Row>();
    return row ? rowToUser(row) : null;
  }

  async countUsers(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS identity_count FROM users")
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
        "INSERT INTO account_deletion_jobs (subject, state, attempt, available_at, created_at, updated_at, completed_at) SELECT ?, 'pending', 0, ?, ?, ?, NULL FROM users WHERE id = ? ON CONFLICT(subject) DO NOTHING RETURNING subject, state, attempt, available_at, created_at, updated_at, completed_at",
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

  async completeAccountDeletionJob(
    subject: string,
    attempt: number,
    now: number,
  ): Promise<boolean> {
    assertAccountDeletionNow(now);
    if (!Number.isSafeInteger(attempt) || attempt < 1) return false;
    const result = await this.db
      .prepare(
        "UPDATE account_deletion_jobs SET state = 'completed', available_at = NULL, updated_at = ?, completed_at = ? WHERE subject = ? AND state = 'running' AND attempt = ? AND available_at > ?",
      )
      .bind(now, now, subject, attempt, now)
      .run();
    return mutationChanges(result) === 1;
  }

  async purgeAccountCredentialsAndGrants(
    subject: string,
    limit: number,
  ): Promise<AccountCredentialPurgeBatchResult> {
    assertAccountCredentialPurgeLimit(limit);
    if (!(await this.getAccountDeletionJob(subject))) {
      throw accountCredentialPurgeUnavailable();
    }

    let deletedCount = 0;
    for (const sql of ACCOUNT_CREDENTIAL_PURGE_DELETIONS) {
      const remaining = limit - deletedCount;
      if (remaining === 0) break;
      const result = await this.db.prepare(sql).bind(subject, remaining).run();
      const changes = mutationChanges(result);
      if (changes < 0 || changes > remaining) {
        throw new Error("account_credential_purge_failed");
      }
      deletedCount += changes;
    }

    const remaining = await this.db
      .prepare(ACCOUNT_CREDENTIAL_PURGE_REMAINS)
      .bind(subject)
      .first<Row>();
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
    const result = await this.db
      .prepare(
        "DELETE FROM storage_records WHERE rowid IN (SELECT rowid FROM storage_records WHERE user_id = ? ORDER BY client_id ASC, key ASC LIMIT ?)",
      )
      .bind(subject, limit)
      .run();
    return accountRecordPurgeBatch(
      requiredMutationChanges(result, "account_record_purge_failed"),
      limit,
    );
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
        .prepare("INSERT INTO client_origins (client_id, origin) VALUES (?, ?)")
        .bind(client.id, origin)
        .run();
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

  async classifyStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
  ): Promise<StorageFileOrphanRepairDisposition> {
    const row = await this.db
      .prepare(
        "SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM storage_file_orphan_repairs WHERE r2_key = ? AND user_id = ? AND client_id = ?) THEN 'missing' WHEN EXISTS (SELECT 1 FROM storage_files WHERE r2_key = ?) THEN 'referenced' ELSE 'orphan' END AS disposition",
      )
      .bind(repair.r2Key, repair.userId, repair.clientId, repair.r2Key)
      .first<Row>();
    const disposition = row?.disposition;
    if (
      disposition !== "missing" &&
      disposition !== "referenced" &&
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
        "SELECT (SELECT COUNT(*) FROM storage_records WHERE user_id = ? AND client_id = ?) + (SELECT COUNT(*) FROM storage_files WHERE user_id = ? AND client_id = ?) AS item_count, (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) FROM storage_records WHERE user_id = ? AND client_id = ?) + (SELECT COALESCE(SUM(size), 0) FROM storage_files WHERE user_id = ? AND client_id = ?) AS byte_count",
      )
      .bind(
        userId,
        clientId,
        userId,
        clientId,
        userId,
        clientId,
        userId,
        clientId,
      )
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
      type: row.type === "confidential" ? "confidential" : "public",
      name: String(row.name),
      disabledAt: nullableNumber(row.disabled_at),
      redirectUris,
      scopes,
      origins,
      createdAt: Number(row.created_at),
    };
  }
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

function mutationChanges(result: D1Result): number {
  if (!result.success || !result.meta || typeof result.meta !== "object")
    return 0;
  const changes = (result.meta as { changes?: unknown }).changes;
  return typeof changes === "number" ? changes : 0;
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

function redact(data: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    redacted[key] =
      /token|secret|code|cookie|authorization|password|credential|access_key/i.test(
        key,
      )
        ? "[REDACTED]"
        : value;
  }
  return redacted;
}
