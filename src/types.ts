import type { CleanupReport } from "./store/cleanup";
import type {
  BoundedRecord,
  BoundedRecordTransactionCommand,
} from "./bounded-record-protocol";

export type OAuthScope =
  | "openid"
  | "email"
  | "profile"
  | "offline_access"
  | "storage.read"
  | "storage.write"
  | "storage.delete"
  | "events.publish"
  | "events.read"
  | "events.subscribe";

export const SUPPORTED_SCOPES: readonly OAuthScope[] = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "storage.read",
  "storage.write",
  "storage.delete",
  "events.publish",
  "events.read",
  "events.subscribe",
];

export type ClientType = "public" | "confidential" | "service";

export type DeviceGrantStatus = "pending" | "approved" | "denied" | "used";

export type TokenFamilyStatus = "active" | "revoked";

export interface RuntimeEnv {
  DB?: D1Database;
  BUCKET?: R2Bucket;
  ISSUER_URL?: string;
  JWT_PRIVATE_JWK?: string;
  JWT_KEY_ID?: string;
  ACCESS_TOKEN_TTL_SECONDS?: string;
  AUTH_CODE_TTL_SECONDS?: string;
  DEVICE_CODE_TTL_SECONDS?: string;
  DEVICE_POLL_INTERVAL_SECONDS?: string;
  REFRESH_TOKEN_TTL_SECONDS?: string;
  ALLOWED_CORS_ORIGINS?: string;
  FEATURE_RECORDS_ENABLED?: string;
  FEATURE_FILES_ENABLED?: string;
  FEATURE_STATISTICS_ENABLED?: string;
  FEATURE_OAUTH_APPS_ENABLED?: string;
  FEATURE_EVENTS_ENABLED?: string;
  EVENT_RETENTION_SECONDS?: string;
  EVENTS_GLOBAL_MAX_ITEMS?: string;
  EVENTS_GLOBAL_MAX_BYTES?: string;
  EVENTS_USER_MAX_ITEMS?: string;
  EVENTS_USER_MAX_BYTES?: string;
  EVENTS_NAMESPACE_MAX_ITEMS?: string;
  EVENTS_NAMESPACE_MAX_BYTES?: string;
  EVENTS_DEFAULT_PAGE_SIZE?: string;
  EVENTS_MAX_PAGE_SIZE?: string;
  EVENTS_READ_RATE_LIMIT?: string;
  EVENTS_PUBLISH_RATE_LIMIT?: string;
  EVENTS_SUBSCRIBE_RATE_LIMIT?: string;
  EVENTS_MAX_WAIT_SECONDS?: string;
  EVENTS_MAX_WAIT_READS?: string;
  MAINTENANCE_CLEANUP_TELEMETRY_ENABLED?: string;
  STORAGE_WRITES_ENABLED?: string;
  STORAGE_GLOBAL_MAX_ITEMS?: string;
  STORAGE_GLOBAL_MAX_BYTES?: string;
  STORAGE_USER_MAX_ITEMS?: string;
  STORAGE_USER_MAX_BYTES?: string;
  STORAGE_NAMESPACE_MAX_ITEMS?: string;
  STORAGE_NAMESPACE_MAX_BYTES?: string;
  STORAGE_DEFAULT_PAGE_SIZE?: string;
  STORAGE_MAX_PAGE_SIZE?: string;
  STORAGE_READ_RATE_LIMIT?: string;
  STORAGE_WRITE_RATE_LIMIT?: string;
  BOUNDED_RECORD_RECEIPT_RETENTION_SECONDS?: string;
  ADMIN_SUBJECTS?: string;
  PRIVACY_CONTROLLER_NAME?: string;
  PRIVACY_CONTROLLER_IDENTIFIER?: string;
  PRIVACY_CONTACT_NAME?: string;
  PRIVACY_CONTACT_EMAIL?: string;
  PRIVACY_CONTACT_PHONE?: string;
  PRIVACY_CONTACT_ADDRESS?: string;
  NODE_ENV?: string;
}

export interface PrivacyConfig {
  controllerName: string | null;
  controllerIdentifier: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactAddress: string | null;
  valid: boolean;
}

export interface StorageLimits {
  writesEnabled: boolean;
  globalMaxItems: number;
  globalMaxBytes: number;
  userMaxItems: number;
  userMaxBytes: number;
  namespaceMaxItems: number;
  namespaceMaxBytes: number;
}

export interface BoundedStorageTransactionOptions {
  receiptRetentionSeconds: number;
}

export interface ApplicationEventLimits {
  globalMaxItems: number;
  globalMaxBytes: number;
  userMaxItems: number;
  userMaxBytes: number;
  namespaceMaxItems: number;
  namespaceMaxBytes: number;
}

export interface FeatureAvailability {
  records: boolean;
  files: boolean;
  statistics: boolean;
  oauthApps: boolean;
  events: boolean;
}

export interface AppConfig {
  issuerUrl: string;
  jwtPrivateJwk: JsonWebKey;
  jwtKeyId: string;
  accessTokenTtlSeconds: number;
  authCodeTtlSeconds: number;
  deviceCodeTtlSeconds: number;
  devicePollIntervalSeconds: number;
  refreshTokenTtlSeconds: number;
  allowedCorsOrigins: readonly string[];
  features: FeatureAvailability;
  eventRetentionSeconds: number;
  maintenanceCleanupTelemetryEnabled: boolean;
  eventLimits: ApplicationEventLimits;
  eventDefaultPageSize: number;
  eventMaxPageSize: number;
  eventReadRateLimit: number;
  eventPublishRateLimit: number;
  eventSubscribeRateLimit: number;
  eventMaxWaitSeconds: number;
  eventMaxWaitReads: number;
  storageLimits: StorageLimits;
  storageDefaultPageSize: number;
  storageMaxPageSize: number;
  storageReadRateLimit: number;
  storageWriteRateLimit: number;
  boundedRecordReceiptRetentionSeconds: number;
  adminSubjects: readonly string[];
  privacy: PrivacyConfig;
  isTest: boolean;
  isProduction: boolean;
}

export interface UpstreamIdentity {
  email: string;
  fullName: string | null;
  displayName: string;
}

export interface LocalUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
}

export interface OAuthClient {
  id: string;
  type: ClientType;
  name: string;
  secretHash: string | null;
  disabledAt: number | null;
  createdAt: number;
}

export interface ClientRegistrationInput {
  type: ClientType;
  name: string;
  redirectUris: readonly string[];
  scopes: readonly string[];
  origins: readonly string[];
}

export interface ClientView {
  id: string;
  type: ClientType;
  name: string;
  disabledAt: number | null;
  redirectUris: readonly string[];
  scopes: readonly string[];
  origins: readonly string[];
  createdAt: number;
}

export interface AuthorizationRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string | null;
  nonce: string | null;
  codeChallenge: string;
  createdAt: number;
  expiresAt: number;
  userId: string | null;
  status: "pending" | "approved" | "denied";
}

export interface AuthorizationCode {
  codeHash: string;
  authRequestId: string;
  clientId: string;
  redirectUri: string;
  userId: string;
  scope: string;
  nonce: string | null;
  expiresAt: number;
  consumedAt: number | null;
}

export interface DeviceGrant {
  id: string;
  deviceCodeHash: string;
  userCodeHash: string;
  userCodeDisplay: string;
  clientId: string;
  scope: string;
  status: DeviceGrantStatus;
  userId: string | null;
  createdAt: number;
  expiresAt: number;
  intervalSeconds: number;
  lastPollAt: number | null;
  slowDownCount: number;
}

export interface RefreshTokenFamily {
  id: string;
  userId: string;
  clientId: string;
  status: TokenFamilyStatus;
  createdAt: number;
}

export interface RefreshTokenRecord {
  id: string;
  familyId: string;
  tokenHash: string;
  userId: string;
  clientId: string;
  scope: string;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

export interface StorageRecord {
  userId: string;
  clientId: string;
  key: string;
  valueJson: string;
  createdAt: number;
  updatedAt: number;
}

/** Internal persistence model for the versioned bounded-record protocol. */
export interface BoundedStorageRecord {
  userId: string;
  clientId: string;
  collection: string;
  id: string;
  valueJson: string;
  valueBytes: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface BoundedStorageRecordPage {
  items: BoundedStorageRecord[];
  hasMore: boolean;
}

export type BoundedStorageTransactionResult =
  | Readonly<{
      status: "created" | "replayed";
      records: readonly (Readonly<BoundedRecord> | null)[];
    }>
  | Readonly<{
      status:
        | "conflict"
        | "precondition_failed"
        | "quota_exceeded"
        | "unavailable";
    }>;

export interface StorageFileMetadata {
  userId: string;
  clientId: string;
  key: string;
  r2Key: string;
  contentType: string;
  size: number;
  sha256: string;
  createdAt: number;
  updatedAt: number;
}

export interface StorageFileOrphanRepair {
  userId: string;
  clientId: string;
  r2Key: string;
  createdAt: number;
  updatedAt: number;
}

export interface StorageFileWriteFence {
  userId: string;
  clientId: string;
  r2Key: string;
  createdAt: number;
  expiresAt: number;
}

export type StorageFileOrphanRepairDisposition =
  | "missing"
  | "referenced"
  | "conflict"
  | "orphan";

export interface StorageListPosition {
  updatedAt: number;
  key: string;
}

export interface StorageListPage<T> {
  items: T[];
  hasMore: boolean;
}

export interface StorageUsage {
  itemCount: number;
  byteCount: number;
}

export interface ApplicationEventInput {
  id: string;
  userId: string;
  clientId: string;
  type: string;
  dataJson: string;
  dataBytes: number;
  idempotencyKeyHash: string | null;
  requestHash: string;
  createdAt: number;
  expiresAt: number;
}

export interface ApplicationEvent extends ApplicationEventInput {
  /** Internal ordering value. Public representations expose it only through encrypted cursors. */
  sequence: number;
}

export interface ApplicationEventPage {
  items: ApplicationEvent[];
  hasMore: boolean;
}

export interface ApplicationEventPageRepository {
  listApplicationEvents(
    userId: string,
    clientId: string,
    afterSequence: number | null,
    limit: number,
    eventType?: string | null,
  ): Promise<ApplicationEventPage>;
}

export interface ApplicationEventLookupRepository {
  getApplicationEvent(
    userId: string,
    clientId: string,
    id: string,
  ): Promise<ApplicationEvent | null>;
}

export type ApplicationEventAppendResult =
  | { status: "created" | "replayed"; event: ApplicationEvent }
  | { status: "conflict" | "quota_exceeded" | "unavailable" };

export interface ApplicationEventAppendRepository {
  appendApplicationEvent(
    input: ApplicationEventInput,
    limits: ApplicationEventLimits,
  ): Promise<ApplicationEventAppendResult>;
}

export interface AccountFilePurgeStageResult {
  selected: number;
  staged: number;
}

export type AccountDeletionJobState =
  | "pending"
  | "running"
  | "retryable"
  | "completed";

/** Internal repository state. It is never an HTTP representation. */
export interface AccountDeletionJob {
  subject: string;
  state: AccountDeletionJobState;
  attempt: number;
  availableAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface AccountDeletionJobStartResult {
  created: boolean;
  job: AccountDeletionJob;
}

/** Internal bounded progress; it is never an HTTP representation. */
export interface AccountCredentialPurgeBatchResult {
  deletedCount: number;
  done: boolean;
}

export interface AccountRecordPurgeBatch {
  deletedCount: number;
  done: boolean;
}

export interface AccountEventPurgeBatch {
  deletedCount: number;
  done: boolean;
}

export interface AccountCredentialPurgeRepository {
  purgeAccountCredentialsAndGrants(
    subject: string,
    limit: number,
  ): Promise<AccountCredentialPurgeBatchResult>;
}

export interface AccountRecordPurgeRepository {
  purgeAccountRecords(
    subject: string,
    limit: number,
  ): Promise<AccountRecordPurgeBatch>;
}

export interface AccountEventPurgeRepository {
  purgeAccountEvents(
    subject: string,
    attempt: number,
    now: number,
    limit: number,
  ): Promise<AccountEventPurgeBatch>;
}

export interface AccountDeletionFinalizationRepository {
  finalizeAccountDeletion(
    subject: string,
    attempt: number,
    now: number,
  ): Promise<boolean>;
}

export interface AuditEventAttribution {
  /** Unpadded SHA-256 digest in canonical 43-character base64url form. */
  actorSubjectHash: string;
}

export interface AuthStore
  extends
    AccountCredentialPurgeRepository,
    AccountRecordPurgeRepository,
    AccountEventPurgeRepository,
    AccountDeletionFinalizationRepository,
    ApplicationEventPageRepository,
    ApplicationEventLookupRepository,
    ApplicationEventAppendRepository {
  cleanup(now: number): Promise<CleanupReport>;
  rateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    now: number,
  ): Promise<boolean>;
  audit(
    type: string,
    data: Record<string, unknown>,
    now: number,
    attribution?: AuditEventAttribution,
  ): Promise<void>;

  /** Atomically resolves one exact email mapping; repeats preserve identity and creation metadata. */
  findOrCreateUser(identity: UpstreamIdentity, now: number): Promise<LocalUser>;
  getUserByEmail(email: string): Promise<LocalUser | null>;
  getUser(id: string): Promise<LocalUser | null>;
  countUsers(): Promise<number>;

  startAccountDeletionJob(
    subject: string,
    now: number,
  ): Promise<AccountDeletionJobStartResult>;
  getAccountDeletionJob(subject: string): Promise<AccountDeletionJob | null>;
  claimAccountDeletionJobs(
    now: number,
    leaseSeconds: number,
    limit: number,
  ): Promise<AccountDeletionJob[]>;
  retryAccountDeletionJob(
    subject: string,
    attempt: number,
    now: number,
    retryAt: number,
  ): Promise<boolean>;
  stageAccountFilePurgeBatch(
    subject: string,
    attempt: number,
    now: number,
    limit: number,
  ): Promise<AccountFilePurgeStageResult>;
  stageExpiredAccountFileWriteFences(
    subject: string,
    attempt: number,
    now: number,
    limit: number,
  ): Promise<number>;
  hasStorageFilesForSubject(subject: string): Promise<boolean>;

  createClient(
    input: ClientRegistrationInput,
    secretHash: string | null,
    now: number,
  ): Promise<ClientView>;
  listClients(): Promise<ClientView[]>;
  getClient(id: string): Promise<ClientView | null>;
  getClientSecretHash(id: string): Promise<string | null>;
  hasServicePrincipal(id: string): Promise<boolean>;
  hasActiveClientOrigin(origin: string): Promise<boolean>;
  setClientDisabled(id: string, disabledAt: number | null): Promise<void>;
  rotateClientSecret(
    id: string,
    secretHash: string,
    now: number,
  ): Promise<void>;
  revokeClientGrants(clientId: string, now: number): Promise<void>;
  claimAdminOperationSubmission(
    tokenHash: string,
    userId: string,
    now: number,
    expiresAt: number,
  ): Promise<boolean>;
  consumeAdminOperationResult(
    tokenHash: string,
    userId: string,
    now: number,
  ): Promise<boolean>;

  createDeviceGrant(grant: DeviceGrant): Promise<void>;
  getDeviceGrantByDeviceHash(hash: string): Promise<DeviceGrant | null>;
  getDeviceGrantByUserCodeHash(hash: string): Promise<DeviceGrant | null>;
  updateDeviceGrant(grant: DeviceGrant): Promise<void>;
  transitionDeviceGrant(
    userCodeHash: string,
    status: "approved" | "denied",
    userId: string | null,
    now: number,
  ): Promise<DeviceGrant | null>;
  consumeDeviceGrant(
    deviceCodeHash: string,
    clientId: string,
    now: number,
  ): Promise<DeviceGrant | null>;

  createAuthorizationRequest(request: AuthorizationRequest): Promise<void>;
  getAuthorizationRequest(id: string): Promise<AuthorizationRequest | null>;
  transitionAuthorizationRequest(
    id: string,
    status: "approved" | "denied",
    userId: string | null,
    now: number,
  ): Promise<boolean>;
  createAuthorizationCode(code: AuthorizationCode): Promise<void>;
  consumeAuthorizationCode(
    hash: string,
    clientId: string,
    redirectUri: string,
    now: number,
  ): Promise<AuthorizationCode | null>;

  hasConsent(userId: string, clientId: string, scope: string): Promise<boolean>;
  saveConsent(
    userId: string,
    clientId: string,
    scope: string,
    now: number,
  ): Promise<void>;

  createRefreshFamily(family: RefreshTokenFamily): Promise<void>;
  createRefreshToken(token: RefreshTokenRecord): Promise<void>;
  consumeRefreshToken(
    hash: string,
    clientId: string,
    now: number,
  ): Promise<RefreshTokenRecord | null>;
  revokeRefreshFamily(familyId: string, now: number): Promise<void>;
  revokeRefreshToken(
    hash: string,
    clientId: string,
    now: number,
  ): Promise<boolean>;

  revokeAccessTokenJti(
    jti: string,
    subject: string,
    expiresAt: number,
    now: number,
  ): Promise<void>;
  isAccessTokenJtiRevoked(jti: string): Promise<boolean>;

  listStorageRecords(
    userId: string,
    clientId: string,
    after: StorageListPosition | null,
    limit: number,
  ): Promise<StorageListPage<StorageRecord>>;
  getStorageRecord(
    userId: string,
    clientId: string,
    key: string,
  ): Promise<StorageRecord | null>;
  upsertStorageRecord(
    record: StorageRecord,
    limits: StorageLimits,
  ): Promise<boolean>;
  deleteStorageRecord(
    userId: string,
    clientId: string,
    key: string,
  ): Promise<void>;
  getBoundedStorageRecord(
    userId: string,
    clientId: string,
    collection: string,
    id: string,
  ): Promise<BoundedStorageRecord | null>;
  listBoundedStorageRecords(
    userId: string,
    clientId: string,
    collection: string,
    afterId: string | null,
    limit: number,
  ): Promise<BoundedStorageRecordPage>;
  transactBoundedStorageRecords(
    userId: string,
    clientId: string,
    command: Readonly<BoundedRecordTransactionCommand>,
    limits: Readonly<StorageLimits>,
    now: number,
    options?: Readonly<BoundedStorageTransactionOptions>,
  ): Promise<BoundedStorageTransactionResult>;

  listStorageFiles(
    userId: string,
    clientId: string,
    after: StorageListPosition | null,
    limit: number,
  ): Promise<StorageListPage<StorageFileMetadata>>;
  getStorageFileMetadata(
    userId: string,
    clientId: string,
    key: string,
  ): Promise<StorageFileMetadata | null>;
  upsertStorageFileMetadata(
    file: StorageFileMetadata,
    expectedR2Key: string | null,
    limits?: StorageLimits,
  ): Promise<boolean>;
  deleteStorageFileMetadata(
    userId: string,
    clientId: string,
    key: string,
    expectedR2Key: string,
  ): Promise<boolean>;
  recordStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
  ): Promise<boolean>;
  reserveStorageFileWriteFence(fence: StorageFileWriteFence): Promise<boolean>;
  completeStorageFileWriteFence(fence: StorageFileWriteFence): Promise<boolean>;
  convertStorageFileWriteFenceToRepair(
    fence: StorageFileWriteFence,
    now: number,
  ): Promise<boolean>;
  listStorageFileOrphanRepairs(
    limit: number,
  ): Promise<StorageFileOrphanRepair[]>;
  listStorageFileOrphanRepairsForSubject(
    subject: string,
    limit: number,
  ): Promise<StorageFileOrphanRepair[]>;
  hasStorageFileOrphanRepairsForSubject(subject: string): Promise<boolean>;
  classifyStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
  ): Promise<StorageFileOrphanRepairDisposition>;
  completeStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
  ): Promise<boolean>;
  deferStorageFileOrphanRepair(
    repair: StorageFileOrphanRepair,
    now: number,
  ): Promise<boolean>;
  getStorageUsage(userId: string, clientId: string): Promise<StorageUsage>;
}
