import { loadConfig } from "./config";
import { nowSeconds, publicJwk, randomToken, sha256 } from "./crypto";
import { D1AuthStore } from "./store/d1";
import type { RuntimeEnv, AuthStore, ClientRegistrationInput } from "./types";
import { readSitesIdentity, requireSitesIdentity } from "./identity";
import {
  addSecurityHeaders,
  acceptsHtml,
  bearerToken,
  cors,
  csrfCookie,
  csrfTokenForRequest,
  csrfTokenMatches,
  html,
  json,
  oauthError,
  readForm,
  redirect,
  requireSameOrigin,
  stylesheet,
} from "./http";
import { oidcConfiguration, openApiSpec } from "./openapi";
import { storageEndpoint } from "./storage";
import { storageBrowserEndpoint } from "./storage-browser";
import {
  hasBrowserSession,
  issueBrowserSessionAccessToken,
} from "./browser-session";
import { isBrowserSessionClientId } from "./system-client";
import {
  adminClientsPage,
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

const CLEANUP_INTERVAL_SECONDS = 300;
let nextCleanupAt = 0;

export async function createAittaDB(
  env: RuntimeEnv,
  ctx?: { waitUntil(promise: Promise<unknown>): void },
): Promise<AittaDBApp> {
  const fallbackUrl = env.ISSUER_URL ?? "https://aittadb.local";
  const config = loadConfig(env, fallbackUrl);
  const store = env.DB ? new D1AuthStore(env.DB) : null;
  return createAittaDBWithStore(env, store, config, ctx);
}

export function createAittaDBWithStore(
  env: RuntimeEnv,
  store: AuthStore | null,
  config = loadConfig(env, env.ISSUER_URL ?? "https://aittadb.local"),
  ctx?: { waitUntil(promise: Promise<unknown>): void },
): AittaDBApp {
  return {
    async fetch(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const corsHeaders = isCorsControlledRoute(url.pathname)
        ? cors(request, config.allowedCorsOrigins, config.issuerUrl)
        : new Headers();
      if (corsHeaders instanceof Response)
        return finalizeResponse(request, corsHeaders, config);
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: corsHeaders });
      if (!isAittaDBRoute(url.pathname)) {
        if (isAssetRoute(url.pathname)) return null;
        return finalizeResponse(
          request,
          oauthError("not_found", "No AittaDB route matches this request", 404),
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

        const routed = await route(request, url, env, store, config);
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
): Promise<Response> {
  if (url.pathname === "/" && request.method === "GET") {
    const metadata = {
      service: "AittaDB",
      description:
        "A hosted application backend for third-party apps, with ChatGPT sign-in inside ChatGPT Sites, AittaDB-issued sessions, isolated JSON records, and file storage.",
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
      _links: {
        self: { href: config.issuerUrl },
        health: { href: `${config.issuerUrl}/health` },
        docs: { href: `${config.issuerUrl}/docs`, type: "text/html" },
        openapi: {
          href: `${config.issuerUrl}/openapi.json`,
          type: "application/json",
        },
        oidcConfiguration: {
          href: `${config.issuerUrl}/.well-known/openid-configuration`,
          type: "application/json",
        },
        jwks: {
          href: `${config.issuerUrl}/.well-known/jwks.json`,
          type: "application/json",
        },
        adminClients: {
          href: `${config.issuerUrl}/admin/clients`,
          type: "text/html",
        },
        session: {
          href: `${config.issuerUrl}/session`,
          type: "text/html",
        },
        deviceVerification: {
          href: `${config.issuerUrl}/device`,
          type: "text/html",
        },
        storageRecords: {
          href: `${config.issuerUrl}/storage/records`,
          representations: ["application/json", "text/html"],
        },
        storageFiles: {
          href: `${config.issuerUrl}/storage/files`,
          representations: ["application/json", "text/html"],
        },
      },
      actions: {
        authenticate: {
          method: "GET",
          href: `${config.issuerUrl}/session`,
          authentication: "ChatGPT sign-in inside ChatGPT Sites",
        },
        authorize: {
          method: "GET",
          href: `${config.issuerUrl}/authorize`,
          parameters: [
            "response_type",
            "client_id",
            "redirect_uri",
            "scope",
            "state",
            "nonce",
            "code_challenge",
            "code_challenge_method",
          ],
        },
        deviceAuthorization: {
          method: "POST",
          href: `${config.issuerUrl}/oauth/device_authorization`,
          encoding: "application/x-www-form-urlencoded",
          parameters: ["client_id", "scope"],
        },
        token: {
          method: "POST",
          href: `${config.issuerUrl}/oauth/token`,
          encoding: "application/x-www-form-urlencoded",
          parameters: ["grant_type"],
        },
        revoke: {
          method: "POST",
          href: `${config.issuerUrl}/oauth/revoke`,
          encoding: "application/x-www-form-urlencoded",
          parameters: ["token", "token_type_hint"],
        },
        introspect: {
          method: "POST",
          href: `${config.issuerUrl}/oauth/introspect`,
          encoding: "application/x-www-form-urlencoded",
          parameters: ["token", "token_type_hint"],
        },
        listStorageRecords: {
          method: "GET",
          href: `${config.issuerUrl}/storage/records`,
          authorization: "Bearer access token with storage.read",
        },
        putStorageRecord: {
          method: "PUT",
          href: `${config.issuerUrl}/storage/records/{key}`,
          encoding: "application/json",
          authorization: "Bearer access token with storage.write",
        },
        listStorageFiles: {
          method: "GET",
          href: `${config.issuerUrl}/storage/files`,
          authorization: "Bearer access token with storage.read",
        },
        putStorageFile: {
          method: "PUT",
          href: `${config.issuerUrl}/storage/files/{key}`,
          authorization: "Bearer access token with storage.write",
        },
        useCurrentSessionStorage: {
          method: "GET",
          href: `${config.issuerUrl}/storage/records`,
          representation: "text/html",
          authentication: "ChatGPT sign-in inside ChatGPT Sites",
        },
      },
    };
    return acceptsHtml(request)
      ? html(serviceHomePage(metadata))
      : json(metadata);
  }
  if (url.pathname === "/health" && request.method === "GET") {
    const status = {
      ok: true,
      service: "aittadb",
      d1: Boolean(store),
      r2: Boolean(env.BUCKET),
      _links: {
        self: { href: `${config.issuerUrl}/health` },
        service: { href: config.issuerUrl },
        docs: { href: `${config.issuerUrl}/docs`, type: "text/html" },
        openapi: {
          href: `${config.issuerUrl}/openapi.json`,
          type: "application/json",
        },
      },
    };
    return acceptsHtml(request) ? html(healthPage(status)) : json(status);
  }
  if (url.pathname === "/auth-ui.css" && request.method === "GET") {
    return stylesheet(authUiCss());
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

  if (url.pathname === "/session" && request.method === "GET") {
    return localSessionEndpoint(request, env, store, config);
  }
  if (url.pathname === "/authorize" && request.method === "GET") {
    if (acceptsHtml(request) && !url.searchParams.has("client_id")) {
      return html(authorizationFormPage());
    }
    return createAuthorizeRequest(url, config, store);
  }
  if (
    url.pathname === "/oauth/device_authorization" &&
    request.method === "GET"
  ) {
    return acceptsHtml(request)
      ? browserFormPage(request, deviceAuthorizationFormPage)
      : methodNotAllowed("POST");
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
      : methodNotAllowed("POST");
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
      : methodNotAllowed("POST");
  }
  if (url.pathname === "/oauth/revoke" && request.method === "POST") {
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
    const response = await revokeEndpoint(request, store, form);
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
      : methodNotAllowed("POST");
  }
  if (url.pathname === "/oauth/introspect" && request.method === "POST") {
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
        userInfoFormPage(csrf, hasBrowserSession(request, env)),
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
      ? await issueBrowserSessionAccessToken(request, env, store, config, [
          "email",
          "profile",
        ])
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
    return browserJsonResponse(
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
    );
  }
  if (url.pathname.startsWith("/storage/")) {
    const browserResponse = await storageBrowserEndpoint(
      request,
      url,
      env,
      store,
      config,
    );
    if (browserResponse) return browserResponse;
    return storageEndpoint(request, url, env, store, config);
  }
  if (url.pathname === "/device" && request.method === "GET") {
    const csrf = csrfTokenForRequest(request);
    const headers = new Headers({ "set-cookie": csrfCookie(csrf) });
    return html(
      deviceEntryPage(url.searchParams.get("user_code") || "", csrf),
      { headers },
    );
  }
  if (url.pathname === "/device" && request.method === "POST") {
    return deviceEntryPost(request, env, store, config);
  }
  if (url.pathname === "/device/decision" && request.method === "POST") {
    return deviceDecisionPost(request, env, store, config);
  }
  if (url.pathname === "/consent" && request.method === "GET") {
    return consentGet(request, env, store);
  }
  if (url.pathname === "/consent" && request.method === "POST") {
    return consentPost(request, env, store, config);
  }
  if (url.pathname === "/admin/clients" && request.method === "GET") {
    return adminClientsGet(request, env, config, store);
  }
  if (url.pathname === "/admin/clients" && request.method === "POST") {
    return adminClientsPost(request, env, config, store);
  }
  return oauthError("not_found", "No AittaDB route matches this request", 404);
}

async function localSessionEndpoint(
  request: Request,
  env: RuntimeEnv,
  store: AuthStore,
  config: ReturnType<typeof loadConfig>,
): Promise<Response> {
  const identity = readSitesIdentity(request, env);
  if (!identity) {
    if (acceptsHtml(request))
      return requireSitesIdentity(request, env) as Response;
    return json(
      {
        error: "login_required",
        error_description:
          "ChatGPT sign-in inside ChatGPT Sites is required for this browser session",
        _links: {
          service: { href: config.issuerUrl, type: "text/html" },
          signIn: {
            href: `${config.issuerUrl}/signin-with-chatgpt?return_to=%2Fsession`,
            type: "text/html",
          },
          docs: { href: `${config.issuerUrl}/docs`, type: "text/html" },
        },
        actions: {
          authenticate: {
            method: "GET",
            href: `${config.issuerUrl}/session`,
            authentication: "ChatGPT sign-in inside ChatGPT Sites",
          },
        },
      },
      { status: 401 },
    );
  }

  const user = await store.findOrCreateUser(identity, nowSeconds());
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
    _links: {
      self: { href: `${config.issuerUrl}/session` },
      service: { href: config.issuerUrl, type: "text/html" },
      deviceAuthorization: {
        href: `${config.issuerUrl}/oauth/device_authorization`,
        type: "text/html",
      },
      authorize: { href: `${config.issuerUrl}/authorize`, type: "text/html" },
      userinfo: { href: `${config.issuerUrl}/userinfo`, type: "text/html" },
      storageRecords: {
        href: `${config.issuerUrl}/storage/records`,
        type: "text/html",
      },
      storageFiles: {
        href: `${config.issuerUrl}/storage/files`,
        type: "text/html",
      },
      adminClients: {
        href: `${config.issuerUrl}/admin/clients`,
        type: "text/html",
      },
      signOut: {
        href: `${config.issuerUrl}/signout-with-chatgpt?return_to=%2F`,
        type: "text/html",
      },
    },
    actions: {
      approveDeviceWithCurrentSession: {
        method: "GET",
        href: `${config.issuerUrl}/device`,
        representation: "text/html",
      },
      authorizeWithCurrentSession: {
        method: "GET",
        href: `${config.issuerUrl}/authorize`,
        representation: "text/html",
        note: "Registered client, exact redirect URI, and PKCE remain required",
      },
      readCurrentSessionUserInfo: {
        method: "GET",
        href: `${config.issuerUrl}/userinfo`,
        representation: "text/html",
      },
      manageCurrentSessionRecords: {
        method: "GET",
        href: `${config.issuerUrl}/storage/records`,
        representation: "text/html",
      },
      manageCurrentSessionFiles: {
        method: "GET",
        href: `${config.issuerUrl}/storage/files`,
        representation: "text/html",
      },
      administerClientsWithCurrentSession: {
        method: "GET",
        href: `${config.issuerUrl}/admin/clients`,
        representation: "text/html",
        authorization: "ADMIN_EMAILS allowlist",
      },
      signOut: {
        method: "GET",
        href: `${config.issuerUrl}/signout-with-chatgpt?return_to=%2F`,
      },
    },
  };
  return acceptsHtml(request) ? html(sessionPage(user)) : json(session);
}

async function finalizeResponse(
  request: Request,
  response: Response,
  config: ReturnType<typeof loadConfig>,
  corsHeaders = new Headers(),
): Promise<Response> {
  const negotiated = await negotiateBrowserError(request, response);
  const headers = new Headers(negotiated.headers);
  for (const [key, value] of corsHeaders.entries()) headers.set(key, value);
  addSecurityHeaders(headers);
  return new Response(negotiated.body, {
    status: negotiated.status,
    statusText: negotiated.statusText,
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
    !contentType.includes("application/json")
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
  if (
    !(response.headers.get("content-type") ?? "").includes("application/json")
  )
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
  const form = submittedForm ?? (await readForm(request));
  const grantType = form.get("grant_type");
  if (grantType === "urn:ietf:params:oauth:grant-type:device_code")
    return pollDeviceToken(request, form, config, store);

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
  submittedForm?: URLSearchParams,
): Promise<Response> {
  const form = submittedForm ?? (await readForm(request));
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
  config: ReturnType<typeof loadConfig>,
): Promise<Response> {
  if (!requireSameOrigin(request, config.issuerUrl))
    return html(
      errorPage("Invalid request", "Same-origin form submission is required", {
        status: 403,
      }),
      { status: 403 },
    );
  const form = await readForm(request);
  if (!validCsrf(request, form))
    return html(
      errorPage("Invalid request", "CSRF validation failed", { status: 403 }),
      { status: 403 },
    );
  const grant = await store.getDeviceGrantByUserCodeHash(
    await sha256(normalizeUserCode(form.get("user_code") || "")),
  );
  if (!grant || grant.expiresAt <= nowSeconds())
    return html(
      deviceEntryPage(
        form.get("user_code") || "",
        csrfTokenForRequest(request),
        "Invalid or expired user code",
      ),
      { status: 400 },
    );
  const identity = requireSitesIdentity(request, env);
  if (identity instanceof Response) return identity;
  const client = await store.getClient(grant.clientId);
  if (!client || isBrowserSessionClientId(client.id))
    return html(
      errorPage("Invalid request", "Client is unavailable", { status: 400 }),
      { status: 400 },
    );
  const csrf = csrfTokenForRequest(request);
  return html(deviceConsentPage(grant, client, csrf), {
    headers: { "set-cookie": csrfCookie(csrf) },
  });
}

async function deviceDecisionPost(
  request: Request,
  env: RuntimeEnv,
  store: AuthStore,
  config: ReturnType<typeof loadConfig>,
): Promise<Response> {
  if (!requireSameOrigin(request, config.issuerUrl))
    return html(
      errorPage("Invalid request", "Same-origin form submission is required", {
        status: 403,
      }),
      { status: 403 },
    );
  const form = await readForm(request);
  if (!validCsrf(request, form))
    return html(
      errorPage("Invalid request", "CSRF validation failed", { status: 403 }),
      { status: 403 },
    );
  const identity = requireSitesIdentity(request, env);
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
    return html(
      errorPage("Invalid request", "Device request is no longer pending", {
        status: 400,
      }),
      { status: 400 },
    );
  }
  const user = await store.findOrCreateUser(identity, nowSeconds());
  grant.status = form.get("decision") === "approve" ? "approved" : "denied";
  grant.userId = grant.status === "approved" ? user.id : null;
  await store.updateDeviceGrant(grant);
  return html(deviceOutcomePage(grant.status));
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
    return html(
      errorPage("Invalid request", "Authorization request expired", {
        status: 400,
      }),
      { status: 400 },
    );
  const client = await store.getClient(authRequest.clientId);
  if (!client || isBrowserSessionClientId(client.id))
    return html(
      errorPage("Invalid request", "Client is unavailable", { status: 400 }),
      { status: 400 },
    );
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
  const csrf = csrfTokenForRequest(request);
  return html(consentPage(authRequest, client, csrf), {
    headers: { "set-cookie": csrfCookie(csrf) },
  });
}

async function consentPost(
  request: Request,
  env: RuntimeEnv,
  store: AuthStore,
  config: ReturnType<typeof loadConfig>,
): Promise<Response> {
  if (!requireSameOrigin(request, config.issuerUrl))
    return html(
      errorPage("Invalid request", "Same-origin form submission is required", {
        status: 403,
      }),
      { status: 403 },
    );
  const form = await readForm(request);
  if (!validCsrf(request, form))
    return html(
      errorPage("Invalid request", "CSRF validation failed", { status: 403 }),
      { status: 403 },
    );
  const identity = requireSitesIdentity(request, env);
  if (identity instanceof Response) return identity;
  const authRequest = await store.getAuthorizationRequest(
    form.get("request_id") || "",
  );
  if (
    !authRequest ||
    isBrowserSessionClientId(authRequest.clientId) ||
    authRequest.expiresAt <= nowSeconds()
  )
    return html(
      errorPage("Invalid request", "Authorization request expired", {
        status: 400,
      }),
      { status: 400 },
    );
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
  const csrf = csrfTokenForRequest(request);
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
  if (!requireSameOrigin(request, config.issuerUrl))
    return html(
      errorPage("Invalid request", "Same-origin form submission is required", {
        status: 403,
      }),
      { status: 403 },
    );
  const form = await readForm(request);
  if (!validCsrf(request, form))
    return html(
      errorPage("Invalid request", "CSRF validation failed", { status: 403 }),
      { status: 403 },
    );
  const action = form.get("action");
  if (action) {
    const clientId = form.get("client_id") || "";
    if (isBrowserSessionClientId(clientId)) {
      return html(
        errorPage("Not found", "Client is unavailable", {
          status: 404,
          error: "not_found",
        }),
        { status: 404 },
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
      return html(adminClientsPage(await store.listClients(), csrf, secret), {
        headers: { "set-cookie": csrfCookie(csrf) },
      });
    }
    const csrf = csrfTokenForRequest(request);
    return html(adminClientsPage(await store.listClients(), csrf, null), {
      headers: { "set-cookie": csrfCookie(csrf) },
    });
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
  const csrf = csrfTokenForRequest(request);
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
        { status: 403, error: "forbidden" },
      ),
      { status: 403 },
    );
  await store.findOrCreateUser(identity, nowSeconds());
  return true;
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
    pathname === "/session" ||
    pathname === "/auth-ui.css" ||
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
    pathname.startsWith("/oauth/") ||
    pathname === "/userinfo" ||
    pathname.startsWith("/storage/") ||
    pathname === "/openapi.json" ||
    pathname === "/.well-known/openid-configuration" ||
    pathname === "/.well-known/jwks.json"
  );
}

function needsStore(pathname: string): boolean {
  return ![
    "/",
    "/health",
    "/auth-ui.css",
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
