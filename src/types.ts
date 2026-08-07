export type OAuthScope = "openid" | "email" | "profile" | "offline_access";

export const SUPPORTED_SCOPES: readonly OAuthScope[] = [
  "openid",
  "email",
  "profile",
  "offline_access",
];

export type ClientType = "public" | "confidential";

export type DeviceGrantStatus = "pending" | "approved" | "denied" | "used";

export type TokenFamilyStatus = "active" | "revoked";

export interface RuntimeEnv {
  DB?: D1Database;
  ISSUER_URL?: string;
  JWT_PRIVATE_JWK?: string;
  JWT_KEY_ID?: string;
  ADMIN_EMAILS?: string;
  ACCESS_TOKEN_TTL_SECONDS?: string;
  AUTH_CODE_TTL_SECONDS?: string;
  DEVICE_CODE_TTL_SECONDS?: string;
  DEVICE_POLL_INTERVAL_SECONDS?: string;
  REFRESH_TOKEN_TTL_SECONDS?: string;
  ALLOWED_CORS_ORIGINS?: string;
  NODE_ENV?: string;
  TEST_AUTH_EMAIL?: string;
  TEST_AUTH_FULL_NAME?: string;
}

export interface AppConfig {
  issuerUrl: string;
  jwtPrivateJwk: JsonWebKey;
  jwtKeyId: string;
  adminEmails: readonly string[];
  accessTokenTtlSeconds: number;
  authCodeTtlSeconds: number;
  deviceCodeTtlSeconds: number;
  devicePollIntervalSeconds: number;
  refreshTokenTtlSeconds: number;
  allowedCorsOrigins: readonly string[];
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

export interface AuthStore {
  migrate(): Promise<void>;
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

  createClient(
    input: ClientRegistrationInput,
    secretHash: string | null,
    now: number,
  ): Promise<ClientView>;
  listClients(): Promise<ClientView[]>;
  getClient(id: string): Promise<ClientView | null>;
  getClientSecretHash(id: string): Promise<string | null>;
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

  createAuthorizationRequest(request: AuthorizationRequest): Promise<void>;
  getAuthorizationRequest(id: string): Promise<AuthorizationRequest | null>;
  updateAuthorizationRequest(request: AuthorizationRequest): Promise<void>;
  createAuthorizationCode(code: AuthorizationCode): Promise<void>;
  consumeAuthorizationCode(
    hash: string,
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
    now: number,
  ): Promise<RefreshTokenRecord | null>;
  revokeRefreshFamily(familyId: string, now: number): Promise<void>;
  revokeRefreshToken(hash: string, now: number): Promise<void>;

  revokeAccessTokenJti(
    jti: string,
    expiresAt: number,
    now: number,
  ): Promise<void>;
  isAccessTokenJtiRevoked(jti: string): Promise<boolean>;
}
