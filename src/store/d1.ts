import { uuid } from "../crypto";
import {
  BROWSER_SESSION_CLIENT_ID,
  isBrowserSessionClientId,
} from "../system-client";
import type {
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
  StorageRecord,
  UpstreamIdentity,
} from "../types";

type Row = Record<string, unknown>;

export class D1AuthStore implements AuthStore {
  constructor(private readonly db: D1Database) {}

  async cleanup(now: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM revoked_access_tokens WHERE expires_at <= ?")
      .bind(now)
      .run();
    await this.db
      .prepare("DELETE FROM rate_limit_counters WHERE window_start <= ?")
      .bind(now - 86400)
      .run();
  }

  async rateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    now: number,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT count, window_start FROM rate_limit_counters WHERE key = ?",
      )
      .bind(key)
      .first<Row>();
    if (!row || Number(row.window_start) + windowSeconds <= now) {
      await this.db
        .prepare(
          "INSERT INTO rate_limit_counters (key, count, window_start) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start",
        )
        .bind(key, 1, now)
        .run();
      return true;
    }
    const next = Number(row.count) + 1;
    await this.db
      .prepare("UPDATE rate_limit_counters SET count = ? WHERE key = ?")
      .bind(next, key)
      .run();
    return next <= limit;
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
    expiresAt: number,
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO revoked_access_tokens (jti, expires_at, revoked_at) VALUES (?, ?, ?) ON CONFLICT(jti) DO UPDATE SET expires_at = excluded.expires_at, revoked_at = excluded.revoked_at",
      )
      .bind(jti, expiresAt, now)
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
  ): Promise<StorageRecord[]> {
    const rows = await this.db
      .prepare(
        "SELECT * FROM storage_records WHERE user_id = ? AND client_id = ? ORDER BY updated_at DESC, key ASC",
      )
      .bind(userId, clientId)
      .all<Row>();
    return (rows.results ?? []).map(rowToStorageRecord);
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

  async upsertStorageRecord(record: StorageRecord): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO storage_records (user_id, client_id, key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, client_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
      )
      .bind(
        record.userId,
        record.clientId,
        record.key,
        record.valueJson,
        record.createdAt,
        record.updatedAt,
      )
      .run();
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
  ): Promise<StorageFileMetadata[]> {
    const rows = await this.db
      .prepare(
        "SELECT * FROM storage_files WHERE user_id = ? AND client_id = ? ORDER BY updated_at DESC, key ASC",
      )
      .bind(userId, clientId)
      .all<Row>();
    return (rows.results ?? []).map(rowToStorageFile);
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

  async upsertStorageFileMetadata(file: StorageFileMetadata): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO storage_files (user_id, client_id, key, r2_key, content_type, size, sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, client_id, key) DO UPDATE SET r2_key = excluded.r2_key, content_type = excluded.content_type, size = excluded.size, sha256 = excluded.sha256, updated_at = excluded.updated_at",
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
      )
      .run();
  }

  async deleteStorageFileMetadata(
    userId: string,
    clientId: string,
    key: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM storage_files WHERE user_id = ? AND client_id = ? AND key = ?",
      )
      .bind(userId, clientId, key)
      .run();
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

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function mutationChanges(result: D1Result): number {
  if (!result.success || !result.meta || typeof result.meta !== "object")
    return 0;
  const changes = (result.meta as { changes?: unknown }).changes;
  return typeof changes === "number" ? changes : 0;
}

function redact(data: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    redacted[key] = /token|secret|code|cookie|authorization/i.test(key)
      ? "[REDACTED]"
      : value;
  }
  return redacted;
}
