import {
  constantTimeEquals,
  nowSeconds,
  publicJwk,
  randomToken,
  randomUserCode,
  sha256,
  signJwt,
  uuid,
  verifyJwt,
  verifyPkceS256,
} from "./crypto";
import { oauthError, parseBasicAuth } from "./http";
import { HYPERMEDIA_API_VERSION, action, field, link } from "./hypermedia";
import {
  availableServiceClientScopes,
  validateAvailableScopes,
} from "./oauth-scopes";
import { isBrowserSessionClientId } from "./system-client";
import {
  isSubjectAuthorizationDenied,
  requireActiveSubject,
} from "./subject-access";
import type {
  AppConfig,
  AuthStore,
  AuthorizationRequest,
  ClientRegistrationInput,
  ClientView,
  DeviceGrant,
  LocalUser,
  OAuthClient,
  RefreshTokenFamily,
} from "./types";
export { SERVICE_CLIENT_SCOPES } from "./oauth-scopes";

export class OAuthScopePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthScopePolicyError";
  }
}

export function parseScopes(value: string | null | undefined): string[] {
  const scopes = (value || "").split(/\s+/).filter(Boolean);
  return scopes.length ? Array.from(new Set(scopes)) : [];
}

export function validateScopes(
  scopes: readonly string[],
  client: ClientView,
  eventsEnabled = false,
): string | null {
  const availabilityError = validateAvailableScopes(scopes, eventsEnabled);
  if (availabilityError) return availabilityError;
  for (const scope of scopes) {
    if (!client.scopes.includes(scope))
      return `Client is not allowed to request scope: ${scope}`;
  }
  return null;
}

export async function authenticateClient(
  request: Request,
  form: URLSearchParams,
  store: AuthStore,
): Promise<ClientView | Response> {
  const basic = parseBasicAuth(request);
  const clientId = basic?.username || form.get("client_id") || "";
  const secret = basic?.password || form.get("client_secret") || "";
  if (!clientId)
    return oauthError("invalid_client", "Client authentication failed", 401);

  const client = await store.getClient(clientId);
  if (!client || client.disabledAt || isBrowserSessionClientId(client.id))
    return oauthError("invalid_client", "Client authentication failed", 401);
  if (client.type !== "public") {
    const storedHash = await store.getClientSecretHash(client.id);
    if (!storedHash || !secret)
      return oauthError("invalid_client", "Client authentication failed", 401);
    const suppliedHash = await sha256(secret);
    if (!(await constantTimeEquals(storedHash, suppliedHash))) {
      return oauthError("invalid_client", "Client authentication failed", 401);
    }
  }
  return client;
}

export async function createClientRegistration(
  input: ClientRegistrationInput,
  store: AuthStore,
  now: number,
  options: { eventsEnabled?: boolean } = {},
): Promise<{ client: ClientView; secret: string | null }> {
  const validationError = validateClientRegistrationInput(
    input,
    options.eventsEnabled,
  );
  if (validationError) throw new Error(validationError);
  const secret = input.type === "public" ? null : randomToken(32);
  const secretHash = secret ? await sha256(secret) : null;
  const client = await store.createClient(input, secretHash, now);
  return { client, secret };
}

export function validateClientRegistrationInput(
  input: ClientRegistrationInput,
  eventsEnabled = false,
): string | null {
  const name = input.name.trim();
  if (!name) return "Client name is required";
  if (name.length > 120) return "Client name must be at most 120 characters";
  if (
    input.type !== "public" &&
    input.type !== "confidential" &&
    input.type !== "service"
  )
    return "Invalid client type";
  const scopeError = validateAvailableScopes(input.scopes, eventsEnabled);
  if (scopeError) return scopeError;
  if (input.type === "service") {
    if (input.redirectUris.length)
      return "Service clients cannot register redirect URIs";
    if (input.origins.length)
      return "Service clients cannot register browser origins";
    if (!input.scopes.length)
      return "Service clients require an AittaDB data scope";
    const serviceScopes = availableServiceClientScopes(eventsEnabled);
    for (const scope of input.scopes) {
      if (!serviceScopes.includes(scope as never))
        return "Service clients may request only enabled AittaDB data scopes";
    }
  }
  for (const uri of input.redirectUris) {
    try {
      assertExactUri(uri);
    } catch (error) {
      return knownValidationMessage(error, "Invalid redirect URI");
    }
  }
  for (const origin of input.origins) {
    try {
      assertOrigin(origin);
    } catch (error) {
      return knownValidationMessage(error, "Invalid origin");
    }
  }
  return null;
}

export async function issueTokens(params: {
  config: AppConfig;
  store: AuthStore;
  user: LocalUser;
  client: ClientView;
  scope: string;
  nonce?: string | null;
  includeRefresh: boolean;
  now: number;
}): Promise<Record<string, unknown>> {
  const scopeList = parseScopes(params.scope);
  const scopeError = validateScopes(
    scopeList,
    params.client,
    params.config.features.events,
  );
  if (scopeError) throw new OAuthScopePolicyError(scopeError);
  await requireActiveSubject(params.store, params.user.id);
  const accessJti = uuid();
  const accessToken = await signJwt(
    {
      iss: params.config.issuerUrl,
      sub: params.user.id,
      aud: params.client.id,
      exp: params.now + params.config.accessTokenTtlSeconds,
      iat: params.now,
      nbf: params.now,
      jti: accessJti,
      scope: params.scope,
      token_use: "access",
    },
    params.config.jwtPrivateJwk,
    params.config.jwtKeyId,
  );

  const response: Record<string, unknown> = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: params.config.accessTokenTtlSeconds,
    scope: params.scope,
  };

  if (scopeList.includes("openid")) {
    response.id_token = await signJwt(
      {
        iss: params.config.issuerUrl,
        sub: params.user.id,
        aud: params.client.id,
        exp: params.now + params.config.accessTokenTtlSeconds,
        iat: params.now,
        nbf: params.now,
        jti: uuid(),
        nonce: params.nonce ?? undefined,
        email: scopeList.includes("email") ? params.user.email : undefined,
        name: scopeList.includes("profile")
          ? params.user.displayName
          : undefined,
        email_verified: false,
        token_use: "id",
      },
      params.config.jwtPrivateJwk,
      params.config.jwtKeyId,
    );
  }

  if (params.includeRefresh && scopeList.includes("offline_access")) {
    const family: RefreshTokenFamily = {
      id: uuid(),
      userId: params.user.id,
      clientId: params.client.id,
      status: "active",
      createdAt: params.now,
    };
    const refreshToken = randomToken(48);
    await params.store.createRefreshFamily(family);
    await params.store.createRefreshToken({
      id: uuid(),
      familyId: family.id,
      tokenHash: await sha256(refreshToken),
      userId: params.user.id,
      clientId: params.client.id,
      scope: params.scope,
      expiresAt: params.now + params.config.refreshTokenTtlSeconds,
      usedAt: null,
      revokedAt: null,
    });
    response.refresh_token = refreshToken;
  }

  return response;
}

export async function issueClientCredentialsToken(params: {
  config: AppConfig;
  store: AuthStore;
  client: ClientView;
  requestedScope: string | null;
  now: number;
}): Promise<Response> {
  if (params.client.type !== "service") {
    return oauthError(
      "unauthorized_client",
      "Client credentials requires a service client",
    );
  }
  if (!(await params.store.hasServicePrincipal(params.client.id))) {
    return oauthError("invalid_client", "Client authentication failed", 401);
  }
  const scopes = parseScopes(
    params.requestedScope ?? params.client.scopes.join(" "),
  );
  const scopeError = validateScopes(
    scopes,
    params.client,
    params.config.features.events,
  );
  const serviceScopes = availableServiceClientScopes(
    params.config.features.events,
  );
  if (
    !scopes.length ||
    scopeError ||
    scopes.some((scope) => !serviceScopes.includes(scope as never))
  ) {
    return oauthError(
      "invalid_scope",
      scopeError ??
        "Service clients may request only enabled AittaDB data scopes",
    );
  }
  return jsonToken({
    access_token: await signJwt(
      {
        iss: params.config.issuerUrl,
        sub: params.client.id,
        aud: params.client.id,
        exp: params.now + params.config.accessTokenTtlSeconds,
        iat: params.now,
        nbf: params.now,
        jti: uuid(),
        scope: scopes.join(" "),
        token_use: "access",
        subject_type: "service",
        client_id: params.client.id,
      },
      params.config.jwtPrivateJwk,
      params.config.jwtKeyId,
    ),
    token_type: "Bearer",
    expires_in: params.config.accessTokenTtlSeconds,
    scope: scopes.join(" "),
  });
}

export async function createDeviceAuthorization(
  request: Request,
  form: URLSearchParams,
  config: AppConfig,
  store: AuthStore,
): Promise<Response> {
  const now = nowSeconds();
  const client = await authenticateClient(request, form, store);
  if (client instanceof Response) return client;
  if (client.type === "service") {
    return oauthError(
      "unauthorized_client",
      "Service clients cannot use the Device Authorization Grant",
    );
  }
  const scopes = parseScopes(form.get("scope") || "openid email profile");
  const scopeError = validateScopes(scopes, client, config.features.events);
  if (scopeError) return oauthError("invalid_scope", scopeError);

  const deviceCode = randomToken(40);
  const userCode = randomUserCode();
  const grant: DeviceGrant = {
    id: uuid(),
    deviceCodeHash: await sha256(deviceCode),
    userCodeHash: await sha256(normalizeUserCode(userCode)),
    userCodeDisplay: "",
    clientId: client.id,
    scope: scopes.join(" "),
    status: "pending",
    userId: null,
    createdAt: now,
    expiresAt: now + config.deviceCodeTtlSeconds,
    intervalSeconds: config.devicePollIntervalSeconds,
    lastPollAt: null,
    slowDownCount: 0,
  };
  await store.createDeviceGrant(grant);
  const verificationUri = `${config.issuerUrl}/device`;
  return new Response(
    JSON.stringify({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
      expires_in: config.deviceCodeTtlSeconds,
      interval: config.devicePollIntervalSeconds,
      api_version: HYPERMEDIA_API_VERSION,
      links: [
        link("verification", verificationUri, { type: "text/html" }),
        link("token", `${config.issuerUrl}/oauth/token`, {
          type: "application/json",
        }),
        link("service", config.issuerUrl),
      ],
      actions: [
        action(
          "poll-device-token",
          "Poll device token",
          "POST",
          `${config.issuerUrl}/oauth/token`,
          {
            type: "application/x-www-form-urlencoded",
            fields: [
              field("grant_type", "Grant type", "string", "body", {
                required: true,
                value: "urn:ietf:params:oauth:grant-type:device_code",
              }),
              field("device_code", "Device code", "string", "body", {
                required: true,
                secret: true,
                value: deviceCode,
              }),
              field("client_id", "Client ID", "string", "body", {
                required: true,
                value: client.id,
              }),
            ],
          },
        ),
      ],
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "aittadb-api-version": HYPERMEDIA_API_VERSION,
      },
    },
  );
}

export async function pollDeviceToken(
  request: Request,
  form: URLSearchParams,
  config: AppConfig,
  store: AuthStore,
): Promise<Response> {
  const now = nowSeconds();
  const authenticatedClient = await authenticateClient(request, form, store);
  if (authenticatedClient instanceof Response) return authenticatedClient;
  const deviceCode = form.get("device_code") || "";
  const grant = await store.getDeviceGrantByDeviceHash(
    await sha256(deviceCode),
  );
  if (!grant) return oauthError("invalid_grant", "Invalid device code");
  if (grant.clientId !== authenticatedClient.id)
    return oauthError("invalid_grant", "Invalid device code");
  if (grant.expiresAt <= now)
    return oauthError("expired_token", "Device code expired", 400);
  const scopeError = validateScopes(
    parseScopes(grant.scope),
    authenticatedClient,
    config.features.events,
  );
  if (scopeError) return oauthError("invalid_scope", scopeError);
  if (
    grant.lastPollAt &&
    now - grant.lastPollAt < grant.intervalSeconds + grant.slowDownCount * 5
  ) {
    grant.slowDownCount += 1;
    grant.lastPollAt = now;
    await store.updateDeviceGrant(grant);
    return oauthError("slow_down", "Polling too quickly", 400);
  }
  grant.lastPollAt = now;
  await store.updateDeviceGrant(grant);
  if (grant.status === "pending")
    return oauthError("authorization_pending", "Authorization is pending", 400);
  if (grant.status === "denied")
    return oauthError("access_denied", "The user denied the request", 400);
  if (grant.status !== "approved" || !grant.userId)
    return oauthError("invalid_grant", "Device grant unavailable");
  const consumed = await store.consumeDeviceGrant(
    grant.deviceCodeHash,
    authenticatedClient.id,
    now,
  );
  if (!consumed?.userId)
    return oauthError("invalid_grant", "Device grant unavailable");
  const user = await store.getUser(consumed.userId);
  if (!user) return oauthError("invalid_grant", "Device grant unavailable");
  try {
    return jsonToken(
      await issueTokens({
        config,
        store,
        user,
        client: authenticatedClient,
        scope: grant.scope,
        includeRefresh: parseScopes(grant.scope).includes("offline_access"),
        now,
      }),
    );
  } catch (error) {
    if (isSubjectAuthorizationDenied(error)) {
      return oauthError("invalid_grant", "Device grant unavailable");
    }
    throw error;
  }
}

export async function createAuthorizeRequest(
  url: URL,
  config: AppConfig,
  store: AuthStore,
): Promise<Response> {
  const now = nowSeconds();
  const clientId = url.searchParams.get("client_id") || "";
  const client = await store.getClient(clientId);
  if (
    !client ||
    client.disabledAt ||
    client.type === "service" ||
    isBrowserSessionClientId(client.id)
  )
    return oauthError("invalid_client", "Unknown client", 400);
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  if (!client.redirectUris.includes(redirectUri)) {
    return oauthError(
      "invalid_request",
      "redirect_uri must exactly match a registered URI",
      400,
    );
  }
  const errorRedirect = new URL(redirectUri);
  const state = url.searchParams.get("state");
  if (url.searchParams.get("response_type") !== "code") {
    return redirectOAuthError(
      errorRedirect,
      "unsupported_response_type",
      "Only response_type=code is supported",
      state,
    );
  }
  if (url.searchParams.get("code_challenge_method") !== "S256") {
    return redirectOAuthError(
      errorRedirect,
      "invalid_request",
      "PKCE S256 is required",
      state,
    );
  }
  const codeChallenge = url.searchParams.get("code_challenge") || "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return redirectOAuthError(
      errorRedirect,
      "invalid_request",
      "A valid S256 code challenge is required",
      state,
    );
  }
  const scopes = parseScopes(
    url.searchParams.get("scope") || "openid email profile",
  );
  const scopeError = validateScopes(scopes, client, config.features.events);
  if (scopeError)
    return redirectOAuthError(
      new URL(redirectUri),
      "invalid_scope",
      scopeError,
      url.searchParams.get("state"),
    );
  const request: AuthorizationRequest = {
    id: uuid(),
    clientId: client.id,
    redirectUri,
    scope: scopes.join(" "),
    state,
    nonce: url.searchParams.get("nonce"),
    codeChallenge,
    createdAt: now,
    expiresAt: now + config.authCodeTtlSeconds,
    userId: null,
    status: "pending",
  };
  await store.createAuthorizationRequest(request);
  return Response.redirect(
    `${config.issuerUrl}/consent?request_id=${encodeURIComponent(request.id)}`,
    302,
  );
}

export async function approveAuthorizationRequest(
  authRequest: AuthorizationRequest,
  user: LocalUser,
  store: AuthStore,
  now: number,
): Promise<string | null> {
  if (
    !(await store.transitionAuthorizationRequest(
      authRequest.id,
      "approved",
      user.id,
      now,
    ))
  )
    return null;
  await store.saveConsent(
    user.id,
    authRequest.clientId,
    authRequest.scope,
    now,
  );
  const code = randomToken(32);
  await store.createAuthorizationCode({
    codeHash: await sha256(code),
    authRequestId: authRequest.id,
    clientId: authRequest.clientId,
    redirectUri: authRequest.redirectUri,
    userId: user.id,
    scope: authRequest.scope,
    nonce: authRequest.nonce,
    expiresAt: now + 300,
    consumedAt: null,
  });
  return code;
}

export async function denyAuthorizationRequest(
  authRequest: AuthorizationRequest,
  store: AuthStore,
  now: number,
): Promise<boolean> {
  return store.transitionAuthorizationRequest(
    authRequest.id,
    "denied",
    null,
    now,
  );
}

export async function exchangeAuthorizationCode(
  form: URLSearchParams,
  config: AppConfig,
  store: AuthStore,
  client: ClientView,
): Promise<Response> {
  const now = nowSeconds();
  const code = await store.consumeAuthorizationCode(
    await sha256(form.get("code") || ""),
    client.id,
    form.get("redirect_uri") || "",
    now,
  );
  if (!code) {
    return oauthError("invalid_grant", "Invalid authorization code");
  }
  if (
    !(await verifyPkceS256(
      form.get("code_verifier") || "",
      (await store.getAuthorizationRequest(code.authRequestId))
        ?.codeChallenge || "",
    ))
  ) {
    return oauthError("invalid_grant", "PKCE verification failed");
  }
  const scopeError = validateScopes(
    parseScopes(code.scope),
    client,
    config.features.events,
  );
  if (scopeError) return oauthError("invalid_scope", scopeError);
  const user = await store.getUser(code.userId);
  if (!user) return oauthError("invalid_grant", "Invalid authorization code");
  try {
    return jsonToken(
      await issueTokens({
        config,
        store,
        user,
        client,
        scope: code.scope,
        nonce: code.nonce,
        includeRefresh: parseScopes(code.scope).includes("offline_access"),
        now,
      }),
    );
  } catch (error) {
    if (isSubjectAuthorizationDenied(error)) {
      return oauthError("invalid_grant", "Invalid authorization code");
    }
    throw error;
  }
}

export async function rotateRefreshToken(
  form: URLSearchParams,
  config: AppConfig,
  store: AuthStore,
  client: ClientView,
): Promise<Response> {
  const now = nowSeconds();
  const existing = await store.consumeRefreshToken(
    await sha256(form.get("refresh_token") || ""),
    client.id,
    now,
  );
  if (!existing) return oauthError("invalid_grant", "Invalid refresh token");
  const scopeError = validateScopes(
    parseScopes(existing.scope),
    client,
    config.features.events,
  );
  if (scopeError) return oauthError("invalid_scope", scopeError);
  const user = await store.getUser(existing.userId);
  if (!user) return oauthError("invalid_grant", "Invalid refresh token");
  let tokens: Record<string, unknown>;
  try {
    tokens = await issueTokens({
      config,
      store,
      user,
      client,
      scope: existing.scope,
      includeRefresh: false,
      now,
    });
  } catch (error) {
    if (isSubjectAuthorizationDenied(error)) {
      return oauthError("invalid_grant", "Invalid refresh token");
    }
    throw error;
  }
  const refreshToken = randomToken(48);
  await store.createRefreshToken({
    id: uuid(),
    familyId: existing.familyId,
    tokenHash: await sha256(refreshToken),
    userId: existing.userId,
    clientId: existing.clientId,
    scope: existing.scope,
    expiresAt: now + config.refreshTokenTtlSeconds,
    usedAt: null,
    revokedAt: null,
  });
  tokens.refresh_token = refreshToken;
  return jsonToken(tokens);
}

export async function verifyAccessToken(
  token: string,
  config: AppConfig,
  store: AuthStore,
  audience: string,
) {
  const verified = await verifyJwt(
    token,
    [publicJwk(config.jwtPrivateJwk, config.jwtKeyId)],
    {
      issuer: config.issuerUrl,
      audience,
      now: nowSeconds(),
    },
  );
  if (
    verified.claims.token_use !== "access" ||
    typeof verified.claims.jti !== "string" ||
    typeof verified.claims.sub !== "string"
  )
    throw new Error("invalid_token_use");
  await requireActiveSubject(store, verified.claims.sub);
  if (await store.isAccessTokenJtiRevoked(verified.claims.jti))
    throw new Error("revoked_token");
  return verified;
}

export function normalizeUserCode(value: string): string {
  return value.replaceAll("-", "").replaceAll(" ", "").toUpperCase();
}

export function clientLike(client: ClientView): OAuthClient {
  return {
    id: client.id,
    type: client.type,
    name: client.name,
    secretHash: null,
    disabledAt: client.disabledAt,
    createdAt: client.createdAt,
  };
}

function assertExactUri(value: string): void {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("Unsupported redirect URI");
  if (url.hash) throw new Error("Redirect URI must not include a fragment");
}

function assertOrigin(value: string): void {
  const url = new URL(value);
  if (url.origin !== value)
    throw new Error("Origin must be exact scheme, host, and port");
}

function knownValidationMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return [
    "Unsupported redirect URI",
    "Redirect URI must not include a fragment",
    "Origin must be exact scheme, host, and port",
  ].includes(error.message)
    ? error.message
    : fallback;
}

function redirectOAuthError(
  url: URL,
  error: string,
  description: string,
  state?: string | null,
): Response {
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

function jsonToken(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}
