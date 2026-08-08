export type OAuthScope =
  | "openid"
  | "email"
  | "profile"
  | "offline_access"
  | "storage.read"
  | "storage.write"
  | "storage.delete";

export const SUPPORTED_SCOPES: readonly OAuthScope[] = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "storage.read",
  "storage.write",
  "storage.delete",
];

export type ClientType = "public" | "confidential";

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
  ADMIN_SUBJECTS?: string;
  NODE_ENV?: string;
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
  storageLimits: StorageLimits;
  storageDefaultPageSize: number;
  storageMaxPageSize: number;
  storageReadRateLimit: number;
  storageWriteRateLimit: number;
  adminSubjects: readonly string[];
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

export interface AuthStore {
  cleanup(now: number): Promise<void>;
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
  ): Promise<void>;

  findOrCreateUser(identity: UpstreamIdentity, now: number): Promise<LocalUser>;
  getUser(id: string): Promise<LocalUser | null>;
  countUsers(): Promise<number>;

  createClient(
    input: ClientRegistrationInput,
    secretHash: string | null,
    now: number,
  ): Promise<ClientView>;
  listClients(): Promise<ClientView[]>;
  getClient(id: string): Promise<ClientView | null>;
  getClientSecretHash(id: string): Promise<string | null>;
  hasActiveClientOrigin(origin: string): Promise<boolean>;
  setClientDisabled(id: string, disabledAt: number | null): Promise<void>;
  rotateClientSecret(
    id: string,
    secretHash: string,
    now: number,
  ): Promise<void>;
  revokeClientGrants(clientId: string, now: number): Promise<void>;

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
  getStorageUsage(userId: string, clientId: string): Promise<StorageUsage>;
}
