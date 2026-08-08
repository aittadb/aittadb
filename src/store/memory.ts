import { uuid } from "../crypto";
import { REFRESH_FAMILY_ORPHAN_GRACE_SECONDS } from "./cleanup";
import {
  accountDeletionClaimExpiry,
  assertAccountDeletionNow,
  assertAccountDeletionRetryAt,
} from "./account-deletion";
import {
  BROWSER_SESSION_CLIENT,
  BROWSER_SESSION_CLIENT_ID,
  isBrowserSessionClientId,
} from "../system-client";
import type {
  AccountDeletionJob,
  AccountDeletionJobStartResult,
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

export class MemoryAuthStore implements AuthStore {
  users = new Map<string, LocalUser>();
  usersByEmail = new Map<string, string>();
  clients = new Map<string, ClientView & { secretHash: string | null }>();
  devices = new Map<string, DeviceGrant>();
  devicesByUserCodeHash = new Map<string, string>();
  authRequests = new Map<string, AuthorizationRequest>();
  authCodes = new Map<string, AuthorizationCode>();
  consents = new Set<string>();
  families = new Map<string, RefreshTokenFamily>();
  refreshTokens = new Map<string, RefreshTokenRecord>();
  revokedJtis = new Map<string, number>();
  accountDeletionJobs = new Map<string, AccountDeletionJob>();
  storageRecords = new Map<string, StorageRecord>();
  storageFiles = new Map<string, StorageFileMetadata>();
  storageFileOrphanRepairs = new Map<string, StorageFileOrphanRepair>();
  counters = new Map<string, { count: number; windowStart: number }>();
  adminOperationSubmissions = new Map<
    string,
    {
      userId: string;
      expiresAt: number;
      resultConsumedAt: number | null;
    }
  >();
  audits: Array<{ type: string; data: Record<string, unknown>; now: number }> =
    [];

  constructor() {
    this.clients.set(BROWSER_SESSION_CLIENT_ID, {
      ...BROWSER_SESSION_CLIENT,
      redirectUris: [...BROWSER_SESSION_CLIENT.redirectUris],
      scopes: [...BROWSER_SESSION_CLIENT.scopes],
      origins: [...BROWSER_SESSION_CLIENT.origins],
      secretHash: null,
    });
  }

  async cleanup(now: number): Promise<void> {
    for (const [key, value] of this.revokedJtis) {
      if (value <= now) this.revokedJtis.delete(key);
    }
    for (const [key, code] of this.authCodes) {
      if (code.expiresAt <= now) this.authCodes.delete(key);
    }
    for (const [key, request] of this.authRequests) {
      const hasActiveCode = Array.from(this.authCodes.values()).some(
        (code) => code.authRequestId === request.id && code.expiresAt > now,
      );
      if (request.expiresAt <= now && !hasActiveCode)
        this.authRequests.delete(key);
    }
    for (const [key, grant] of this.devices) {
      if (grant.expiresAt <= now) {
        this.devices.delete(key);
        this.devicesByUserCodeHash.delete(grant.userCodeHash);
      }
    }
    for (const [key, token] of this.refreshTokens) {
      if (token.expiresAt <= now) this.refreshTokens.delete(key);
    }
    for (const [key, family] of this.families) {
      const hasToken = Array.from(this.refreshTokens.values()).some(
        (token) => token.familyId === family.id,
      );
      if (
        family.createdAt <= now - REFRESH_FAMILY_ORPHAN_GRACE_SECONDS &&
        !hasToken
      ) {
        this.families.delete(key);
      }
    }
    for (const [key, counter] of this.counters) {
      if (counter.windowStart <= now - 300) this.counters.delete(key);
    }
    for (const [key, submission] of this.adminOperationSubmissions) {
      if (submission.expiresAt <= now)
        this.adminOperationSubmissions.delete(key);
    }
    this.audits = this.audits.filter(
      (event) => event.now > now - 90 * 24 * 60 * 60,
    );
  }

  async rateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    now: number,
  ): Promise<boolean> {
    const counter = this.counters.get(key);
    if (!counter || counter.windowStart + windowSeconds <= now) {
      if (!counter && this.counters.size >= 10_000) return false;
      this.counters.set(key, { count: 1, windowStart: now });
      return true;
    }
    counter.count += 1;
    return counter.count <= limit;
  }

  async audit(
    type: string,
    data: Record<string, unknown>,
    now: number,
  ): Promise<void> {
    this.audits.push({ type, data: redactAuditData(data), now });
  }

  async findOrCreateUser(
    identity: UpstreamIdentity,
    now: number,
  ): Promise<LocalUser> {
    const existingId = this.usersByEmail.get(identity.email);
    if (existingId) {
      const existing = this.users.get(existingId);
      if (!existing) throw new Error("corrupt_user_index");
      existing.displayName = identity.displayName;
      existing.updatedAt = now;
      return existing;
    }
    const user: LocalUser = {
      id: uuid(),
      email: identity.email,
      displayName: identity.displayName,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    this.usersByEmail.set(user.email, user.id);
    return user;
  }

  async getUser(id: string): Promise<LocalUser | null> {
    return this.users.get(id) ?? null;
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async startAccountDeletionJob(
    subject: string,
    now: number,
  ): Promise<AccountDeletionJobStartResult> {
    assertAccountDeletionNow(now);
    const existing = this.accountDeletionJobs.get(subject);
    if (existing) {
      return { created: false, job: copyAccountDeletionJob(existing) };
    }
    if (!this.users.has(subject)) {
      throw new Error("account_deletion_subject_not_found");
    }
    const job: AccountDeletionJob = {
      subject,
      state: "pending",
      attempt: 0,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.accountDeletionJobs.set(subject, job);
    return { created: true, job: copyAccountDeletionJob(job) };
  }

  async getAccountDeletionJob(
    subject: string,
  ): Promise<AccountDeletionJob | null> {
    const job = this.accountDeletionJobs.get(subject);
    return job ? copyAccountDeletionJob(job) : null;
  }

  async claimAccountDeletionJobs(
    now: number,
    leaseSeconds: number,
    limit: number,
  ): Promise<AccountDeletionJob[]> {
    const leaseExpiresAt = accountDeletionClaimExpiry(now, leaseSeconds, limit);
    const jobs = Array.from(this.accountDeletionJobs.values())
      .filter(
        (job) =>
          job.state !== "completed" &&
          job.availableAt !== null &&
          job.availableAt <= now,
      )
      .sort(
        (left, right) =>
          (left.availableAt ?? 0) - (right.availableAt ?? 0) ||
          left.createdAt - right.createdAt ||
          left.subject.localeCompare(right.subject),
      )
      .slice(0, limit);
    return jobs.map((job) => {
      const claimed: AccountDeletionJob = {
        ...job,
        state: "running",
        attempt: job.attempt + 1,
        availableAt: leaseExpiresAt,
        updatedAt: now,
      };
      this.accountDeletionJobs.set(job.subject, claimed);
      return copyAccountDeletionJob(claimed);
    });
  }

  async retryAccountDeletionJob(
    subject: string,
    attempt: number,
    now: number,
    retryAt: number,
  ): Promise<boolean> {
    assertAccountDeletionRetryAt(now, retryAt);
    const job = this.accountDeletionJobs.get(subject);
    if (
      !job ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      job.state !== "running" ||
      job.attempt !== attempt ||
      job.availableAt === null ||
      job.availableAt <= now
    ) {
      return false;
    }
    this.accountDeletionJobs.set(subject, {
      ...job,
      state: "retryable",
      availableAt: retryAt,
      updatedAt: now,
    });
    return true;
  }

  async completeAccountDeletionJob(
    subject: string,
    attempt: number,
    now: number,
  ): Promise<boolean> {
    assertAccountDeletionNow(now);
    const job = this.accountDeletionJobs.get(subject);
    if (
      !job ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      job.state !== "running" ||
      job.attempt !== attempt ||
      job.availableAt === null ||
      job.availableAt <= now
    ) {
      return false;
    }
    this.accountDeletionJobs.set(subject, {
      ...job,
      state: "completed",
      availableAt: null,
      updatedAt: now,
      completedAt: now,
    });
    return true;
  }

  async createClient(
    input: ClientRegistrationInput,
    secretHash: string | null,
    now: number,
  ): Promise<ClientView> {
    const client: ClientView & { secretHash: string | null } = {
      id: uuid(),
      type: input.type,
      name: input.name,
      disabledAt: null,
      redirectUris: [...input.redirectUris],
      scopes: [...input.scopes],
      origins: [...input.origins],
      createdAt: now,
      secretHash,
    };
    this.clients.set(client.id, client);
    return stripSecret(client);
  }

  async listClients(): Promise<ClientView[]> {
    return Array.from(this.clients.values())
      .filter((client) => !isBrowserSessionClientId(client.id))
      .map(stripSecret);
  }

  async getClient(id: string): Promise<ClientView | null> {
    const client = this.clients.get(id);
    return client ? stripSecret(client) : null;
  }

  async getClientSecretHash(id: string): Promise<string | null> {
    return this.clients.get(id)?.secretHash ?? null;
  }

  async hasActiveClientOrigin(origin: string): Promise<boolean> {
    return Array.from(this.clients.values()).some(
      (client) => !client.disabledAt && client.origins.includes(origin),
    );
  }

  async setClientDisabled(
    id: string,
    disabledAt: number | null,
  ): Promise<void> {
    if (isBrowserSessionClientId(id)) return;
    const client = this.clients.get(id);
    if (client) client.disabledAt = disabledAt;
  }

  async rotateClientSecret(id: string, secretHash: string): Promise<void> {
    if (isBrowserSessionClientId(id)) return;
    const client = this.clients.get(id);
    if (client) client.secretHash = secretHash;
  }

  async revokeClientGrants(clientId: string, now: number): Promise<void> {
    if (isBrowserSessionClientId(clientId)) return;
    for (const family of this.families.values()) {
      if (family.clientId === clientId) {
        family.status = "revoked";
        for (const token of this.refreshTokens.values()) {
          if (token.familyId === family.id) token.revokedAt = now;
        }
      }
    }
  }

  async claimAdminOperationSubmission(
    tokenHash: string,
    userId: string,
    _now: number,
    expiresAt: number,
  ): Promise<boolean> {
    if (this.adminOperationSubmissions.has(tokenHash)) return false;
    this.adminOperationSubmissions.set(tokenHash, {
      userId,
      expiresAt,
      resultConsumedAt: null,
    });
    return true;
  }

  async consumeAdminOperationResult(
    tokenHash: string,
    userId: string,
    now: number,
  ): Promise<boolean> {
    const submission = this.adminOperationSubmissions.get(tokenHash);
    if (
      !submission ||
      submission.userId !== userId ||
      submission.expiresAt <= now ||
      submission.resultConsumedAt !== null
    ) {
      return false;
    }
    submission.resultConsumedAt = now;
    return true;
  }

  async createDeviceGrant(grant: DeviceGrant): Promise<void> {
    this.devices.set(grant.deviceCodeHash, { ...grant });
    this.devicesByUserCodeHash.set(grant.userCodeHash, grant.deviceCodeHash);
  }

  async getDeviceGrantByDeviceHash(hash: string): Promise<DeviceGrant | null> {
    const grant = this.devices.get(hash);
    return grant ? { ...grant } : null;
  }

  async getDeviceGrantByUserCodeHash(
    hash: string,
  ): Promise<DeviceGrant | null> {
    const deviceHash = this.devicesByUserCodeHash.get(hash);
    const grant = deviceHash ? this.devices.get(deviceHash) : null;
    return grant ? { ...grant } : null;
  }

  async updateDeviceGrant(grant: DeviceGrant): Promise<void> {
    const stored = this.devices.get(grant.deviceCodeHash);
    if (!stored) return;
    this.devices.set(grant.deviceCodeHash, {
      ...stored,
      lastPollAt: grant.lastPollAt,
      slowDownCount: grant.slowDownCount,
    });
  }

  async transitionDeviceGrant(
    userCodeHash: string,
    status: "approved" | "denied",
    userId: string | null,
    now: number,
  ): Promise<DeviceGrant | null> {
    const deviceHash = this.devicesByUserCodeHash.get(userCodeHash);
    const grant = deviceHash ? this.devices.get(deviceHash) : null;
    if (!grant || grant.status !== "pending" || grant.expiresAt <= now)
      return null;
    const updated = { ...grant, status, userId };
    this.devices.set(updated.deviceCodeHash, updated);
    return { ...updated };
  }

  async consumeDeviceGrant(
    deviceCodeHash: string,
    clientId: string,
    now: number,
  ): Promise<DeviceGrant | null> {
    const grant = this.devices.get(deviceCodeHash);
    if (
      !grant ||
      grant.clientId !== clientId ||
      grant.status !== "approved" ||
      !grant.userId ||
      grant.expiresAt <= now
    )
      return null;
    const consumed = { ...grant, status: "used" as const };
    this.devices.set(deviceCodeHash, consumed);
    return { ...consumed };
  }

  async createAuthorizationRequest(
    request: AuthorizationRequest,
  ): Promise<void> {
    this.authRequests.set(request.id, { ...request });
  }

  async getAuthorizationRequest(
    id: string,
  ): Promise<AuthorizationRequest | null> {
    const request = this.authRequests.get(id);
    return request ? { ...request } : null;
  }

  async transitionAuthorizationRequest(
    id: string,
    status: "approved" | "denied",
    userId: string | null,
    now: number,
  ): Promise<boolean> {
    const request = this.authRequests.get(id);
    if (!request || request.status !== "pending" || request.expiresAt <= now)
      return false;
    this.authRequests.set(id, { ...request, status, userId });
    return true;
  }

  async createAuthorizationCode(code: AuthorizationCode): Promise<void> {
    this.authCodes.set(code.codeHash, { ...code });
  }

  async consumeAuthorizationCode(
    hash: string,
    clientId: string,
    redirectUri: string,
    now: number,
  ): Promise<AuthorizationCode | null> {
    const code = this.authCodes.get(hash);
    if (
      !code ||
      code.clientId !== clientId ||
      code.redirectUri !== redirectUri ||
      code.consumedAt ||
      code.expiresAt <= now
    )
      return null;
    code.consumedAt = now;
    return { ...code };
  }

  async hasConsent(
    userId: string,
    clientId: string,
    scope: string,
  ): Promise<boolean> {
    return this.consents.has(`${userId}:${clientId}:${scope}`);
  }

  async saveConsent(
    userId: string,
    clientId: string,
    scope: string,
  ): Promise<void> {
    this.consents.add(`${userId}:${clientId}:${scope}`);
  }

  async createRefreshFamily(family: RefreshTokenFamily): Promise<void> {
    this.families.set(family.id, { ...family });
  }

  async createRefreshToken(token: RefreshTokenRecord): Promise<void> {
    this.refreshTokens.set(token.tokenHash, { ...token });
  }

  async consumeRefreshToken(
    hash: string,
    clientId: string,
    now: number,
  ): Promise<RefreshTokenRecord | null> {
    const token = this.refreshTokens.get(hash);
    if (
      !token ||
      token.clientId !== clientId ||
      token.expiresAt <= now ||
      token.revokedAt
    )
      return null;
    const family = this.families.get(token.familyId);
    if (!family || family.status !== "active") return null;
    if (token.usedAt) {
      family.status = "revoked";
      for (const other of this.refreshTokens.values()) {
        if (other.familyId === family.id) other.revokedAt = now;
      }
      return null;
    }
    token.usedAt = now;
    return { ...token };
  }

  async revokeRefreshFamily(familyId: string, now: number): Promise<void> {
    const family = this.families.get(familyId);
    if (family) family.status = "revoked";
    for (const token of this.refreshTokens.values()) {
      if (token.familyId === familyId) token.revokedAt = now;
    }
  }

  async revokeRefreshToken(
    hash: string,
    clientId: string,
    now: number,
  ): Promise<boolean> {
    const token = this.refreshTokens.get(hash);
    if (!token || token.clientId !== clientId) return false;
    await this.revokeRefreshFamily(token.familyId, now);
    return true;
  }

  async revokeAccessTokenJti(jti: string, expiresAt: number): Promise<void> {
    this.revokedJtis.set(jti, expiresAt);
  }

  async isAccessTokenJtiRevoked(jti: string): Promise<boolean> {
    return this.revokedJtis.has(jti);
  }

  async listStorageRecords(
    userId: string,
    clientId: string,
    after: StorageListPosition | null,
    limit: number,
  ): Promise<StorageListPage<StorageRecord>> {
    const items = Array.from(this.storageRecords.values())
      .filter(
        (record) =>
          record.userId === userId &&
          record.clientId === clientId &&
          isAfterPosition(record, after),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  }

  async getStorageRecord(
    userId: string,
    clientId: string,
    key: string,
  ): Promise<StorageRecord | null> {
    return this.storageRecords.get(storageKey(userId, clientId, key)) ?? null;
  }

  async upsertStorageRecord(
    record: StorageRecord,
    limits: StorageLimits,
  ): Promise<boolean> {
    const key = storageKey(record.userId, record.clientId, record.key);
    const existing = this.storageRecords.get(key);
    const nextBytes = utf8Bytes(record.valueJson);
    const previousBytes = existing ? utf8Bytes(existing.valueJson) : 0;
    if (
      !fitsStorageLimits(
        this,
        record.userId,
        record.clientId,
        existing ? 0 : 1,
        nextBytes - previousBytes,
        limits,
      )
    ) {
      return false;
    }
    this.storageRecords.set(key, {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt,
    });
    return true;
  }

  async deleteStorageRecord(
    userId: string,
    clientId: string,
    key: string,
  ): Promise<void> {
    this.storageRecords.delete(storageKey(userId, clientId, key));
  }

  async listStorageFiles(
    userId: string,
    clientId: string,
    after: StorageListPosition | null,
    limit: number,
  ): Promise<StorageListPage<StorageFileMetadata>> {
    const items = Array.from(this.storageFiles.values())
      .filter(
        (file) =>
          file.userId === userId &&
          file.clientId === clientId &&
          isAfterPosition(file, after),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  }

  async getStorageFileMetadata(
    userId: string,
    clientId: string,
    key: string,
  ): Promise<StorageFileMetadata | null> {
    return this.storageFiles.get(storageKey(userId, clientId, key)) ?? null;
  }

  async upsertStorageFileMetadata(
    file: StorageFileMetadata,
    expectedR2Key: string | null,
    limits?: StorageLimits,
  ): Promise<boolean> {
    if (this.storageFileOrphanRepairs.has(file.r2Key)) return false;
    const key = storageKey(file.userId, file.clientId, file.key);
    const existing = this.storageFiles.get(key);
    if (
      (expectedR2Key === null && existing) ||
      (expectedR2Key !== null && existing?.r2Key !== expectedR2Key)
    ) {
      return false;
    }
    if (
      limits &&
      !fitsStorageLimits(
        this,
        file.userId,
        file.clientId,
        existing ? 0 : 1,
        file.size - (existing?.size ?? 0),
        limits,
      )
    ) {
      return false;
    }
    this.storageFiles.set(key, {
      ...file,
      createdAt: existing?.createdAt ?? file.createdAt,
    });
    return true;
  }

  async deleteStorageFileMetadata(
    userId: string,
    clientId: string,
    key: string,
    expectedR2Key: string,
  ): Promise<boolean> {
    const storageFileKey = storageKey(userId, clientId, key);
    if (this.storageFiles.get(storageFileKey)?.r2Key !== expectedR2Key) {
      return false;
    }
    return this.storageFiles.delete(storageFileKey);
  }

  async recordStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
  ): Promise<boolean> {
    const existing = this.storageFileOrphanRepairs.get(repair.r2Key);
    if (
      existing &&
      (existing.userId !== repair.userId ||
        existing.clientId !== repair.clientId)
    ) {
      return false;
    }
    this.storageFileOrphanRepairs.set(repair.r2Key, {
      ...repair,
      createdAt: existing?.createdAt ?? repair.createdAt,
      updatedAt: Math.max(existing?.updatedAt ?? 0, repair.updatedAt),
    });
    return true;
  }

  async listStorageFileOrphanRepairs(
    limit: number,
  ): Promise<StorageFileOrphanRepair[]> {
    return Array.from(this.storageFileOrphanRepairs.values())
      .sort(
        (a, b) =>
          a.updatedAt - b.updatedAt ||
          a.createdAt - b.createdAt ||
          a.r2Key.localeCompare(b.r2Key),
      )
      .slice(0, limit);
  }

  async classifyStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
  ): Promise<StorageFileOrphanRepairDisposition> {
    const current = this.storageFileOrphanRepairs.get(repair.r2Key);
    if (!sameStorageFileOrphanRepairOwner(current, repair)) return "missing";
    const referenced = Array.from(this.storageFiles.values()).some(
      (file) => file.r2Key === repair.r2Key,
    );
    return referenced ? "referenced" : "orphan";
  }

  async completeStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
  ): Promise<boolean> {
    const current = this.storageFileOrphanRepairs.get(repair.r2Key);
    if (!sameStorageFileOrphanRepairOwner(current, repair)) return false;
    return this.storageFileOrphanRepairs.delete(repair.r2Key);
  }

  async deferStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
    now: number,
  ): Promise<boolean> {
    const current = this.storageFileOrphanRepairs.get(repair.r2Key);
    if (!sameStorageFileOrphanRepairOwner(current, repair)) return false;
    this.storageFileOrphanRepairs.set(repair.r2Key, {
      ...current,
      updatedAt: Math.max(current.updatedAt, now),
    });
    return true;
  }

  async getStorageUsage(
    userId: string,
    clientId: string,
  ): Promise<StorageUsage> {
    return usageFor(this, userId, clientId);
  }
}

function stripSecret(
  client: ClientView & { secretHash?: string | null },
): ClientView {
  return {
    id: client.id,
    type: client.type,
    name: client.name,
    disabledAt: client.disabledAt,
    redirectUris: [...client.redirectUris],
    scopes: [...client.scopes],
    origins: [...client.origins],
    createdAt: client.createdAt,
  };
}

function copyAccountDeletionJob(job: AccountDeletionJob): AccountDeletionJob {
  return { ...job };
}

function sameStorageFileOrphanRepairOwner(
  current: StorageFileOrphanRepair | undefined,
  expected: StorageFileOrphanRepair,
): current is StorageFileOrphanRepair {
  return (
    current !== undefined &&
    current.userId === expected.userId &&
    current.clientId === expected.clientId
  );
}

function storageKey(userId: string, clientId: string, key: string): string {
  return `${userId}:${clientId}:${key}`;
}

function isAfterPosition(
  item: { updatedAt: number; key: string },
  after: StorageListPosition | null,
): boolean {
  return (
    !after ||
    item.updatedAt < after.updatedAt ||
    (item.updatedAt === after.updatedAt && item.key > after.key)
  );
}

function usageFor(
  store: MemoryAuthStore,
  userId?: string,
  clientId?: string,
): StorageUsage {
  let itemCount = 0;
  let byteCount = 0;
  for (const record of store.storageRecords.values()) {
    if (userId && record.userId !== userId) continue;
    if (clientId && record.clientId !== clientId) continue;
    itemCount += 1;
    byteCount += utf8Bytes(record.valueJson);
  }
  for (const file of store.storageFiles.values()) {
    if (userId && file.userId !== userId) continue;
    if (clientId && file.clientId !== clientId) continue;
    itemCount += 1;
    byteCount += file.size;
  }
  return { itemCount, byteCount };
}

function fitsStorageLimits(
  store: MemoryAuthStore,
  userId: string,
  clientId: string,
  itemDelta: number,
  byteDelta: number,
  limits: StorageLimits,
): boolean {
  const global = usageFor(store);
  const user = usageFor(store, userId);
  const namespace = usageFor(store, userId, clientId);
  return (
    global.itemCount + itemDelta <= limits.globalMaxItems &&
    global.byteCount + byteDelta <= limits.globalMaxBytes &&
    user.itemCount + itemDelta <= limits.userMaxItems &&
    user.byteCount + byteDelta <= limits.userMaxBytes &&
    namespace.itemCount + itemDelta <= limits.namespaceMaxItems &&
    namespace.byteCount + byteDelta <= limits.namespaceMaxBytes
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function redactAuditData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      /token|secret|code|cookie|authorization|password|credential|access_key/i.test(
        key,
      )
        ? "[REDACTED]"
        : value,
    ]),
  );
}
