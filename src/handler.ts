import { loadConfig } from "./config";
import { nowSeconds, publicJwk, randomToken, sha256 } from "./crypto";
import { D1AuthStore } from "./store/d1";
import type {
  RuntimeEnv,
  AuthStore,
  ClientRegistrationInput,
  ClientView,
  LocalUser,
  UpstreamIdentity,
} from "./types";
import {
  hasValidAdminSession,
  issueAdminSession,
  verifyAdminAccessKey,
} from "./admin-session";
import {
  requireSitesIdentity,
  sitesIdentityProvider,
  type UpstreamIdentityProvider,
} from "./identity";
import {
  addSecurityHeaders,
  acceptsHtml,
  acceptsJson,
  bearerToken,
  cors,
  csrfCookie,
  csrfTokenForRequest,
  csrfTokenMatches,
  html,
  hypermediaError,
  hypermediaJson,
  isJsonMediaType,
  javascript,
  json,
  oauthError,
  parseBasicAuth,
  readForm,
  redirect,
  requireSameOrigin,
  stylesheet,
} from "./http";
import {
  HYPERMEDIA_MEDIA_TYPE,
  HYPERMEDIA_API_VERSION,
  action,
  endpointActions,
  field,
  hypermediaNegotiationError,
  link,
  prefersVendorHypermedia,
  resourceDocument,
  type HypermediaAction,
} from "./hypermedia";
import { oidcConfiguration, openApiSpec } from "./openapi";
import { storageEndpoint } from "./storage";
import { storageBrowserEndpoint } from "./storage-browser";
import {
  hasBrowserSession,
  issueBrowserSessionAccessToken,
} from "./browser-session";
import { isBrowserSessionClientId } from "./system-client";
import {
  authorizationConsentDocument,
  deviceApprovalDocument,
  deviceDecisionDocument,
  deviceEntryDocument,
} from "./transaction-resources";
import {
  adminClientsPage,
  adminUnlockPage,
  authUiJs,
  authUiCss,
  consentPage,
  deviceConsentPage,
  deviceEntryPage,
  deviceOutcomePage,
  docsPage,
  errorPage,
  healthPage,
  sessionPage,
  serviceHomePage,
  statisticsPage,
} from "./pages";
import {
  authorizationFormPage,
  deviceAuthorizationFormPage,
  deviceAuthorizationResultPage,
  introspectionFormPage,
  operationResultPage,
  protocolErrorPage,
  revocationFormPage,
  structuredDataPage,
  tokenFormPage,
  tokenResultPage,
  userInfoFormPage,
} from "./protocol-pages";
import {
  approveAuthorizationRequest,
  authenticateClient,
  createAuthorizeRequest,
  createClientRegistration,
  createDeviceAuthorization,
  denyAuthorizationRequest,
  exchangeAuthorizationCode,
  normalizeUserCode,
  parseScopes,
  pollDeviceToken,
  rotateRefreshToken,
  verifyAccessToken,
} from "./oauth";

export interface AittaDBApp {
  fetch(request: Request): Promise<Response | null>;
}

const CLEANUP_INTERVAL_SECONDS = 60;
let nextCleanupAt = 0;

export async function createAittaDB(
  env: RuntimeEnv,
  ctx?: { waitUntil(promise: Promise<unknown>): void },
): Promise<AittaDBApp> {
  const fallbackUrl = env.ISSUER_URL ?? "https://aittadb.local";
  const config = loadConfig(env, fallbackUrl);
  const store = env.DB ? new D1AuthStore(env.DB) : null;
  return createAittaDBWithStore(env, store, config, ctx, sitesIdentityProvider);
}

export function createAittaDBWithStore(
  env: RuntimeEnv,
  store: AuthStore | null,
  config = loadConfig(env, env.ISSUER_URL ?? "https://aittadb.local"),
  ctx?: { waitUntil(promise: Promise<unknown>): void },
  identityProvider: UpstreamIdentityProvider = sitesIdentityProvider,
): AittaDBApp {
  return {
    async fetch(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const corsHeaders = isCorsControlledRoute(url.pathname)
        ? await corsHeadersForRequest(request, url, config, store)
        : new Headers();
      if (corsHeaders instanceof Response)
        return finalizeResponse(request, corsHeaders, config);
      if (request.method === "OPTIONS")
        return finalizeResponse(
          request,
          new Response(null, { status: 204 }),
          config,
          corsHeaders,
        );
      if (!isAittaDBRoute(url.pathname)) {
        if (isAssetRoute(url.pathname)) return null;
        return finalizeResponse(
          request,
          oauthError("not_found", "No AittaDB route matches this request", 404),
          config,
          corsHeaders,
        );
      }

      const negotiationError = usesApplicationNegotiation(request, url)
        ? hypermediaNegotiationError(request)
        : null;
      if (negotiationError) {
        return finalizeResponse(
          request,
          hypermediaError(request, "not_acceptable", negotiationError, 406),
          config,
          corsHeaders,
        );
      }

      try {
        if (!store && needsStore(url.pathname))
          return finalizeResponse(
            request,
            oauthError("database_unavailable", "Database is unavailable", 503),
            config,
            corsHeaders,
          );

        const routed = await route(
          request,
          url,
          env,
          store,
          config,
          identityProvider,
        );
        const finalized = await finalizeResponse(
          request,
          routed,
          config,
          corsHeaders,
        );
        if (store && needsStore(url.pathname)) {
          scheduleCleanup(store, ctx, nowSeconds());
        }
        return finalized;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unexpected error";
        if (message === "unsupported_media_type")
          return finalizeResponse(
            request,
            oauthError("invalid_request", "Unsupported content type", 415),
            config,
            corsHeaders,
          );
        if (message === "request_too_large")
          return finalizeResponse(
            request,
            oauthError("invalid_request", "Request is too large", 413),
            config,
            corsHeaders,
          );
        return finalizeResponse(
          request,
          oauthError("server_error", "Unexpected server error", 500),
          config,
          corsHeaders,
        );
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
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  if (url.pathname === "/" && request.method === "GET") {
    const identity = identityProvider.read(request);
    const signedIn = Boolean(identity);
    const showAdmin = Boolean(
      identity &&
      config.adminAccessKeyHash &&
      config.adminEmails.includes(identity.email),
    );
    const metadata = {
      service: "AittaDB",
      description:
        "A hosted application backend for third-party apps, with ChatGPT sign-in inside ChatGPT Sites, AittaDB-issued sessions, isolated JSON records, and file storage.",
      hostingPlatform: "OpenAI-hosted ChatGPT Sites",
      issuer: config.issuerUrl,
      docs: `${config.issuerUrl}/docs`,
      openapi: `${config.issuerUrl}/openapi.json`,
      officialOpenAIProduct: false,
      upstreamSignIn: {
        source: "ChatGPT sign-in inside ChatGPT Sites",
        identitySignal: "server-side email and optional display name",
        stableSubjectSupplied: false,
        credentialsForwarded: false,
      },
      sessionIssuer: "AittaDB",
      capabilities: [
        "ChatGPT sign-in inside ChatGPT Sites mapped to a separate AittaDB user",
        "AittaDB-issued OAuth 2.0, OpenID Connect, and JWT sessions",
        "D1-backed JSON records isolated by AittaDB user and client",
        "R2-backed files with D1 metadata isolated by AittaDB user and client",
      ],
      plannedCapabilities: ["Persistent events and long-polling delivery"],
    };
    const endpoints = endpointActions(config.issuerUrl);
    const links = [
      link("self", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
      link("health", `${config.issuerUrl}/health`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("statistics", `${config.issuerUrl}/statistics`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("session", `${config.issuerUrl}/session`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("storage-records", `${config.issuerUrl}/storage/records`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("storage-files", `${config.issuerUrl}/storage/files`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("documentation", `${config.issuerUrl}/docs`, { type: "text/html" }),
      link("describedby", `${config.issuerUrl}/openapi.json`, {
        type: "application/json",
      }),
      link(
        "openid-configuration",
        `${config.issuerUrl}/.well-known/openid-configuration`,
        { type: "application/json" },
      ),
      link("jwks", `${config.issuerUrl}/.well-known/jwks.json`, {
        type: "application/json",
      }),
      link("oauth-authorization", endpoints.authorize.href, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("oauth-device-authorization", endpoints.deviceAuthorization.href, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("oauth-token", endpoints.token.href, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      ...(showAdmin
        ? [
            link("client-administration", `${config.issuerUrl}/admin/clients`, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
          ]
        : []),
    ];
    const actions = [
      action(
        signedIn ? "sign-out" : "begin-session",
        signedIn ? "Sign out" : "Sign in to AittaDB",
        "GET",
        signedIn
          ? `${config.issuerUrl}/signout-with-chatgpt?return_to=%2F`
          : `${config.issuerUrl}/session`,
        { authorization: { scheme: "sites-session" }, fields: [] },
      ),
      action(
        "read-statistics",
        "View service statistics",
        "GET",
        `${config.issuerUrl}/statistics`,
        { authorization: { scheme: "none" }, fields: [] },
      ),
      ...(signedIn
        ? [
            action(
              "open-records",
              "Open JSON records",
              "GET",
              `${config.issuerUrl}/storage/records`,
              { authorization: { scheme: "sites-session" }, fields: [] },
            ),
            action(
              "open-files",
              "Open file storage",
              "GET",
              `${config.issuerUrl}/storage/files`,
              { authorization: { scheme: "sites-session" }, fields: [] },
            ),
          ]
        : []),
      ...(showAdmin
        ? [
            action(
              "manage-clients",
              "Manage OAuth clients",
              "GET",
              `${config.issuerUrl}/admin/clients`,
              { authorization: { scheme: "sites-session" }, fields: [] },
            ),
          ]
        : []),
    ];
    const document = resourceDocument({
      type: "service",
      id: config.issuerUrl,
      data: metadata,
      links,
      actions,
    });
    return acceptsHtml(request)
      ? html(serviceHomePage(metadata, { showAdmin, signedIn }))
      : hypermediaJson(request, document);
  }
  if (url.pathname === "/health" && request.method === "GET") {
    const status = {
      ok: true,
      service: "aittadb",
      d1: Boolean(store),
      r2: Boolean(env.BUCKET),
    };
    const document = resourceDocument({
      type: "health",
      id: `${config.issuerUrl}/health`,
      data: status,
      links: [
        link("self", `${config.issuerUrl}/health`, {
          type: HYPERMEDIA_MEDIA_TYPE,
        }),
        link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
        link("documentation", `${config.issuerUrl}/docs`, {
          type: "text/html",
        }),
      ],
    });
    return acceptsHtml(request)
      ? html(healthPage(status))
      : hypermediaJson(request, document);
  }
  if (url.pathname === "/auth-ui.css" && request.method === "GET") {
    return stylesheet(authUiCss());
  }
  if (url.pathname === "/auth-ui.js" && request.method === "GET") {
    return javascript(authUiJs());
  }
  if (
    url.pathname === "/.well-known/openid-configuration" &&
    request.method === "GET"
  ) {
    const configuration = oidcConfiguration(config.issuerUrl);
    return prefersRawJson(request, url)
      ? json(configuration)
      : html(
          structuredDataPage({
            title: "OpenID configuration",
            eyebrow: "Issuer discovery",
            summary:
              "Published OpenID Provider metadata for this independent AittaDB issuer.",
            payload: configuration,
            rawHref: "/.well-known/openid-configuration?format=json",
            visualHeading: "Every endpoint begins with one issuer.",
          }),
        );
  }
  if (url.pathname === "/.well-known/jwks.json" && request.method === "GET") {
    const jwks = { keys: [publicJwk(config.jwtPrivateJwk, config.jwtKeyId)] };
    return prefersRawJson(request, url)
      ? json(jwks)
      : html(
          structuredDataPage({
            title: "JSON Web Key Set",
            eyebrow: "ES256 verification keys",
            summary:
              "Public P-256 key material for validating JWTs issued by this AittaDB deployment.",
            payload: jwks,
            rawHref: "/.well-known/jwks.json?format=json",
            visualHeading: "Public verification without private key exposure.",
          }),
        );
  }
  if (url.pathname === "/openapi.json" && request.method === "GET") {
    const specification = {
      ...openApiSpec,
      servers: [{ url: config.issuerUrl }],
    };
    return prefersRawJson(request, url)
      ? json(specification)
      : html(
          structuredDataPage({
            title: "OpenAPI document",
            eyebrow: "OpenAPI 3.1",
            summary:
              "Canonical machine-readable contract for the AittaDB HTTP service.",
            payload: specification,
            rawHref: "/openapi.json?format=json",
            visualHeading:
              "One canonical contract. Two useful representations.",
          }),
        );
  }
  if (url.pathname === "/docs" && request.method === "GET")
    return html(docsPage());

  if (!store)
    return oauthError("database_unavailable", "Database is unavailable", 503);

  if (url.pathname === "/statistics" && request.method === "GET") {
    const identityCount = await store.countUsers();
    const document = resourceDocument({
      type: "service-statistics",
      id: `${config.issuerUrl}/statistics`,
      data: { identity_count: identityCount },
      links: [
        link("self", `${config.issuerUrl}/statistics`, {
          type: HYPERMEDIA_MEDIA_TYPE,
        }),
        link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
        link("documentation", `${config.issuerUrl}/docs`, {
          type: "text/html",
        }),
      ],
    });
    const response = acceptsHtml(request)
      ? html(statisticsPage(identityCount))
      : hypermediaJson(request, document);
    response.headers.set("cache-control", "no-store");
    return response;
  }

  if (url.pathname === "/session" && request.method === "GET") {
    return localSessionEndpoint(request, store, config, identityProvider);
  }
  if (url.pathname === "/authorize" && request.method === "GET") {
    if (!url.searchParams.has("client_id")) {
      return acceptsHtml(request)
        ? html(authorizationFormPage())
        : hypermediaJson(
            request,
            protocolEndpointDocument(
              "authorization-endpoint",
              endpointActions(config.issuerUrl).authorize,
              config.issuerUrl,
            ),
          );
    }
    const limited = await endpointRateLimit(
      store,
      request,
      config,
      "authorize",
      30,
    );
    return limited ?? createAuthorizeRequest(url, config, store);
  }
  if (
    url.pathname === "/oauth/device_authorization" &&
    request.method === "GET"
  ) {
    return acceptsHtml(request)
      ? browserFormPage(request, deviceAuthorizationFormPage)
      : hypermediaJson(
          request,
          protocolEndpointDocument(
            "device-authorization-endpoint",
            endpointActions(config.issuerUrl).deviceAuthorization,
            config.issuerUrl,
          ),
        );
  }
  if (
    url.pathname === "/oauth/device_authorization" &&
    request.method === "POST"
  ) {
    const form = await readForm(request);
    const browser = isBrowserUiForm(form);
    if (browser) {
      const rejected = rejectInvalidBrowserForm(
        request,
        form,
        config.issuerUrl,
      );
      if (rejected) return rejected;
    }
    const limited = await endpointRateLimit(
      store,
      request,
      config,
      "device",
      30,
    );
    if (limited) return limited;
    const response = await createDeviceAuthorization(
      request,
      form,
      config,
      store,
    );
    return browser
      ? browserJsonResponse(
          response,
          deviceAuthorizationResultPage,
          "/oauth/device_authorization",
        )
      : response;
  }
  if (url.pathname === "/oauth/token" && request.method === "GET") {
    return acceptsHtml(request)
      ? browserFormPage(request, tokenFormPage)
      : hypermediaJson(
          request,
          protocolEndpointDocument(
            "token-endpoint",
            endpointActions(config.issuerUrl).token,
            config.issuerUrl,
          ),
        );
  }
  if (url.pathname === "/oauth/token" && request.method === "POST") {
    const form = await readForm(request);
    const browser = isBrowserUiForm(form);
    if (browser) {
      const rejected = rejectInvalidBrowserForm(
        request,
        form,
        config.issuerUrl,
      );
      if (rejected) return rejected;
    }
    const response = await tokenEndpoint(request, config, store, form);
    return browser
      ? browserJsonResponse(response, tokenResultPage, "/oauth/token")
      : response;
  }
  if (url.pathname === "/oauth/revoke" && request.method === "GET") {
    return acceptsHtml(request)
      ? browserFormPage(request, revocationFormPage)
      : hypermediaJson(
          request,
          protocolEndpointDocument(
            "revocation-endpoint",
            endpointActions(config.issuerUrl).revoke,
            config.issuerUrl,
          ),
        );
  }
  if (url.pathname === "/oauth/revoke" && request.method === "POST") {
    const limited = await endpointRateLimit(
      store,
      request,
      config,
      "revoke",
      60,
    );
    if (limited) return limited;
    const form = await readForm(request);
    const browser = isBrowserUiForm(form);
    if (browser) {
      const rejected = rejectInvalidBrowserForm(
        request,
        form,
        config.issuerUrl,
      );
      if (rejected) return rejected;
    }
    const response = await revokeEndpoint(request, config, store, form);
    return browser
      ? browserJsonResponse(
          response,
          (payload) =>
            operationResultPage({
              title: "Revocation accepted",
              eyebrow: "OAuth 2.0 revocation",
              summary:
                "The production revocation endpoint accepted the request without disclosing prior token state.",
              payload,
              tone: "success",
              actions: [
                { href: "/oauth/revoke", label: "Revoke another token" },
                {
                  href: "/oauth/introspect",
                  label: "Open introspection",
                  secondary: true,
                },
              ],
            }),
          "/oauth/revoke",
        )
      : response;
  }
  if (url.pathname === "/oauth/introspect" && request.method === "GET") {
    return acceptsHtml(request)
      ? browserFormPage(request, introspectionFormPage)
      : hypermediaJson(
          request,
          protocolEndpointDocument(
            "introspection-endpoint",
            endpointActions(config.issuerUrl).introspect,
            config.issuerUrl,
          ),
        );
  }
  if (url.pathname === "/oauth/introspect" && request.method === "POST") {
    const limited = await endpointRateLimit(
      store,
      request,
      config,
      "introspect",
      120,
    );
    if (limited) return limited;
    const form = await readForm(request);
    const browser = isBrowserUiForm(form);
    if (browser) {
      const rejected = rejectInvalidBrowserForm(
        request,
        form,
        config.issuerUrl,
      );
      if (rejected) return rejected;
    }
    const response = await introspectEndpoint(request, config, store, form);
    return browser
      ? browserJsonResponse(
          response,
          (payload) =>
            operationResultPage({
              title: "Introspection result",
              eyebrow: "OAuth 2.0 introspection",
              summary:
                "The production introspection endpoint returned this client-bound token state.",
              payload,
              actions: [
                { href: "/oauth/introspect", label: "Inspect another token" },
                {
                  href: "/oauth/revoke",
                  label: "Open revocation",
                  secondary: true,
                },
              ],
            }),
          "/oauth/introspect",
        )
      : response;
  }
  if (url.pathname === "/userinfo" && request.method === "GET") {
    if (!bearerToken(request) && acceptsHtml(request)) {
      return browserFormPage(request, (csrf) =>
        userInfoFormPage(csrf, hasBrowserSession(request, identityProvider)),
      );
    }
    if (!bearerToken(request) && acceptsJson(request)) {
      const csrf = csrfTokenForRequest(request);
      const signedIn = hasBrowserSession(request, identityProvider);
      const operations: HypermediaAction[] = [
        endpointActions(config.issuerUrl).userInfo,
        ...(signedIn
          ? [
              action(
                "read-userinfo-with-session",
                "Read current identity claims",
                "POST",
                `${config.issuerUrl}/userinfo`,
                {
                  type: "application/x-www-form-urlencoded",
                  authorization: { scheme: "sites-session" },
                  fields: [
                    field("ui", "Browser operation", "string", "body", {
                      required: true,
                      value: "1",
                    }),
                    field("csrf_token", "CSRF token", "string", "body", {
                      required: true,
                      secret: true,
                      value: csrf,
                    }),
                    field("auth_mode", "Authentication", "string", "body", {
                      required: true,
                      value: "session",
                      options: [
                        {
                          value: "session",
                          title: "Current signed-in session",
                        },
                      ],
                    }),
                  ],
                },
              ),
            ]
          : [
              action(
                "begin-session",
                "Sign in to AittaDB",
                "GET",
                `${config.issuerUrl}/session`,
                { authorization: { scheme: "none" }, fields: [] },
              ),
            ]),
      ];
      return hypermediaJson(
        request,
        protocolEndpointDocument(
          "userinfo-endpoint",
          operations,
          config.issuerUrl,
        ),
        signedIn ? { headers: { "set-cookie": csrfCookie(csrf) } } : undefined,
      );
    }
    const response = await userInfoEndpoint(request, config, store);
    return acceptsHtml(request)
      ? browserJsonResponse(
          response,
          (payload) =>
            operationResultPage({
              title: "UserInfo claims",
              eyebrow: "OpenID Connect UserInfo",
              summary:
                "Claims returned by the production UserInfo service for the supplied AittaDB access token and local scopes.",
              payload,
              actions: [
                { href: "/userinfo", label: "Inspect another token" },
                { href: "/session", label: "My session", secondary: true },
              ],
            }),
          "/userinfo",
        )
      : response;
  }
  if (url.pathname === "/userinfo" && request.method === "POST") {
    const form = await readForm(request);
    if (!isBrowserUiForm(form)) return methodNotAllowed("GET");
    const rejected = rejectInvalidBrowserForm(request, form, config.issuerUrl);
    if (rejected) return rejected;
    const submittedToken = form.get("access_token") || "";
    const useSession =
      form.get("auth_mode") === "session" ||
      (!form.has("auth_mode") && !submittedToken);
    const accessToken = useSession
      ? await issueBrowserSessionAccessToken(
          request,
          identityProvider,
          store,
          config,
          ["openid", "email", "profile"],
        )
      : submittedToken;
    if (accessToken instanceof Response) return accessToken;
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    headers.delete("content-type");
    const response = await userInfoEndpoint(
      new Request(request.url, { method: "GET", headers }),
      config,
      store,
    );
    return acceptsHtml(request)
      ? browserJsonResponse(
          response,
          (payload) =>
            operationResultPage({
              title: "UserInfo claims",
              eyebrow: "OpenID Connect UserInfo",
              summary:
                "Claims returned by the production UserInfo service for the supplied AittaDB access token and local scopes.",
              payload,
              actions: [
                { href: "/userinfo", label: "Inspect another token" },
                { href: "/session", label: "My session", secondary: true },
              ],
            }),
          "/userinfo",
        )
      : response;
  }
  if (url.pathname.startsWith("/storage/")) {
    const limited = await endpointRateLimit(
      store,
      request,
      config,
      "storage",
      240,
    );
    if (limited) return limited;
    const browserResponse = await storageBrowserEndpoint(
      request,
      url,
      env,
      store,
      config,
      identityProvider,
    );
    if (browserResponse) return browserResponse;
    return storageEndpoint(request, url, env, store, config);
  }
  if (url.pathname === "/device" && request.method === "GET") {
    const csrf = csrfTokenForRequest(request);
    const headers = new Headers({ "set-cookie": csrfCookie(csrf) });
    const userCode = url.searchParams.get("user_code") || "";
    return acceptsHtml(request)
      ? html(deviceEntryPage(userCode, csrf), { headers })
      : hypermediaJson(
          request,
          deviceEntryDocument(config.issuerUrl, csrf, userCode),
          { headers },
        );
  }
  if (url.pathname === "/device" && request.method === "POST") {
    return deviceEntryPost(request, store, config, identityProvider);
  }
  if (url.pathname === "/device/decision" && request.method === "POST") {
    return deviceDecisionPost(request, store, config, identityProvider);
  }
  if (url.pathname === "/consent" && request.method === "GET") {
    return consentGet(request, store, config, identityProvider);
  }
  if (url.pathname === "/consent" && request.method === "POST") {
    return consentPost(request, store, config, identityProvider);
  }
  if (url.pathname === "/admin/clients" && request.method === "GET") {
    return adminClientsGet(request, config, store, identityProvider);
  }
  if (url.pathname === "/admin/clients" && request.method === "POST") {
    return adminClientsPost(request, config, store, identityProvider);
  }
  return oauthError("not_found", "No AittaDB route matches this request", 404);
}

async function localSessionEndpoint(
  request: Request,
  store: AuthStore,
  config: ReturnType<typeof loadConfig>,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  const identity = identityProvider.read(request);
  if (!identity) {
    if (acceptsHtml(request))
      return requireSitesIdentity(request, identityProvider) as Response;
    return oauthError(
      "login_required",
      "ChatGPT sign-in inside ChatGPT Sites is required for this browser session",
      401,
      {
        links: [
          link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
          link(
            "sign-in",
            `${config.issuerUrl}/signin-with-chatgpt?return_to=%2Fsession`,
            { type: "text/html" },
          ),
          link("documentation", `${config.issuerUrl}/docs`, {
            type: "text/html",
          }),
        ],
        actions: [
          action(
            "begin-session",
            "Sign in to AittaDB",
            "GET",
            `${config.issuerUrl}/session`,
            { authorization: { scheme: "sites-session" }, fields: [] },
          ),
        ],
      },
    );
  }

  const user = await store.findOrCreateUser(identity, nowSeconds());
  const isAdmin = Boolean(
    config.adminAccessKeyHash &&
    (config.adminSubjects.includes(user.id) ||
      config.adminEmails.includes(identity.email)),
  );
  const csrf = csrfTokenForRequest(request);
  const session = {
    authenticated: true,
    user: {
      sub: user.id,
      email: user.email,
      name: user.displayName,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
    },
    upstreamSignIn: "ChatGPT sign-in inside ChatGPT Sites",
    sessionIssuer: "AittaDB",
    credentialsForwarded: false,
  };
  const document = resourceDocument({
    type: "local-session",
    id: user.id,
    data: session,
    links: [
      link("self", `${config.issuerUrl}/session`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
      link("userinfo", `${config.issuerUrl}/userinfo`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("storage-records", `${config.issuerUrl}/storage/records`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("storage-files", `${config.issuerUrl}/storage/files`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      ...(isAdmin
        ? [
            link("client-administration", `${config.issuerUrl}/admin/clients`, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
          ]
        : []),
      link(
        "sign-out",
        `${config.issuerUrl}/signout-with-chatgpt?return_to=%2F`,
        { type: "text/html" },
      ),
    ],
    actions: [
      action(
        "read-userinfo-with-session",
        "Read current identity claims",
        "POST",
        `${config.issuerUrl}/userinfo`,
        {
          type: "application/x-www-form-urlencoded",
          authorization: { scheme: "sites-session" },
          fields: [
            field("ui", "Browser operation", "string", "body", {
              required: true,
              value: "1",
            }),
            field("csrf_token", "CSRF token", "string", "body", {
              required: true,
              secret: true,
              value: csrf,
            }),
            field("auth_mode", "Authentication", "string", "body", {
              required: true,
              value: "session",
              options: [
                { value: "session", title: "Current signed-in session" },
              ],
            }),
          ],
        },
      ),
      action(
        "manage-session-records",
        "Manage JSON records",
        "GET",
        `${config.issuerUrl}/storage/records`,
        { authorization: { scheme: "sites-session" }, fields: [] },
      ),
      action(
        "manage-session-files",
        "Manage files",
        "GET",
        `${config.issuerUrl}/storage/files`,
        { authorization: { scheme: "sites-session" }, fields: [] },
      ),
      ...(isAdmin
        ? [
            action(
              "manage-clients",
              "Manage OAuth clients",
              "GET",
              `${config.issuerUrl}/admin/clients`,
              { authorization: { scheme: "sites-session" }, fields: [] },
            ),
          ]
        : []),
      action(
        "sign-out",
        "Sign out",
        "GET",
        `${config.issuerUrl}/signout-with-chatgpt?return_to=%2F`,
        { authorization: { scheme: "sites-session" }, fields: [] },
      ),
    ],
  });
  return acceptsHtml(request)
    ? html(sessionPage(user, isAdmin))
    : hypermediaJson(request, document, {
        headers: { "set-cookie": csrfCookie(csrf) },
      });
}

async function finalizeResponse(
  request: Request,
  response: Response,
  config: ReturnType<typeof loadConfig>,
  corsHeaders = new Headers(),
): Promise<Response> {
  const applicationResponse = negotiateApplicationError(request, response);
  const negotiated = await negotiateBrowserError(request, applicationResponse);
  const headers = new Headers(negotiated.headers);
  for (const [key, value] of corsHeaders.entries()) headers.set(key, value);
  addSecurityHeaders(headers);
  if (config.isProduction && new URL(config.issuerUrl).protocol === "https:") {
    headers.set(
      "strict-transport-security",
      "max-age=31536000; includeSubDomains",
    );
  }
  return new Response(negotiated.body, {
    status: negotiated.status,
    statusText: negotiated.statusText,
    headers,
  });
}

function negotiateApplicationError(
  request: Request,
  response: Response,
): Response {
  if (
    response.status < 400 ||
    !usesApplicationErrorNegotiation(request) ||
    !prefersVendorHypermedia(request) ||
    !isJsonMediaType(response.headers.get("content-type") ?? "")
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set(
    "content-type",
    `${HYPERMEDIA_MEDIA_TYPE}; version=${HYPERMEDIA_API_VERSION}; charset=utf-8`,
  );
  headers.set("aittadb-api-version", HYPERMEDIA_API_VERSION);
  const vary = (headers.get("vary") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!vary.some((value) => value.toLowerCase() === "accept")) {
    vary.push("Accept");
  }
  headers.set("vary", vary.join(", "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function negotiateBrowserError(
  request: Request,
  response: Response,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (
    response.status < 400 ||
    !acceptsHtml(request) ||
    !isJsonMediaType(contentType)
  ) {
    return response;
  }

  const payload = await response
    .clone()
    .json()
    .catch(() => null);
  const error =
    payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : "request_failed";
  const description =
    payload &&
    typeof payload === "object" &&
    "error_description" in payload &&
    typeof (payload as { error_description: unknown }).error_description ===
      "string"
      ? (payload as { error_description: string }).error_description
      : statusText(response.status);

  return html(
    errorPage(titleForError(error, response.status), description, {
      status: response.status,
      error,
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}

function titleForError(error: string, status: number): string {
  if (status === 404 || error === "not_found") return "Not found";
  if (status === 403) return "Forbidden";
  if (status === 401 || error === "invalid_client")
    return "Authentication failed";
  if (error === "slow_down") return "Slow down";
  if (error === "authorization_pending") return "Authorization pending";
  if (error === "access_denied") return "Access denied";
  if (error === "expired_token") return "Expired token";
  if (status >= 500) return "Service unavailable";
  return "Invalid request";
}

function statusText(status: number): string {
  if (status === 400) return "The request could not be accepted.";
  if (status === 401) return "Authentication is required.";
  if (status === 403)
    return "This account is not allowed to perform that action.";
  if (status === 404) return "The requested resource was not found.";
  if (status === 413) return "The request body is too large.";
  if (status === 415) return "The content type is not supported.";
  if (status === 429) return "Too many requests. Please wait and try again.";
  if (status >= 500) return "The service could not complete the request.";
  return "The request failed.";
}

function prefersRawJson(request: Request, url: URL): boolean {
  return url.searchParams.get("format") === "json" || !acceptsHtml(request);
}

function protocolEndpointDocument(
  type: string,
  operation: HypermediaAction | readonly HypermediaAction[],
  issuer: string,
) {
  const operations = Array.isArray(operation) ? [...operation] : [operation];
  const primary = operations[0];
  if (!primary) throw new Error("Protocol endpoint requires an operation");
  return resourceDocument({
    type,
    id: primary.href,
    data: {
      title: primary.title,
      protocol_response:
        "Successful OAuth 2.0 and OpenID Connect wire responses remain standards-defined and are not wrapped in this resource document.",
    },
    links: [
      link("self", primary.href, { type: HYPERMEDIA_MEDIA_TYPE }),
      link("service", issuer, { type: HYPERMEDIA_MEDIA_TYPE }),
      link("documentation", `${issuer}/docs`, { type: "text/html" }),
      link("describedby", `${issuer}/openapi.json`, {
        type: "application/json",
      }),
    ],
    actions: operations,
  });
}

function browserFormPage(
  request: Request,
  renderer: (csrf: string) => string,
): Response {
  const csrf = csrfTokenForRequest(request);
  return html(renderer(csrf), {
    headers: { "set-cookie": csrfCookie(csrf) },
  });
}

function isBrowserUiForm(form: URLSearchParams): boolean {
  return form.get("ui") === "1";
}

function rejectInvalidBrowserForm(
  request: Request,
  form: URLSearchParams,
  canonicalOrigin: string,
): Response | null {
  if (!requireSameOrigin(request, canonicalOrigin)) {
    return html(
      errorPage("Invalid request", "Same-origin form submission is required", {
        status: 403,
      }),
      { status: 403 },
    );
  }
  if (!validCsrf(request, form)) {
    return html(
      errorPage("Invalid request", "CSRF validation failed", { status: 403 }),
      { status: 403 },
    );
  }
  return null;
}

async function browserJsonResponse(
  response: Response,
  successPage: (payload: Record<string, unknown>) => string,
  retryHref: string,
): Promise<Response> {
  if (!isJsonMediaType(response.headers.get("content-type") ?? ""))
    return response;
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  if (!payload) return response;
  const page =
    response.status >= 400
      ? protocolErrorPage(payload, response.status, retryHref)
      : successPage(payload);
  return html(page, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function methodNotAllowed(allowed: string): Response {
  const response = oauthError(
    "invalid_request",
    `Method not allowed; use ${allowed}`,
    405,
  );
  response.headers.set("allow", allowed);
  return response;
}

async function tokenEndpoint(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
  submittedForm?: URLSearchParams,
): Promise<Response> {
  const form = submittedForm ?? (await readForm(request));
  const [limited, corsHeaders] = await Promise.all([
    endpointRateLimit(store, request, config, "token", 120),
    tokenClientCorsHeaders(request, form, config, store),
  ]);
  if (corsHeaders instanceof Response) return corsHeaders;
  if (limited) return responseWithHeaders(limited, corsHeaders);
  const grantType = form.get("grant_type");
  if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
    return responseWithHeaders(
      await pollDeviceToken(request, form, config, store),
      corsHeaders,
    );
  }

  const client = await authenticateClient(request, form, store);
  if (client instanceof Response)
    return responseWithHeaders(client, corsHeaders);
  let response: Response;
  if (grantType === "authorization_code") {
    response = await exchangeAuthorizationCode(form, config, store, client);
  } else if (grantType === "refresh_token") {
    response = await rotateRefreshToken(form, config, store, client);
  } else {
    response = oauthError("unsupported_grant_type", "Unsupported grant type");
  }
  return responseWithHeaders(response, corsHeaders);
}

async function tokenClientCorsHeaders(
  request: Request,
  form: URLSearchParams,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
): Promise<Headers | Response> {
  const origin = request.headers.get("origin");
  if (!origin) return new Headers();
  const basic = parseBasicAuth(request);
  const clientId = basic?.username || form.get("client_id") || "";
  const client = clientId ? await store.getClient(clientId) : null;
  const allowedOrigins =
    client && !client.disabledAt && !isBrowserSessionClientId(client.id)
      ? client.origins
      : [];
  return cors(request, allowedOrigins, config.issuerUrl);
}

function responseWithHeaders(response: Response, extra: Headers): Response {
  if ([...extra].length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of extra) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function revokeEndpoint(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
  submittedForm?: URLSearchParams,
): Promise<Response> {
  const form = submittedForm ?? (await readForm(request));
  const client = await authenticateClient(request, form, store);
  if (client instanceof Response) return client;
  const token = form.get("token") || "";
  const hint = form.get("token_type_hint");
  const hash = await sha256(token);
  const now = nowSeconds();
  const revokeRefresh = () => store.revokeRefreshToken(hash, client.id, now);
  const revokeAccess = async (): Promise<boolean> => {
    try {
      const verified = await verifyAccessToken(token, config, store, client.id);
      await store.revokeAccessTokenJti(
        verified.claims.jti,
        verified.claims.exp,
        now,
      );
      return true;
    } catch {
      return false;
    }
  };
  if (hint === "access_token") {
    if (!(await revokeAccess())) await revokeRefresh();
  } else if (hint === "refresh_token") {
    if (!(await revokeRefresh())) await revokeAccess();
  } else if (!(await revokeRefresh())) {
    await revokeAccess();
  }
  return json({});
}

async function introspectEndpoint(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
  submittedForm?: URLSearchParams,
): Promise<Response> {
  const form = submittedForm ?? (await readForm(request));
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
    const client = await store.getClient(audience);
    if (!user || !client || client.disabledAt)
      return oauthError("invalid_token", "Invalid token", 401);
    const scopes = parseScopes(String(verified.claims.scope || ""));
    if (!scopes.includes("openid"))
      return oauthError("invalid_token", "Invalid token", 401);
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
  store: AuthStore,
  config: ReturnType<typeof loadConfig>,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  if (!requireSameOrigin(request, config.issuerUrl))
    return negotiatedFormError(
      request,
      "invalid_request",
      "Same-origin form submission is required",
      403,
    );
  const form = await readForm(request);
  if (!validCsrf(request, form))
    return negotiatedFormError(
      request,
      "invalid_request",
      "CSRF validation failed",
      403,
    );
  const userCode = form.get("user_code") || "";
  const grant = await store.getDeviceGrantByUserCodeHash(
    await sha256(normalizeUserCode(userCode)),
  );
  if (!grant || grant.expiresAt <= nowSeconds()) {
    const csrf = csrfTokenForRequest(request);
    if (acceptsHtml(request)) {
      return html(
        deviceEntryPage(userCode, csrf, "Invalid or expired user code"),
        { status: 400, headers: { "set-cookie": csrfCookie(csrf) } },
      );
    }
    const retry = deviceEntryDocument(config.issuerUrl, csrf, userCode);
    return oauthError("invalid_request", "Invalid or expired user code", 400, {
      links: retry.links,
      actions: retry.actions,
    });
  }
  grant.userCodeDisplay = normalizeUserCode(userCode);
  const identity = requireTransactionIdentity(
    request,
    identityProvider,
    config.issuerUrl,
  );
  if (identity instanceof Response) return identity;
  const client = await store.getClient(grant.clientId);
  if (!client || isBrowserSessionClientId(client.id))
    return negotiatedFormError(
      request,
      "invalid_request",
      "Client is unavailable",
      400,
    );
  if (grant.status !== "pending") {
    return acceptsHtml(request)
      ? html(deviceOutcomePage(grant.status))
      : hypermediaJson(
          request,
          deviceDecisionDocument(config.issuerUrl, grant.status),
        );
  }
  const csrf = csrfTokenForRequest(request);
  const headers = { "set-cookie": csrfCookie(csrf) };
  return acceptsHtml(request)
    ? html(deviceConsentPage(grant, client, csrf), { headers })
    : hypermediaJson(
        request,
        deviceApprovalDocument(config.issuerUrl, grant, client, csrf),
        { headers },
      );
}

async function deviceDecisionPost(
  request: Request,
  store: AuthStore,
  config: ReturnType<typeof loadConfig>,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  if (!requireSameOrigin(request, config.issuerUrl))
    return negotiatedFormError(
      request,
      "invalid_request",
      "Same-origin form submission is required",
      403,
    );
  const form = await readForm(request);
  if (!validCsrf(request, form))
    return negotiatedFormError(
      request,
      "invalid_request",
      "CSRF validation failed",
      403,
    );
  const identity = requireTransactionIdentity(
    request,
    identityProvider,
    config.issuerUrl,
  );
  if (identity instanceof Response) return identity;
  const grant = await store.getDeviceGrantByUserCodeHash(
    await sha256(normalizeUserCode(form.get("user_code") || "")),
  );
  if (
    !grant ||
    isBrowserSessionClientId(grant.clientId) ||
    grant.status !== "pending" ||
    grant.expiresAt <= nowSeconds()
  ) {
    return negotiatedFormError(
      request,
      "invalid_request",
      "Device request is no longer pending",
      400,
    );
  }
  const now = nowSeconds();
  const status = form.get("decision") === "approve" ? "approved" : "denied";
  const user =
    status === "approved" ? await store.findOrCreateUser(identity, now) : null;
  const updated = await store.transitionDeviceGrant(
    grant.userCodeHash,
    status,
    user?.id ?? null,
    now,
  );
  if (!updated)
    return negotiatedFormError(
      request,
      "invalid_request",
      "Device request is no longer pending",
      400,
    );
  return acceptsHtml(request)
    ? html(deviceOutcomePage(status))
    : hypermediaJson(request, deviceDecisionDocument(config.issuerUrl, status));
}

async function consentGet(
  request: Request,
  store: AuthStore,
  config: ReturnType<typeof loadConfig>,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  const identity = requireTransactionIdentity(
    request,
    identityProvider,
    config.issuerUrl,
  );
  if (identity instanceof Response) return identity;
  const requestId = new URL(request.url).searchParams.get("request_id") || "";
  const authRequest = await store.getAuthorizationRequest(requestId);
  if (
    !authRequest ||
    authRequest.status !== "pending" ||
    authRequest.expiresAt <= nowSeconds()
  )
    return negotiatedFormError(
      request,
      "invalid_request",
      "Authorization request expired",
      400,
    );
  const client = await store.getClient(authRequest.clientId);
  if (!client || isBrowserSessionClientId(client.id))
    return negotiatedFormError(
      request,
      "invalid_request",
      "Client is unavailable",
      400,
    );
  const user = await store.findOrCreateUser(identity, nowSeconds());
  if (await store.hasConsent(user.id, client.id, authRequest.scope)) {
    const code = await approveAuthorizationRequest(
      authRequest,
      user,
      store,
      nowSeconds(),
    );
    if (!code)
      return negotiatedFormError(
        request,
        "invalid_request",
        "Authorization request is no longer pending",
        400,
      );
    return redirectWithCode(authRequest.redirectUri, code, authRequest.state);
  }
  const csrf = csrfTokenForRequest(request);
  const headers = { "set-cookie": csrfCookie(csrf) };
  return acceptsHtml(request)
    ? html(consentPage(authRequest, client, csrf), { headers })
    : hypermediaJson(
        request,
        authorizationConsentDocument(
          config.issuerUrl,
          authRequest,
          client,
          csrf,
        ),
        { headers },
      );
}

async function consentPost(
  request: Request,
  store: AuthStore,
  config: ReturnType<typeof loadConfig>,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  if (!requireSameOrigin(request, config.issuerUrl))
    return negotiatedFormError(
      request,
      "invalid_request",
      "Same-origin form submission is required",
      403,
    );
  const form = await readForm(request);
  if (!validCsrf(request, form))
    return negotiatedFormError(
      request,
      "invalid_request",
      "CSRF validation failed",
      403,
    );
  const identity = requireTransactionIdentity(
    request,
    identityProvider,
    config.issuerUrl,
  );
  if (identity instanceof Response) return identity;
  const authRequest = await store.getAuthorizationRequest(
    form.get("request_id") || "",
  );
  if (
    !authRequest ||
    isBrowserSessionClientId(authRequest.clientId) ||
    authRequest.status !== "pending" ||
    authRequest.expiresAt <= nowSeconds()
  )
    return negotiatedFormError(
      request,
      "invalid_request",
      "Authorization request expired",
      400,
    );
  if (form.get("decision") !== "approve") {
    if (!(await denyAuthorizationRequest(authRequest, store, nowSeconds())))
      return negotiatedFormError(
        request,
        "invalid_request",
        "Authorization request is no longer pending",
        400,
      );
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
  if (!code)
    return negotiatedFormError(
      request,
      "invalid_request",
      "Authorization request is no longer pending",
      400,
    );
  return redirectWithCode(authRequest.redirectUri, code, authRequest.state);
}

async function adminClientsGet(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  const limited = await endpointRateLimit(store, request, config, "admin", 30);
  if (limited) return limited;
  const admin = await requireAdminIdentity(
    request,
    config,
    store,
    identityProvider,
  );
  if (admin instanceof Response) return admin;
  if (!(await hasAdminCredential(request, admin.user.id, config))) {
    return adminUnlockResponse(request);
  }
  const csrf = csrfTokenForRequest(request);
  return adminClientsResponse(
    request,
    config,
    await store.listClients(),
    csrf,
    null,
  );
}

async function adminClientsPost(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  const limited = await endpointRateLimit(store, request, config, "admin", 30);
  if (limited) return limited;
  const admin = await requireAdminIdentity(
    request,
    config,
    store,
    identityProvider,
  );
  if (admin instanceof Response) return admin;
  if (!requireSameOrigin(request, config.issuerUrl)) {
    return negotiatedFormError(
      request,
      "invalid_request",
      "Same-origin form submission is required",
      403,
    );
  }
  const form = await readForm(request);
  if (!validCsrf(request, form)) {
    return negotiatedFormError(
      request,
      "invalid_request",
      "CSRF validation failed",
      403,
    );
  }
  const action = form.get("action");
  if (action === "unlock") {
    if (
      !(await verifyAdminAccessKey(form.get("admin_access_key") || "", config))
    ) {
      await store.audit(
        "admin.session.rejected",
        { identity_source: admin.authorizationSource },
        nowSeconds(),
      );
      return adminUnlockResponse(request, 401);
    }
    const session = await issueAdminSession(
      admin.user.id,
      config,
      nowSeconds(),
    );
    await store.audit(
      "admin.session.created",
      { identity_source: admin.authorizationSource },
      nowSeconds(),
    );
    const response = redirect("/admin/clients", 303);
    response.headers.set("set-cookie", session.cookie);
    return response;
  }
  if (!(await hasAdminCredential(request, admin.user.id, config))) {
    return adminUnlockResponse(request, 401);
  }
  if (action) {
    const clientId = form.get("client_id") || "";
    if (isBrowserSessionClientId(clientId)) {
      return negotiatedFormError(
        request,
        "not_found",
        "Client is unavailable",
        404,
      );
    }
    if (
      !["disable", "enable", "revoke_grants", "rotate_secret"].includes(action)
    ) {
      return negotiatedFormError(
        request,
        "invalid_request",
        "Unsupported administrative action",
        400,
      );
    }
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
      const csrf = csrfTokenForRequest(request);
      await auditAdminMutation(store, action, clientId, admin);
      return adminClientsResponse(
        request,
        config,
        await store.listClients(),
        csrf,
        secret,
      );
    }
    await auditAdminMutation(store, action, clientId, admin);
    const csrf = csrfTokenForRequest(request);
    return adminClientsResponse(
      request,
      config,
      await store.listClients(),
      csrf,
      null,
    );
  }
  const input: ClientRegistrationInput = {
    type: form.get("type") === "confidential" ? "confidential" : "public",
    name: form.get("name") || "",
    redirectUris: splitLines(form.get("redirect_uris") || ""),
    scopes: parseScopes(
      form.get("scopes") ||
        "openid email profile offline_access storage.read storage.write storage.delete",
    ),
    origins: splitLines(form.get("origins") || ""),
  };
  const result = await createClientRegistration(input, store, nowSeconds());
  await auditAdminMutation(store, "create", result.client.id, admin);
  const csrf = csrfTokenForRequest(request);
  return adminClientsResponse(
    request,
    config,
    await store.listClients(),
    csrf,
    result.secret,
  );
}

async function requireAdminIdentity(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
  identityProvider: UpstreamIdentityProvider,
): Promise<
  | { user: LocalUser; authorizationSource: "subject" | "email-bootstrap" }
  | Response
> {
  if (!config.adminAccessKeyHash) {
    return oauthError(
      "admin_unavailable",
      "Administrative operations require a configured independent access key",
      503,
    );
  }
  const identity = identityProvider.read(request);
  if (!identity) {
    if (acceptsHtml(request))
      return requireSitesIdentity(request, identityProvider) as Response;
    return oauthError(
      "login_required",
      "ChatGPT sign-in inside ChatGPT Sites is required",
      401,
      {
        actions: [
          action(
            "begin-session",
            "Sign in to AittaDB",
            "GET",
            `${config.issuerUrl}/admin/clients`,
            { authorization: { scheme: "sites-session" }, fields: [] },
          ),
        ],
      },
    );
  }
  const user = await store.findOrCreateUser(identity, nowSeconds());
  const subjectAllowed = config.adminSubjects.includes(user.id);
  const emailBootstrapAllowed = config.adminEmails.includes(identity.email);
  if (!subjectAllowed && !emailBootstrapAllowed) {
    return acceptsHtml(request)
      ? html(
          errorPage(
            "Forbidden",
            "Administrative access is not allowed for this account",
            { status: 403, error: "forbidden" },
          ),
          { status: 403 },
        )
      : oauthError(
          "forbidden",
          "Administrative access is not allowed for this account",
          403,
        );
  }
  return {
    user,
    authorizationSource: subjectAllowed ? "subject" : "email-bootstrap",
  };
}

async function hasAdminCredential(
  request: Request,
  subject: string,
  config: ReturnType<typeof loadConfig>,
): Promise<boolean> {
  const headerKey = request.headers.get("x-aittadb-admin-key") || "";
  return (
    (await verifyAdminAccessKey(headerKey, config)) ||
    (await hasValidAdminSession(request, subject, config, nowSeconds()))
  );
}

function adminUnlockResponse(request: Request, status = 200): Response {
  if (!acceptsHtml(request)) {
    return oauthError(
      "admin_authentication_required",
      "Independent administrator authentication is required",
      401,
    );
  }
  const csrf = csrfTokenForRequest(request);
  return html(adminUnlockPage(csrf), {
    status,
    headers: { "set-cookie": csrfCookie(csrf) },
  });
}

async function auditAdminMutation(
  store: AuthStore,
  actionName: string,
  clientId: string,
  admin: {
    user: LocalUser;
    authorizationSource: "subject" | "email-bootstrap";
  },
): Promise<void> {
  await store.audit(
    "admin.client.mutated",
    {
      action: actionName,
      client_reference: await sha256(clientId),
      actor_subject_hash: await sha256(admin.user.id),
      identity_source: admin.authorizationSource,
    },
    nowSeconds(),
  );
}

function adminClientsResponse(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  clients: readonly ClientView[],
  csrf: string,
  newSecret: string | null,
): Response {
  const headers = { "set-cookie": csrfCookie(csrf) };
  if (acceptsHtml(request)) {
    return html(adminClientsPage(clients, csrf, newSecret), { headers });
  }
  return hypermediaJson(
    request,
    adminClientsDocument(config.issuerUrl, clients, csrf, newSecret),
    { headers },
  );
}

function adminClientsDocument(
  issuer: string,
  clients: readonly ClientView[],
  csrf: string,
  newSecret: string | null,
) {
  const operationFields = (clientId: string, operation: string) => [
    field("csrf_token", "CSRF token", "string", "body", {
      required: true,
      secret: true,
      value: csrf,
    }),
    field("action", "Action", "string", "body", {
      required: true,
      value: operation,
    }),
    field("client_id", "Client ID", "string", "body", {
      required: true,
      value: clientId,
    }),
  ];
  const actions: HypermediaAction[] = [
    action(
      "create-client",
      "Create OAuth client",
      "POST",
      `${issuer}/admin/clients`,
      {
        type: "application/x-www-form-urlencoded",
        authorization: { scheme: "sites-session" },
        fields: [
          field("csrf_token", "CSRF token", "string", "body", {
            required: true,
            secret: true,
            value: csrf,
          }),
          field("name", "Client display name", "string", "body", {
            required: true,
            max_length: 120,
          }),
          field("type", "Client type", "string", "body", {
            required: true,
            value: "public",
            options: [
              { value: "public", title: "Public" },
              { value: "confidential", title: "Confidential" },
            ],
          }),
          field("redirect_uris", "Exact redirect URIs", "string", "body", {
            required: true,
            description: "One URI per line.",
          }),
          field("scopes", "Allowed scopes", "string", "body", {
            required: true,
            value:
              "openid email profile offline_access storage.read storage.write storage.delete",
          }),
          field("origins", "Allowed browser origins", "string", "body", {
            description: "One exact origin per line.",
          }),
        ],
      },
    ),
  ];
  for (const client of clients) {
    actions.push(
      action(
        client.disabledAt ? "enable-client" : "disable-client",
        client.disabledAt ? `Enable ${client.name}` : `Disable ${client.name}`,
        "POST",
        `${issuer}/admin/clients`,
        {
          type: "application/x-www-form-urlencoded",
          authorization: { scheme: "sites-session" },
          fields: operationFields(
            client.id,
            client.disabledAt ? "enable" : "disable",
          ),
        },
      ),
      action(
        "revoke-client-grants",
        `Revoke grants for ${client.name}`,
        "POST",
        `${issuer}/admin/clients`,
        {
          type: "application/x-www-form-urlencoded",
          authorization: { scheme: "sites-session" },
          fields: operationFields(client.id, "revoke_grants"),
        },
      ),
    );
    if (client.type === "confidential") {
      actions.push(
        action(
          "rotate-client-secret",
          `Rotate secret for ${client.name}`,
          "POST",
          `${issuer}/admin/clients`,
          {
            type: "application/x-www-form-urlencoded",
            authorization: { scheme: "sites-session" },
            fields: operationFields(client.id, "rotate_secret"),
          },
        ),
      );
    }
  }
  return resourceDocument({
    type: "oauth-client-collection",
    id: `${issuer}/admin/clients`,
    data: {
      clients: clients.map((client) => ({
        id: client.id,
        name: client.name,
        type: client.type,
        disabled: client.disabledAt !== null,
        redirect_uris: [...client.redirectUris],
        scopes: [...client.scopes],
        origins: [...client.origins],
        created_at: client.createdAt,
      })),
      ...(newSecret
        ? { new_client_secret: newSecret, secret_displayed_once: true }
        : {}),
    },
    links: [
      link("self", `${issuer}/admin/clients`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("service", issuer, { type: HYPERMEDIA_MEDIA_TYPE }),
      link("documentation", `${issuer}/docs`, { type: "text/html" }),
    ],
    actions,
  });
}

function negotiatedFormError(
  request: Request,
  error: string,
  description: string,
  status: number,
): Response {
  return acceptsHtml(request)
    ? html(
        errorPage(titleForError(error, status), description, { status, error }),
        {
          status,
        },
      )
    : oauthError(error, description, status);
}

function requireTransactionIdentity(
  request: Request,
  identityProvider: UpstreamIdentityProvider,
  issuer: string,
): UpstreamIdentity | Response {
  const identity = identityProvider.read(request);
  if (identity) return identity;
  if (acceptsHtml(request))
    return requireSitesIdentity(request, identityProvider);

  const requestUrl = new URL(request.url);
  const returnTo = `${requestUrl.pathname}${requestUrl.search}`;
  const signIn = new URL("/signin-with-chatgpt", issuer);
  signIn.searchParams.set("return_to", returnTo);
  return oauthError(
    "login_required",
    "ChatGPT sign-in inside ChatGPT Sites is required",
    401,
    {
      links: [
        link("service", issuer, { type: HYPERMEDIA_MEDIA_TYPE }),
        link("sign-in", signIn.toString(), { type: "text/html" }),
      ],
      actions: [
        action("sign-in", "Sign in to continue", "GET", signIn.toString(), {
          authorization: { scheme: "none" },
          fields: [],
        }),
      ],
    },
  );
}

function validCsrf(request: Request, form: URLSearchParams): boolean {
  return csrfTokenMatches(request, form.get("csrf_token"));
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

export function isAittaDBRoute(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/health" ||
    pathname === "/statistics" ||
    pathname === "/session" ||
    pathname === "/auth-ui.css" ||
    pathname === "/auth-ui.js" ||
    pathname === "/.well-known/openid-configuration" ||
    pathname === "/.well-known/jwks.json" ||
    pathname === "/authorize" ||
    pathname.startsWith("/oauth/") ||
    pathname === "/userinfo" ||
    pathname.startsWith("/storage/") ||
    pathname === "/openapi.json" ||
    pathname === "/docs" ||
    pathname === "/device" ||
    pathname === "/device/decision" ||
    pathname === "/consent" ||
    pathname.startsWith("/admin/")
  );
}

export function isAssetRoute(pathname: string): boolean {
  return (
    pathname.startsWith("/_") ||
    pathname.startsWith("/cdn-cgi/") ||
    /\.[a-z0-9]{2,8}$/i.test(pathname)
  );
}

function usesApplicationNegotiation(request: Request, url: URL): boolean {
  const pathname = url.pathname;
  if (
    pathname === "/" ||
    pathname === "/health" ||
    pathname === "/statistics" ||
    pathname === "/session" ||
    pathname === "/device" ||
    pathname === "/device/decision" ||
    pathname === "/consent" ||
    pathname.startsWith("/admin/")
  ) {
    return true;
  }
  if (pathname === "/authorize") {
    return request.method === "GET" && !url.searchParams.has("client_id");
  }
  if (
    request.method === "GET" &&
    [
      "/oauth/device_authorization",
      "/oauth/token",
      "/oauth/revoke",
      "/oauth/introspect",
    ].includes(pathname)
  ) {
    return true;
  }
  if (pathname === "/userinfo") return !bearerToken(request);
  if (!pathname.startsWith("/storage/")) return false;
  if (
    request.method === "GET" &&
    pathname.startsWith("/storage/files/") &&
    !acceptsHtml(request) &&
    !acceptsJson(request)
  ) {
    return false;
  }
  return true;
}

function usesApplicationErrorNegotiation(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return (
    pathname === "/" ||
    pathname === "/health" ||
    pathname === "/statistics" ||
    pathname === "/session" ||
    pathname === "/device" ||
    pathname === "/device/decision" ||
    pathname === "/consent" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/storage/")
  );
}

function scheduleCleanup(
  store: AuthStore,
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  now: number,
): void {
  if (!ctx || now < nextCleanupAt) return;
  nextCleanupAt = now + CLEANUP_INTERVAL_SECONDS;
  ctx.waitUntil(store.cleanup(now));
}

function isCorsControlledRoute(pathname: string): boolean {
  return (
    pathname === "/statistics" ||
    pathname.startsWith("/oauth/") ||
    pathname === "/userinfo" ||
    pathname.startsWith("/storage/") ||
    pathname === "/openapi.json" ||
    pathname === "/.well-known/openid-configuration" ||
    pathname === "/.well-known/jwks.json"
  );
}

async function corsHeadersForRequest(
  request: Request,
  url: URL,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore | null,
): Promise<Headers | Response> {
  const origin = request.headers.get("origin");
  if (url.pathname === "/oauth/token") {
    if (!origin || request.method !== "OPTIONS") return new Headers();
    const allowed = Boolean(
      store && (await store.hasActiveClientOrigin(origin)),
    );
    return cors(request, allowed ? [origin] : [], config.issuerUrl);
  }
  if (!origin || !isClientCorsRoute(url.pathname)) {
    return cors(
      request,
      origin ? config.allowedCorsOrigins : [],
      config.issuerUrl,
    );
  }

  let allowed = false;
  if (store && request.method === "OPTIONS") {
    allowed = await store.hasActiveClientOrigin(origin);
  } else if (store) {
    const token = bearerToken(request);
    const audience = token ? parseJwtAudience(token) : null;
    const client = audience ? await store.getClient(audience) : null;
    allowed = Boolean(
      client && !client.disabledAt && client.origins.includes(origin),
    );
  }
  return cors(request, allowed ? [origin] : [], config.issuerUrl);
}

function isClientCorsRoute(pathname: string): boolean {
  return pathname === "/userinfo" || pathname.startsWith("/storage/");
}

function needsStore(pathname: string): boolean {
  return ![
    "/",
    "/health",
    "/auth-ui.css",
    "/auth-ui.js",
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

async function endpointRateLimit(
  store: AuthStore,
  request: Request,
  config: ReturnType<typeof loadConfig>,
  family: string,
  perIpLimit: number,
): Promise<Response | null> {
  const now = nowSeconds();
  const ipHash = await sha256(
    `rate-ip:${config.jwtPrivateJwk.d}:${clientIp(request)}`,
  );
  const ipAllowed = await store.rateLimit(
    `${family}:ip:${ipHash}`,
    perIpLimit,
    60,
    now,
  );
  if (!ipAllowed) return rateLimitResponse();
  const globalAllowed = await store.rateLimit(
    `${family}:global`,
    perIpLimit * 10,
    60,
    now,
  );
  if (globalAllowed) return null;
  return rateLimitResponse();
}

function rateLimitResponse(): Response {
  const response = oauthError("slow_down", "Rate limit exceeded", 429);
  response.headers.set("retry-after", "60");
  return response;
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
