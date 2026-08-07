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
import { SUPPORTED_SCOPES } from "./types";

export function parseScopes(value: string | null | undefined): string[] {
  const scopes = (value || "").split(/\s+/).filter(Boolean);
  return scopes.length ? Array.from(new Set(scopes)) : [];
}

export function validateScopes(
  scopes: readonly string[],
  client: ClientView,
): string | null {
  for (const scope of scopes) {
    if (!SUPPORTED_SCOPES.includes(scope as never))
      return `Unsupported scope: ${scope}`;
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
  if (!client || client.disabledAt)
    return oauthError("invalid_client", "Client authentication failed", 401);
  if (client.type === "confidential") {
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
): Promise<{ client: ClientView; secret: string | null }> {
  if (!input.name.trim()) throw new Error("Client name is required");
  if (input.type !== "public" && input.type !== "confidential")
    throw new Error("Invalid client type");
  for (const uri of input.redirectUris) assertExactUri(uri);
  for (const origin of input.origins) assertOrigin(origin);
  const scopeError = validateRawScopes(input.scopes);
  if (scopeError) throw new Error(scopeError);
  const secret = input.type === "confidential" ? randomToken(32) : null;
  const secretHash = secret ? await sha256(secret) : null;
  const client = await store.createClient(input, secretHash, now);
  return { client, secret };
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

export async function createDeviceAuthorization(
  request: Request,
  form: URLSearchParams,
  config: AppConfig,
  store: AuthStore,
): Promise<Response> {
  const now = nowSeconds();
  const client = await authenticateClient(request, form, store);
  if (client instanceof Response) return client;
  const scopes = parseScopes(form.get("scope") || "openid email profile");
  const scopeError = validateScopes(scopes, client);
  if (scopeError) return oauthError("invalid_scope", scopeError);

  const deviceCode = randomToken(40);
  const userCode = randomUserCode();
  const grant: DeviceGrant = {
    id: uuid(),
    deviceCodeHash: await sha256(deviceCode),
    userCodeHash: await sha256(normalizeUserCode(userCode)),
    userCodeDisplay: userCode,
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
      _links: {
        verification: { href: verificationUri, type: "text/html" },
        token: {
          href: `${config.issuerUrl}/oauth/token`,
          type: "application/json",
        },
        service: { href: config.issuerUrl, type: "text/html" },
      },
      actions: {
        poll: {
          method: "POST",
          href: `${config.issuerUrl}/oauth/token`,
          encoding: "application/x-www-form-urlencoded",
          parameters: ["grant_type", "device_code", "client_id"],
        },
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

export async function pollDeviceToken(
  form: URLSearchParams,
  config: AppConfig,
  store: AuthStore,
): Promise<Response> {
  const now = nowSeconds();
  const deviceCode = form.get("device_code") || "";
  const grant = await store.getDeviceGrantByDeviceHash(
    await sha256(deviceCode),
  );
  if (!grant) return oauthError("invalid_grant", "Invalid device code");
  if (grant.expiresAt <= now)
    return oauthError("expired_token", "Device code expired", 400);
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
  const client = await store.getClient(grant.clientId);
  const user = await store.getUser(grant.userId);
  if (!client || !user)
    return oauthError("invalid_grant", "Device grant unavailable");
  grant.status = "used";
  await store.updateDeviceGrant(grant);
  return jsonToken(
    await issueTokens({
      config,
      store,
      user,
      client,
      scope: grant.scope,
      includeRefresh: parseScopes(grant.scope).includes("offline_access"),
      now,
    }),
  );
}

export async function createAuthorizeRequest(
  url: URL,
  config: AppConfig,
  store: AuthStore,
): Promise<Response> {
  const now = nowSeconds();
  const clientId = url.searchParams.get("client_id") || "";
  const client = await store.getClient(clientId);
  if (!client || client.disabledAt)
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
  const scopeError = validateScopes(scopes, client);
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
): Promise<string> {
  authRequest.status = "approved";
  authRequest.userId = user.id;
  await store.updateAuthorizationRequest(authRequest);
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

export async function exchangeAuthorizationCode(
  form: URLSearchParams,
  config: AppConfig,
  store: AuthStore,
  client: ClientView,
): Promise<Response> {
  const now = nowSeconds();
  const code = await store.consumeAuthorizationCode(
    await sha256(form.get("code") || ""),
    now,
  );
  if (
    !code ||
    code.clientId !== client.id ||
    code.redirectUri !== form.get("redirect_uri")
  ) {
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
  const user = await store.getUser(code.userId);
  if (!user) return oauthError("invalid_grant", "Invalid authorization code");
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
    now,
  );
  if (!existing || existing.clientId !== client.id)
    return oauthError("invalid_grant", "Invalid refresh token");
  const user = await store.getUser(existing.userId);
  if (!user) return oauthError("invalid_grant", "Invalid refresh token");
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
  const tokens = await issueTokens({
    config,
    store,
    user,
    client,
    scope: existing.scope,
    includeRefresh: false,
    now,
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

function validateRawScopes(scopes: readonly string[]): string | null {
  for (const scope of scopes) {
    if (!SUPPORTED_SCOPES.includes(scope as never))
      return `Unsupported scope: ${scope}`;
  }
  return null;
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
