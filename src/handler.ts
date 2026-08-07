import { loadConfig } from "./config";
import { nowSeconds, publicJwk, randomToken, sha256 } from "./crypto";
import { D1AuthStore } from "./store/d1";
import type { RuntimeEnv, AuthStore, ClientRegistrationInput } from "./types";
import { requireSitesIdentity } from "./identity";
import {
  addSecurityHeaders,
  bearerToken,
  cors,
  csrfCookie,
  html,
  json,
  oauthError,
  parseCookies,
  readForm,
  redirect,
  requireSameOrigin,
} from "./http";
import { oidcConfiguration, openApiSpec } from "./openapi";
import {
  adminClientsPage,
  consentPage,
  deviceConsentPage,
  deviceEntryPage,
  docsPage,
  errorPage,
} from "./pages";
import {
  approveAuthorizationRequest,
  authenticateClient,
  createAuthorizeRequest,
  createClientRegistration,
  createDeviceAuthorization,
  exchangeAuthorizationCode,
  normalizeUserCode,
  parseScopes,
  pollDeviceToken,
  rotateRefreshToken,
  verifyAccessToken,
} from "./oauth";

export interface BrokerApp {
  fetch(request: Request): Promise<Response | null>;
}

export async function createAuthBroker(
  env: RuntimeEnv,
  ctx?: { waitUntil(promise: Promise<unknown>): void },
): Promise<BrokerApp> {
  const fallbackUrl = env.ISSUER_URL ?? "https://sites-auth-broker.local";
  const config = loadConfig(env, fallbackUrl);
  const store = env.DB ? new D1AuthStore(env.DB) : null;
  if (store) {
    await store.migrate();
    ctx?.waitUntil(store.cleanup(nowSeconds()));
  }
  return createAuthBrokerWithStore(env, store, config);
}

export function createAuthBrokerWithStore(
  env: RuntimeEnv,
  store: AuthStore | null,
  config = loadConfig(env, env.ISSUER_URL ?? "https://sites-auth-broker.local"),
): BrokerApp {
  return {
    async fetch(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const corsHeaders = isCorsControlledRoute(url.pathname)
        ? cors(request, config.allowedCorsOrigins)
        : new Headers();
      if (corsHeaders instanceof Response) return corsHeaders;
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: corsHeaders });
      if (!isBrokerRoute(url.pathname)) return null;

      try {
        if (!store && needsStore(url.pathname))
          return json({ error: "database_unavailable" }, { status: 503 });

        const routed = await route(request, url, env, store, config);
        const headers = new Headers(routed.headers);
        for (const [key, value] of corsHeaders.entries())
          headers.set(key, value);
        addSecurityHeaders(headers);
        return new Response(routed.body, {
          status: routed.status,
          statusText: routed.statusText,
          headers,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unexpected error";
        if (message === "unsupported_media_type")
          return oauthError("invalid_request", "Unsupported content type", 415);
        if (message === "request_too_large")
          return oauthError("invalid_request", "Request is too large", 413);
        return json({ error: "server_error" }, { status: 500 });
      }
    },
  };
}

async function route(
  request: Request,
  url: URL,
  env: RuntimeEnv,
  store: AuthStore | null,
  config: ReturnType<typeof loadConfig>,
): Promise<Response> {
  if (url.pathname === "/" && request.method === "GET") {
    return json({
      service: "Sites Auth Broker",
      issuer: config.issuerUrl,
      docs: `${config.issuerUrl}/docs`,
      openapi: `${config.issuerUrl}/openapi.json`,
      officialOpenAIProduct: false,
    });
  }
  if (url.pathname === "/health" && request.method === "GET") {
    return json({ ok: true, service: "sites-auth-broker", d1: Boolean(store) });
  }
  if (
    url.pathname === "/.well-known/openid-configuration" &&
    request.method === "GET"
  ) {
    return json(oidcConfiguration(config.issuerUrl));
  }
  if (url.pathname === "/.well-known/jwks.json" && request.method === "GET") {
    return json({ keys: [publicJwk(config.jwtPrivateJwk, config.jwtKeyId)] });
  }
  if (url.pathname === "/openapi.json" && request.method === "GET") {
    return json({ ...openApiSpec, servers: [{ url: config.issuerUrl }] });
  }
  if (url.pathname === "/docs" && request.method === "GET")
    return html(docsPage());

  if (!store) return json({ error: "database_unavailable" }, { status: 503 });

  if (url.pathname === "/authorize" && request.method === "GET") {
    return createAuthorizeRequest(url, config, store);
  }
  if (
    url.pathname === "/oauth/device_authorization" &&
    request.method === "POST"
  ) {
    if (
      !(await store.rateLimit(
        `device:${clientIp(request)}`,
        30,
        60,
        nowSeconds(),
      ))
    ) {
      return oauthError("slow_down", "Rate limit exceeded", 429);
    }
    return createDeviceAuthorization(
      request,
      await readForm(request),
      config,
      store,
    );
  }
  if (url.pathname === "/oauth/token" && request.method === "POST") {
    return tokenEndpoint(request, config, store);
  }
  if (url.pathname === "/oauth/revoke" && request.method === "POST") {
    return revokeEndpoint(request, store);
  }
  if (url.pathname === "/oauth/introspect" && request.method === "POST") {
    return introspectEndpoint(request, config, store);
  }
  if (url.pathname === "/userinfo" && request.method === "GET") {
    return userInfoEndpoint(request, config, store);
  }
  if (url.pathname === "/device" && request.method === "GET") {
    const csrf = randomToken(24);
    const headers = new Headers({ "set-cookie": csrfCookie(csrf) });
    return html(
      deviceEntryPage(url.searchParams.get("user_code") || "", csrf),
      { headers },
    );
  }
  if (url.pathname === "/device" && request.method === "POST") {
    return deviceEntryPost(request, env, store);
  }
  if (url.pathname === "/device/decision" && request.method === "POST") {
    return deviceDecisionPost(request, env, store);
  }
  if (url.pathname === "/consent" && request.method === "GET") {
    return consentGet(request, env, store);
  }
  if (url.pathname === "/consent" && request.method === "POST") {
    return consentPost(request, env, store);
  }
  if (url.pathname === "/admin/clients" && request.method === "GET") {
    return adminClientsGet(request, env, config, store);
  }
  if (url.pathname === "/admin/clients" && request.method === "POST") {
    return adminClientsPost(request, env, config, store);
  }
  return json({ error: "not_found" }, { status: 404 });
}

async function tokenEndpoint(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
): Promise<Response> {
  if (
    !(await store.rateLimit(
      `token:${clientIp(request)}`,
      120,
      60,
      nowSeconds(),
    ))
  ) {
    return oauthError("slow_down", "Rate limit exceeded", 429);
  }
  const form = await readForm(request);
  const grantType = form.get("grant_type");
  if (grantType === "urn:ietf:params:oauth:grant-type:device_code")
    return pollDeviceToken(form, config, store);

  const client = await authenticateClient(request, form, store);
  if (client instanceof Response) return client;
  if (grantType === "authorization_code")
    return exchangeAuthorizationCode(form, config, store, client);
  if (grantType === "refresh_token")
    return rotateRefreshToken(form, config, store, client);
  return oauthError("unsupported_grant_type", "Unsupported grant type");
}

async function revokeEndpoint(
  request: Request,
  store: AuthStore,
): Promise<Response> {
  const form = await readForm(request);
  const token = form.get("token") || "";
  const hint = form.get("token_type_hint");
  const hash = await sha256(token);
  if (hint === "refresh_token")
    await store.revokeRefreshToken(hash, nowSeconds());
  return json({});
}

async function introspectEndpoint(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
): Promise<Response> {
  const form = await readForm(request);
  const client = await authenticateClient(request, form, store);
  if (client instanceof Response) return client;
  if (client.type !== "confidential")
    return oauthError("invalid_client", "Confidential client required", 401);
  try {
    const verified = await verifyAccessToken(
      form.get("token") || "",
      config,
      store,
      client.id,
    );
    return json({ active: true, ...verified.claims });
  } catch {
    return json({ active: false });
  }
}

async function userInfoEndpoint(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return oauthError("invalid_token", "Bearer token required", 401);
  const audience = parseJwtAudience(token);
  if (!audience) return oauthError("invalid_token", "Invalid token", 401);
  try {
    const verified = await verifyAccessToken(token, config, store, audience);
    const user = await store.getUser(verified.claims.sub);
    if (!user) return oauthError("invalid_token", "Invalid token", 401);
    const scopes = parseScopes(String(verified.claims.scope || ""));
    return json({
      sub: user.id,
      ...(scopes.includes("email")
        ? { email: user.email, email_verified: false }
        : {}),
      ...(scopes.includes("profile") ? { name: user.displayName } : {}),
    });
  } catch {
    return oauthError("invalid_token", "Invalid token", 401);
  }
}

async function deviceEntryPost(
  request: Request,
  env: RuntimeEnv,
  store: AuthStore,
): Promise<Response> {
  if (!requireSameOrigin(request))
    return html(
      errorPage("Invalid request", "Same-origin form submission is required"),
      { status: 403 },
    );
  const form = await readForm(request);
  if (!validCsrf(request, form))
    return html(errorPage("Invalid request", "CSRF validation failed"), {
      status: 403,
    });
  const grant = await store.getDeviceGrantByUserCodeHash(
    await sha256(normalizeUserCode(form.get("user_code") || "")),
  );
  if (!grant || grant.expiresAt <= nowSeconds())
    return html(
      deviceEntryPage(
        form.get("user_code") || "",
        randomToken(24),
        "Invalid or expired user code",
      ),
      { status: 400 },
    );
  const identity = requireSitesIdentity(request, env);
  if (identity instanceof Response) return identity;
  const client = await store.getClient(grant.clientId);
  if (!client)
    return html(errorPage("Invalid request", "Client is unavailable"), {
      status: 400,
    });
  const csrf = randomToken(24);
  return html(deviceConsentPage(grant, client, csrf), {
    headers: { "set-cookie": csrfCookie(csrf) },
  });
}

async function deviceDecisionPost(
  request: Request,
  env: RuntimeEnv,
  store: AuthStore,
): Promise<Response> {
  if (!requireSameOrigin(request))
    return html(
      errorPage("Invalid request", "Same-origin form submission is required"),
      { status: 403 },
    );
  const form = await readForm(request);
  if (!validCsrf(request, form))
    return html(errorPage("Invalid request", "CSRF validation failed"), {
      status: 403,
    });
  const identity = requireSitesIdentity(request, env);
  if (identity instanceof Response) return identity;
  const grant = await store.getDeviceGrantByUserCodeHash(
    await sha256(normalizeUserCode(form.get("user_code") || "")),
  );
  if (!grant || grant.status !== "pending" || grant.expiresAt <= nowSeconds()) {
    return html(
      errorPage("Invalid request", "Device request is no longer pending"),
      { status: 400 },
    );
  }
  const user = await store.findOrCreateUser(identity, nowSeconds());
  grant.status = form.get("decision") === "approve" ? "approved" : "denied";
  grant.userId = grant.status === "approved" ? user.id : null;
  await store.updateDeviceGrant(grant);
  return html(
    errorPage(
      "Device request updated",
      grant.status === "approved"
        ? "You may return to the CLI."
        : "The request was denied.",
    ),
  );
}

async function consentGet(
  request: Request,
  env: RuntimeEnv,
  store: AuthStore,
): Promise<Response> {
  const identity = requireSitesIdentity(request, env);
  if (identity instanceof Response) return identity;
  const requestId = new URL(request.url).searchParams.get("request_id") || "";
  const authRequest = await store.getAuthorizationRequest(requestId);
  if (!authRequest || authRequest.expiresAt <= nowSeconds())
    return html(errorPage("Invalid request", "Authorization request expired"), {
      status: 400,
    });
  const client = await store.getClient(authRequest.clientId);
  if (!client)
    return html(errorPage("Invalid request", "Client is unavailable"), {
      status: 400,
    });
  const user = await store.findOrCreateUser(identity, nowSeconds());
  if (await store.hasConsent(user.id, client.id, authRequest.scope)) {
    const code = await approveAuthorizationRequest(
      authRequest,
      user,
      store,
      nowSeconds(),
    );
    return redirectWithCode(authRequest.redirectUri, code, authRequest.state);
  }
  const csrf = randomToken(24);
  return html(consentPage(authRequest, client, csrf), {
    headers: { "set-cookie": csrfCookie(csrf) },
  });
}

async function consentPost(
  request: Request,
  env: RuntimeEnv,
  store: AuthStore,
): Promise<Response> {
  if (!requireSameOrigin(request))
    return html(
      errorPage("Invalid request", "Same-origin form submission is required"),
      { status: 403 },
    );
  const form = await readForm(request);
  if (!validCsrf(request, form))
    return html(errorPage("Invalid request", "CSRF validation failed"), {
      status: 403,
    });
  const identity = requireSitesIdentity(request, env);
  if (identity instanceof Response) return identity;
  const authRequest = await store.getAuthorizationRequest(
    form.get("request_id") || "",
  );
  if (!authRequest || authRequest.expiresAt <= nowSeconds())
    return html(errorPage("Invalid request", "Authorization request expired"), {
      status: 400,
    });
  if (form.get("decision") !== "approve") {
    return redirectWithError(
      authRequest.redirectUri,
      "access_denied",
      "The user denied the request",
      authRequest.state,
    );
  }
  const user = await store.findOrCreateUser(identity, nowSeconds());
  const code = await approveAuthorizationRequest(
    authRequest,
    user,
    store,
    nowSeconds(),
  );
  return redirectWithCode(authRequest.redirectUri, code, authRequest.state);
}

async function adminClientsGet(
  request: Request,
  env: RuntimeEnv,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
): Promise<Response> {
  const admin = await requireAdmin(request, env, config, store);
  if (admin instanceof Response) return admin;
  const csrf = randomToken(24);
  return html(adminClientsPage(await store.listClients(), csrf, null), {
    headers: { "set-cookie": csrfCookie(csrf) },
  });
}

async function adminClientsPost(
  request: Request,
  env: RuntimeEnv,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
): Promise<Response> {
  const admin = await requireAdmin(request, env, config, store);
  if (admin instanceof Response) return admin;
  if (!requireSameOrigin(request))
    return html(
      errorPage("Invalid request", "Same-origin form submission is required"),
      { status: 403 },
    );
  const form = await readForm(request);
  if (!validCsrf(request, form))
    return html(errorPage("Invalid request", "CSRF validation failed"), {
      status: 403,
    });
  const action = form.get("action");
  if (action) {
    const clientId = form.get("client_id") || "";
    if (action === "disable")
      await store.setClientDisabled(clientId, nowSeconds());
    if (action === "enable") await store.setClientDisabled(clientId, null);
    if (action === "revoke_grants")
      await store.revokeClientGrants(clientId, nowSeconds());
    if (action === "rotate_secret") {
      const secret = randomToken(32);
      await store.rotateClientSecret(
        clientId,
        await sha256(secret),
        nowSeconds(),
      );
      const csrf = randomToken(24);
      return html(adminClientsPage(await store.listClients(), csrf, secret), {
        headers: { "set-cookie": csrfCookie(csrf) },
      });
    }
    const csrf = randomToken(24);
    return html(adminClientsPage(await store.listClients(), csrf, null), {
      headers: { "set-cookie": csrfCookie(csrf) },
    });
  }
  const input: ClientRegistrationInput = {
    type: form.get("type") === "confidential" ? "confidential" : "public",
    name: form.get("name") || "",
    redirectUris: splitLines(form.get("redirect_uris") || ""),
    scopes: parseScopes(form.get("scopes") || "openid email profile"),
    origins: splitLines(form.get("origins") || ""),
  };
  const result = await createClientRegistration(input, store, nowSeconds());
  const csrf = randomToken(24);
  return html(
    adminClientsPage(await store.listClients(), csrf, result.secret),
    { headers: { "set-cookie": csrfCookie(csrf) } },
  );
}

async function requireAdmin(
  request: Request,
  env: RuntimeEnv,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
): Promise<true | Response> {
  const identity = requireSitesIdentity(request, env);
  if (identity instanceof Response) return identity;
  if (!config.adminEmails.includes(identity.email))
    return html(
      errorPage(
        "Forbidden",
        "Administrative access is not allowed for this account",
      ),
      { status: 403 },
    );
  await store.findOrCreateUser(identity, nowSeconds());
  return true;
}

function validCsrf(request: Request, form: URLSearchParams): boolean {
  const cookie = parseCookies(request).get("sab_csrf");
  const value = form.get("csrf_token");
  return Boolean(cookie && value && cookie === value);
}

function redirectWithCode(
  redirectUri: string,
  code: string,
  state: string | null,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return redirect(url.toString());
}

function redirectWithError(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return redirect(url.toString());
}

function isBrokerRoute(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/health" ||
    pathname === "/.well-known/openid-configuration" ||
    pathname === "/.well-known/jwks.json" ||
    pathname === "/authorize" ||
    pathname.startsWith("/oauth/") ||
    pathname === "/userinfo" ||
    pathname === "/openapi.json" ||
    pathname === "/docs" ||
    pathname === "/device" ||
    pathname === "/device/decision" ||
    pathname === "/consent" ||
    pathname.startsWith("/admin/")
  );
}

function isCorsControlledRoute(pathname: string): boolean {
  return (
    pathname.startsWith("/oauth/") ||
    pathname === "/userinfo" ||
    pathname === "/openapi.json" ||
    pathname === "/.well-known/openid-configuration" ||
    pathname === "/.well-known/jwks.json"
  );
}

function needsStore(pathname: string): boolean {
  return ![
    "/",
    "/health",
    "/.well-known/openid-configuration",
    "/.well-known/jwks.json",
    "/openapi.json",
    "/docs",
  ].includes(pathname);
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

function parseJwtAudience(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const padded = payload
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded)) as { aud?: unknown };
    return typeof claims.aud === "string" ? claims.aud : null;
  } catch {
    return null;
  }
}
