import { uuid } from "../crypto";
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
  counters = new Map<string, { count: number; windowStart: number }>();
  audits: Array<{ type: string; data: Record<string, unknown>; now: number }> =
    [];

  async migrate(): Promise<void> {}

  async cleanup(now: number): Promise<void> {
    for (const [key, value] of this.revokedJtis) {
      if (value <= now) this.revokedJtis.delete(key);
    }
  }

  async rateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    now: number,
  ): Promise<boolean> {
    const counter = this.counters.get(key);
    if (!counter || counter.windowStart + windowSeconds <= now) {
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
    this.audits.push({ type, data, now });
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
    return Array.from(this.clients.values(), stripSecret);
  }

  async getClient(id: string): Promise<ClientView | null> {
    const client = this.clients.get(id);
    return client ? stripSecret(client) : null;
  }

  async getClientSecretHash(id: string): Promise<string | null> {
    return this.clients.get(id)?.secretHash ?? null;
  }

  async setClientDisabled(
    id: string,
    disabledAt: number | null,
  ): Promise<void> {
    const client = this.clients.get(id);
    if (client) client.disabledAt = disabledAt;
  }

  async rotateClientSecret(id: string, secretHash: string): Promise<void> {
    const client = this.clients.get(id);
    if (client) client.secretHash = secretHash;
  }

  async revokeClientGrants(clientId: string, now: number): Promise<void> {
    for (const family of this.families.values()) {
      if (family.clientId === clientId) {
        family.status = "revoked";
        for (const token of this.refreshTokens.values()) {
          if (token.familyId === family.id) token.revokedAt = now;
        }
      }
    }
  }

  async createDeviceGrant(grant: DeviceGrant): Promise<void> {
    this.devices.set(grant.deviceCodeHash, grant);
    this.devicesByUserCodeHash.set(grant.userCodeHash, grant.deviceCodeHash);
  }

  async getDeviceGrantByDeviceHash(hash: string): Promise<DeviceGrant | null> {
    return this.devices.get(hash) ?? null;
  }

  async getDeviceGrantByUserCodeHash(
    hash: string,
  ): Promise<DeviceGrant | null> {
    const deviceHash = this.devicesByUserCodeHash.get(hash);
    return deviceHash ? (this.devices.get(deviceHash) ?? null) : null;
  }

  async updateDeviceGrant(grant: DeviceGrant): Promise<void> {
    this.devices.set(grant.deviceCodeHash, grant);
  }

  async createAuthorizationRequest(
    request: AuthorizationRequest,
  ): Promise<void> {
    this.authRequests.set(request.id, request);
  }

  async getAuthorizationRequest(
    id: string,
  ): Promise<AuthorizationRequest | null> {
    return this.authRequests.get(id) ?? null;
  }

  async updateAuthorizationRequest(
    request: AuthorizationRequest,
  ): Promise<void> {
    this.authRequests.set(request.id, request);
  }

  async createAuthorizationCode(code: AuthorizationCode): Promise<void> {
    this.authCodes.set(code.codeHash, code);
  }

  async consumeAuthorizationCode(
    hash: string,
    now: number,
  ): Promise<AuthorizationCode | null> {
    const code = this.authCodes.get(hash);
    if (!code || code.consumedAt || code.expiresAt <= now) return null;
    code.consumedAt = now;
    return code;
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
    this.families.set(family.id, family);
  }

  async createRefreshToken(token: RefreshTokenRecord): Promise<void> {
    this.refreshTokens.set(token.tokenHash, token);
  }

  async consumeRefreshToken(
    hash: string,
    now: number,
  ): Promise<RefreshTokenRecord | null> {
    const token = this.refreshTokens.get(hash);
    if (!token || token.expiresAt <= now || token.revokedAt) return null;
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
    return token;
  }

  async revokeRefreshFamily(familyId: string, now: number): Promise<void> {
    const family = this.families.get(familyId);
    if (family) family.status = "revoked";
    for (const token of this.refreshTokens.values()) {
      if (token.familyId === familyId) token.revokedAt = now;
    }
  }

  async revokeRefreshToken(hash: string, now: number): Promise<void> {
    const token = this.refreshTokens.get(hash);
    if (token) token.revokedAt = now;
  }

  async revokeAccessTokenJti(jti: string, expiresAt: number): Promise<void> {
    this.revokedJtis.set(jti, expiresAt);
  }

  async isAccessTokenJtiRevoked(jti: string): Promise<boolean> {
    return this.revokedJtis.has(jti);
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
