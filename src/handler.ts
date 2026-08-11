import { loadConfig } from "./config";
import { nowSeconds, publicJwk, randomToken, sha256 } from "./crypto";
import { D1AuthStore } from "./store/d1";
import {
  CLEANUP_FAILURE_EVENT,
  cleanupTelemetryPayload,
} from "./store/cleanup";
import type {
  RuntimeEnv,
  AuthStore,
  ClientRegistrationInput,
  ClientView,
  LocalUser,
  UpstreamIdentity,
} from "./types";
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
  DEFAULT_FORM_MAX_BYTES,
  readBoundedRequestBody,
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
  negotiateHypermediaRepresentation,
  prefersVendorHypermedia,
  resourceDocument,
  type HypermediaAction,
} from "./hypermedia";
import { oidcConfiguration, openApiSpec } from "./openapi";
import { MAX_RECORD_BYTES, storageEndpoint } from "./storage";
import {
  MAX_STORAGE_FORM_BYTES,
  storageBrowserEndpoint,
} from "./storage-browser";
import { applicationEventItemEndpoint, isApplicationEventData } from "./events";
import { applicationEventItemPage } from "./event-pages";
import {
  hasBrowserSession,
  issueBrowserSessionAccessToken,
} from "./browser-session";
import { isBrowserSessionClientId } from "./system-client";
import {
  adminClientControls,
  hasAdminClientControl,
  parseAdminClientOperation,
  type AdminMutationResult,
} from "./admin-clients";
import {
  ADMIN_SUBMISSION_TTL_SECONDS,
  adminResultCookie,
  clearAdminResultCookie,
  createAdminSubmissionToken,
  isAdminSubmissionToken,
  openAdminResult,
  readAdminResultCookie,
  sealAdminResult,
} from "./admin-result";
import {
  authorizationConsentDocument,
  deviceApprovalDocument,
  deviceDecisionDocument,
  deviceEntryDocument,
} from "./transaction-resources";
import { repairStorageFileOrphans } from "./storage-orphan-repair";
import { accountCredentialPurgeFailureTelemetry } from "./store/account-credential-purge";
import {
  accountDeletionCoordinatorDeferredTelemetry,
  accountDeletionCoordinatorFailureTelemetry,
  coordinateAccountDeletionBatch,
} from "./account-deletion-coordinator";
import {
  ACCOUNT_DELETION_CONFIRMATION_PHRASE,
  ACCOUNT_DELETION_REQUEST_MAX_BYTES,
  openAccountDeletionConfirmation,
  sealAccountDeletionConfirmation,
} from "./account-deletion-request";
import {
  accountDeletionPublicStatus,
  accountDeletionStatusCookie,
  openAccountDeletionStatus,
  readAccountDeletionStatusHandle,
  sealAccountDeletionStatus,
  type AccountDeletionPublicStatus,
} from "./account-deletion-status";
import {
  accountDeletionAcceptedPage,
  accountDeletionStatusPage,
  adminClientsPage,
  authUiJs,
  authUiCss,
  consentPage,
  deviceConsentPage,
  deviceEntryPage,
  deviceOutcomePage,
  docsPage,
  errorPage,
  healthPage,
  privacyPolicyPage,
  sessionPage,
  serviceHomePage,
  statisticsPage,
} from "./pages";
import {
  buildPrivacyPolicy,
  EU_PRIVACY_RIGHTS_URL,
  resolvePrivacyContact,
  SITES_DPA_URL,
  SITES_TERMS_URL,
} from "./privacy";
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
  issueClientCredentialsToken,
  normalizeUserCode,
  parseScopes,
  pollDeviceToken,
  rotateRefreshToken,
  validateClientRegistrationInput,
  validateScopes,
  verifyAccessToken,
} from "./oauth";
import {
  availableOAuthScopes,
  availableServiceClientScopes,
} from "./oauth-scopes";
import {
  isSubjectAuthorizationDenied,
  requireActiveSubject,
  startSubjectAccountDeletion,
} from "./subject-access";
import {
  eventCollectionBrowserEndpoint,
  eventCollectionEndpoint,
} from "./event-collection";

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
      if (!config.features.oauthApps && url.pathname === "/admin/clients") {
        const negotiationError = hypermediaNegotiationError(request);
        return finalizeResponse(
          request,
          negotiationError
            ? hypermediaError(request, "not_acceptable", negotiationError, 406)
            : featureUnavailableResponse(request, config, "OAuth Apps"),
          config,
        );
      }
      if (
        !config.features.oauthApps &&
        isExternalOAuthInitiationRoute(url.pathname)
      ) {
        const negotiationError = hypermediaNegotiationError(request);
        return finalizeResponse(
          request,
          negotiationError
            ? hypermediaError(request, "not_acceptable", negotiationError, 406)
            : featureUnavailableResponse(request, config, "OAuth Apps"),
          config,
        );
      }
      if (!config.features.oauthApps && url.pathname === "/oauth/token") {
        const negotiationError =
          request.method === "GET" ? hypermediaNegotiationError(request) : null;
        return finalizeResponse(
          request,
          negotiationError
            ? hypermediaError(request, "not_acceptable", negotiationError, 406)
            : request.method === "POST"
              ? oauthError(
                  "temporarily_unavailable",
                  "OAuth Apps is disabled for this deployment",
                  503,
                )
              : featureUnavailableResponse(request, config, "OAuth Apps"),
          config,
        );
      }
      if (
        !config.features.oauthApps &&
        (url.pathname === "/oauth/revoke" ||
          url.pathname === "/oauth/introspect")
      ) {
        const negotiationError =
          request.method === "GET" ? hypermediaNegotiationError(request) : null;
        return finalizeResponse(
          request,
          negotiationError
            ? hypermediaError(request, "not_acceptable", negotiationError, 406)
            : request.method === "POST"
              ? oauthError(
                  "temporarily_unavailable",
                  "OAuth Apps is disabled for this deployment",
                  503,
                )
              : featureUnavailableResponse(request, config, "OAuth Apps"),
          config,
        );
      }
      if (!config.features.oauthApps && url.pathname === "/userinfo") {
        const negotiationError =
          request.method === "GET" ? hypermediaNegotiationError(request) : null;
        return finalizeResponse(
          request,
          negotiationError
            ? hypermediaError(request, "not_acceptable", negotiationError, 406)
            : featureUnavailableResponse(request, config, "OAuth Apps"),
          config,
        );
      }
      if (!config.features.records && isRecordsRoute(url.pathname)) {
        const negotiationError = hypermediaNegotiationError(request);
        return finalizeResponse(
          request,
          negotiationError
            ? hypermediaError(request, "not_acceptable", negotiationError, 406)
            : featureUnavailableResponse(request, config, "JSON Records"),
          config,
        );
      }
      if (!config.features.files && isFilesRoute(url.pathname)) {
        const negotiationError = usesApplicationNegotiation(request, url)
          ? hypermediaNegotiationError(request)
          : null;
        return finalizeResponse(
          request,
          negotiationError
            ? hypermediaError(request, "not_acceptable", negotiationError, 406)
            : featureUnavailableResponse(request, config, "File Storage"),
          config,
        );
      }
      if (!config.features.events && isEventsRoute(url.pathname)) {
        const negotiationError = hypermediaNegotiationError(request);
        return finalizeResponse(
          request,
          negotiationError
            ? hypermediaError(request, "not_acceptable", negotiationError, 406)
            : featureUnavailableResponse(request, config, "Events"),
          config,
        );
      }
      const browserOriginRejection = rejectInvalidBrowserMutationOrigin(
        request,
        url,
        config.issuerUrl,
      );
      if (browserOriginRejection) {
        return finalizeResponse(request, browserOriginRejection, config);
      }
      const prebuffered = await prebufferAcceptedRequestBody(request, url);
      if (prebuffered instanceof Response) {
        return finalizeResponse(request, prebuffered, config);
      }
      request = prebuffered;
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

      const multipartIdentityRejection = rejectUntrustedBrowserFileMultipart(
        request,
        url,
        identityProvider,
      );
      if (multipartIdentityRejection) {
        return finalizeResponse(
          request,
          multipartIdentityRejection,
          config,
          corsHeaders,
        );
      }

      if (
        url.pathname === "/statistics" &&
        request.method === "GET" &&
        !config.features.statistics
      ) {
        return finalizeResponse(
          request,
          hypermediaError(
            request,
            "feature_unavailable",
            "Service statistics are disabled by deployment configuration",
            503,
            {
              links: [
                link("service", config.issuerUrl, {
                  type: HYPERMEDIA_MEDIA_TYPE,
                }),
                link("health", `${config.issuerUrl}/health`, {
                  type: HYPERMEDIA_MEDIA_TYPE,
                }),
                link("documentation", `${config.issuerUrl}/docs`, {
                  type: "text/html",
                }),
              ],
            },
          ),
          config,
          corsHeaders,
        );
      }

      try {
        if (
          !store &&
          needsStore(url.pathname) &&
          !(url.pathname === "/account/deletion" && request.method === "GET")
        )
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
          ctx,
        );
        const finalized = await finalizeResponse(
          request,
          routed,
          config,
          corsHeaders,
        );
        if (
          store &&
          needsStore(url.pathname) &&
          url.pathname !== "/account/deletion"
        ) {
          scheduleCleanup(
            store,
            env.BUCKET,
            ctx,
            nowSeconds(),
            config.maintenanceCleanupTelemetryEnabled,
          );
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

interface RequestBodyPolicy {
  maxBytes: number;
  tooLargeDescription: string;
}

const URL_ENCODED_POST_PATHS = new Set([
  "/oauth/device_authorization",
  "/oauth/token",
  "/oauth/revoke",
  "/oauth/introspect",
  "/userinfo",
  "/device",
  "/device/decision",
  "/consent",
  "/admin/clients",
]);

async function prebufferAcceptedRequestBody(
  request: Request,
  url: URL,
): Promise<Request | Response> {
  const policy = acceptedRequestBodyPolicy(request, url);
  if (!policy) return request;
  try {
    const body = await readBoundedRequestBody(request, policy.maxBytes);
    return new Request(request, { body });
  } catch (error) {
    if (error instanceof Error && error.message === "request_too_large") {
      return oauthError("invalid_request", policy.tooLargeDescription, 413);
    }
    return oauthError("invalid_request", "Malformed request body", 400);
  }
}

function acceptedRequestBodyPolicy(
  request: Request,
  url: URL,
): RequestBodyPolicy | null {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (
    request.method === "POST" &&
    url.pathname === "/account/deletion" &&
    (contentType.includes("application/x-www-form-urlencoded") ||
      isJsonMediaType(contentType))
  ) {
    return {
      maxBytes: ACCOUNT_DELETION_REQUEST_MAX_BYTES,
      tooLargeDescription: "Account deletion request is too large",
    };
  }
  if (
    request.method === "POST" &&
    contentType.includes("application/x-www-form-urlencoded")
  ) {
    if (isRecordsRoute(url.pathname) || isFilesRoute(url.pathname)) {
      return {
        maxBytes: MAX_STORAGE_FORM_BYTES,
        tooLargeDescription: "Storage browser form is too large",
      };
    }
    if (URL_ENCODED_POST_PATHS.has(url.pathname)) {
      return {
        maxBytes: DEFAULT_FORM_MAX_BYTES,
        tooLargeDescription: "Request is too large",
      };
    }
  }
  if (
    request.method === "PUT" &&
    isRecordsRoute(url.pathname) &&
    contentType.includes("application/json")
  ) {
    return {
      maxBytes: MAX_RECORD_BYTES,
      tooLargeDescription: "Storage record is too large",
    };
  }
  return null;
}

async function route(
  request: Request,
  url: URL,
  env: RuntimeEnv,
  store: AuthStore | null,
  config: ReturnType<typeof loadConfig>,
  identityProvider: UpstreamIdentityProvider,
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
): Promise<Response> {
  if (url.pathname === "/" && request.method === "GET") {
    const identity = identityProvider.read(request);
    const signedIn = Boolean(identity);
    const signedInUser =
      identity && store
        ? await store.findOrCreateUser(identity, nowSeconds())
        : null;
    const showAdmin = Boolean(
      config.features.oauthApps &&
      signedInUser &&
      config.adminSubjects.includes(signedInUser.id),
    );
    const metadata = {
      service: "AittaDB",
      description:
        "AittaDB is a source-available project providing a hosted application backend for third-party apps, services, and agents. Current public releases use FSL-1.1-MIT and become MIT-licensed two years after publication; an MIT license for immediate use is also available commercially. Its current implementation depends on OpenAI-hosted ChatGPT Sites for runtime, ChatGPT sign-in, D1, R2, configuration, and secrets. AittaDB issues its own sessions and never forwards ChatGPT credentials.",
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
      features: config.features,
      capabilities: [
        "ChatGPT sign-in inside ChatGPT Sites mapped to a separate AittaDB user",
        ...(config.features.oauthApps
          ? ["AittaDB-issued OAuth 2.0, OpenID Connect, and JWT sessions"]
          : ["AittaDB-issued private sessions and verifiable JWT credentials"]),
        ...(config.features.records
          ? ["D1-backed JSON records isolated by AittaDB user and client"]
          : []),
        ...(config.features.files
          ? [
              "R2-backed files with D1 metadata isolated by AittaDB user and client",
            ]
          : []),
        ...(config.features.events
          ? [
              "Persistent immutable event collection reads isolated by AittaDB user and client",
            ]
          : []),
      ],
      plannedCapabilities: config.features.events
        ? ["Event publication and bounded long-polling delivery"]
        : ["Persistent events and long-polling delivery"],
    };
    const endpoints = endpointActions(config.issuerUrl);
    const links = [
      link("self", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
      link("health", `${config.issuerUrl}/health`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      ...(config.features.statistics
        ? [
            link("statistics", `${config.issuerUrl}/statistics`, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
          ]
        : []),
      link("privacy-policy", `${config.issuerUrl}/privacy`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("session", `${config.issuerUrl}/session`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      ...(config.features.records
        ? [
            link("storage-records", `${config.issuerUrl}/storage/records`, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
          ]
        : []),
      ...(config.features.files
        ? [
            link("storage-files", `${config.issuerUrl}/storage/files`, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
          ]
        : []),
      ...(config.features.events
        ? [
            link("events", `${config.issuerUrl}/events`, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
          ]
        : []),
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
      ...(config.features.oauthApps
        ? [
            link("oauth-authorization", endpoints.authorize.href, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
            link(
              "oauth-device-authorization",
              endpoints.deviceAuthorization.href,
              { type: HYPERMEDIA_MEDIA_TYPE },
            ),
          ]
        : []),
      ...(config.features.oauthApps
        ? [
            link("oauth-token", endpoints.token.href, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
          ]
        : []),
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
      ...(config.features.statistics
        ? [
            action(
              "read-statistics",
              "View service statistics",
              "GET",
              `${config.issuerUrl}/statistics`,
              { authorization: { scheme: "none" }, fields: [] },
            ),
          ]
        : []),
      action(
        "read-privacy-policy",
        "Read Privacy Policy",
        "GET",
        `${config.issuerUrl}/privacy`,
        { authorization: { scheme: "none" }, fields: [] },
      ),
      ...(signedIn && config.features.records
        ? [
            action(
              "open-records",
              "Open JSON records",
              "GET",
              `${config.issuerUrl}/storage/records`,
              { authorization: { scheme: "sites-session" }, fields: [] },
            ),
          ]
        : []),
      ...(signedIn && config.features.files
        ? [
            action(
              "open-files",
              "Open file storage",
              "GET",
              `${config.issuerUrl}/storage/files`,
              { authorization: { scheme: "sites-session" }, fields: [] },
            ),
          ]
        : []),
      ...(signedIn && config.features.events
        ? [
            action(
              "open-events",
              "Open application events",
              "GET",
              `${config.issuerUrl}/events`,
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
    return negotiateHypermediaRepresentation(request, "html") === "html"
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
    const configuration = oidcConfiguration(config.issuerUrl, {
      oauthAppsEnabled: config.features.oauthApps,
      eventsEnabled: config.features.events,
    });
    return prefersRawJson(request, url)
      ? json(configuration)
      : html(
          structuredDataPage({
            title: "OpenID configuration",
            eyebrow: "Issuer discovery",
            summary:
              "Published OpenID Provider metadata for this AittaDB issuer.",
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

  if (url.pathname === "/privacy" && request.method === "GET") {
    const contact = await resolvePrivacyContact(config, store);
    if (!contact) {
      return hypermediaError(
        request,
        "privacy_policy_unavailable",
        "The deployment operator has not configured an available privacy contact",
        503,
        {
          links: [
            link("self", `${config.issuerUrl}/privacy`, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
            link("service", config.issuerUrl, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
            link("documentation", `${config.issuerUrl}/docs`, {
              type: "text/html",
            }),
          ],
        },
      );
    }
    const policy = buildPrivacyPolicy(config, contact);
    const document = resourceDocument({
      type: "privacy-policy",
      id: `${config.issuerUrl}/privacy`,
      data: policy,
      links: [
        link("self", `${config.issuerUrl}/privacy`, {
          type: HYPERMEDIA_MEDIA_TYPE,
        }),
        link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
        link("contact", `mailto:${contact.email}`, {
          title: "Contact the deployment operator",
        }),
        link("terms", SITES_TERMS_URL, { type: "text/html" }),
        link("service-provider-privacy", SITES_DPA_URL, {
          type: "text/html",
        }),
        link("privacy-rights", EU_PRIVACY_RIGHTS_URL, {
          type: "text/html",
        }),
        link("documentation", `${config.issuerUrl}/docs`, {
          type: "text/html",
        }),
      ],
    });
    return acceptsHtml(request)
      ? html(privacyPolicyPage(policy))
      : hypermediaJson(request, document);
  }

  if (url.pathname === "/account/deletion" && request.method === "GET") {
    return accountDeletionStatusGet(
      request,
      env,
      store,
      config,
      identityProvider,
      ctx,
    );
  }

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
    return localSessionEndpoint(
      request,
      store,
      config,
      identityProvider,
      Boolean(env.BUCKET && ctx),
    );
  }
  if (url.pathname === "/account/deletion" && request.method === "POST") {
    return accountDeletionRequestPost(
      request,
      env,
      store,
      config,
      identityProvider,
      ctx,
    );
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
      ? browserJsonResponse(
          response,
          (payload) =>
            tokenResultPage(
              payload,
              form.get("grant_type") === "client_credentials",
            ),
          "/oauth/token",
        )
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
  if (url.pathname === "/events" && request.method === "GET") {
    const browserResponse = await eventCollectionBrowserEndpoint(
      request,
      url,
      store,
      config,
      identityProvider,
    );
    if (browserResponse) return browserResponse;
    return eventCollectionEndpoint(request, url, store, config);
  }
  if (url.pathname.startsWith("/events/")) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const limited = await endpointRateLimit(
      store,
      request,
      config,
      "events-read",
      240,
    );
    if (limited) return limited;
    return applicationEventItemRoute(
      request,
      url.pathname.slice("/events/".length),
      store,
      config,
      identityProvider,
    );
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
  accountDeletionAvailable: boolean,
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
          link("privacy-policy", `${config.issuerUrl}/privacy`, {
            type: HYPERMEDIA_MEDIA_TYPE,
          }),
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
  try {
    await requireActiveSubject(store, user.id);
  } catch (error) {
    if (!isSubjectAuthorizationDenied(error)) throw error;
    return acceptsHtml(request)
      ? html(
          errorPage("Session unavailable", "Authentication is required", {
            status: 401,
            error: "login_required",
          }),
          { status: 401 },
        )
      : oauthError("login_required", "Authentication is required", 401);
  }
  const showAdmin =
    config.features.oauthApps && config.adminSubjects.includes(user.id);
  const csrf = csrfTokenForRequest(request);
  const canRequestAccountDeletion =
    accountDeletionAvailable && !config.adminSubjects.includes(user.id);
  const accountDeletionConfirmation = canRequestAccountDeletion
    ? await sealAccountDeletionConfirmation(
        user.id,
        identity.email,
        config,
        nowSeconds(),
      )
    : null;
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
      link("privacy-policy", `${config.issuerUrl}/privacy`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      ...(config.features.oauthApps
        ? [
            link("userinfo", `${config.issuerUrl}/userinfo`, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
          ]
        : []),
      ...(config.features.records
        ? [
            link("storage-records", `${config.issuerUrl}/storage/records`, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
          ]
        : []),
      ...(config.features.files
        ? [
            link("storage-files", `${config.issuerUrl}/storage/files`, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
          ]
        : []),
      ...(config.features.events
        ? [
            link("events", `${config.issuerUrl}/events`, {
              type: HYPERMEDIA_MEDIA_TYPE,
            }),
          ]
        : []),
      ...(showAdmin
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
      ...(config.features.oauthApps
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
        : []),
      ...(config.features.records
        ? [
            action(
              "manage-session-records",
              "Manage JSON records",
              "GET",
              `${config.issuerUrl}/storage/records`,
              { authorization: { scheme: "sites-session" }, fields: [] },
            ),
          ]
        : []),
      ...(config.features.files
        ? [
            action(
              "manage-session-files",
              "Manage files",
              "GET",
              `${config.issuerUrl}/storage/files`,
              { authorization: { scheme: "sites-session" }, fields: [] },
            ),
          ]
        : []),
      ...(config.features.events
        ? [
            action(
              "read-session-events",
              "Read application events",
              "GET",
              `${config.issuerUrl}/events`,
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
      ...(accountDeletionConfirmation
        ? [
            action(
              "request-account-deletion",
              "Delete my AittaDB account",
              "POST",
              `${config.issuerUrl}/account/deletion`,
              {
                type: "application/x-www-form-urlencoded",
                authorization: { scheme: "sites-session" },
                description:
                  "Starts deletion only for the currently signed-in local AittaDB account after explicit confirmation.",
                fields: [
                  field("csrf_token", "CSRF token", "string", "body", {
                    required: true,
                    secret: true,
                    value: csrf,
                  }),
                  field(
                    "confirmation_token",
                    "Account-bound confirmation",
                    "string",
                    "body",
                    {
                      required: true,
                      secret: true,
                      value: accountDeletionConfirmation,
                      max_length: 512,
                    },
                  ),
                  field(
                    "confirmation",
                    "Type delete my account",
                    "string",
                    "body",
                    {
                      required: true,
                      min_length: ACCOUNT_DELETION_CONFIRMATION_PHRASE.length,
                      max_length: ACCOUNT_DELETION_CONFIRMATION_PHRASE.length,
                      description: `Enter exactly: ${ACCOUNT_DELETION_CONFIRMATION_PHRASE}`,
                    },
                  ),
                ],
              },
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
    ? html(
        sessionPage(
          user,
          showAdmin,
          config.features.records,
          config.features.files,
          config.features.oauthApps,
          config.features.events,
          accountDeletionConfirmation
            ? {
                csrf,
                confirmationToken: accountDeletionConfirmation,
                confirmationPhrase: ACCOUNT_DELETION_CONFIRMATION_PHRASE,
              }
            : undefined,
        ),
        { headers: { "set-cookie": csrfCookie(csrf) } },
      )
    : hypermediaJson(request, document, {
        headers: { "set-cookie": csrfCookie(csrf) },
      });
}

interface AccountDeletionSubmission {
  confirmation: string;
  confirmationToken: string;
  csrfToken: string;
}

type AccountDeletionSubmissionResult =
  | { ok: true; value: AccountDeletionSubmission }
  | { ok: false; status: 400 | 415 };

async function accountDeletionRequestPost(
  request: Request,
  env: RuntimeEnv,
  store: AuthStore,
  config: ReturnType<typeof loadConfig>,
  identityProvider: UpstreamIdentityProvider,
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
): Promise<Response> {
  const limited = await endpointRateLimit(
    store,
    request,
    config,
    "account-deletion",
    5,
  );
  if (limited) return limited;
  if (!env.BUCKET || !ctx) {
    return accountDeletionRejection(request, config, 503);
  }

  const identity = identityProvider.read(request);
  if (!identity) return accountDeletionRejection(request, config);
  const user = await store.getUserByEmail(identity.email);
  if (!user || config.adminSubjects.includes(user.id)) {
    return accountDeletionRejection(request, config);
  }

  const submission = await readAccountDeletionSubmission(request);
  if (!submission.ok) {
    return accountDeletionRejection(request, config, submission.status);
  }
  const now = nowSeconds();
  if (
    submission.value.confirmation !== ACCOUNT_DELETION_CONFIRMATION_PHRASE ||
    !csrfTokenMatches(request, submission.value.csrfToken) ||
    !(await openAccountDeletionConfirmation(
      submission.value.confirmationToken,
      user.id,
      identity.email,
      config,
      now,
    ))
  ) {
    return accountDeletionRejection(request, config);
  }

  const statusHandle = await sealAccountDeletionStatus(
    user.id,
    identity.email,
    config,
    now,
  );

  let started;
  try {
    started = await startSubjectAccountDeletion(
      store,
      config.adminSubjects,
      user.id,
      now,
    );
  } catch (error) {
    if (
      isSubjectAuthorizationDenied(error) ||
      (error instanceof Error &&
        error.message === "account_deletion_subject_not_found")
    ) {
      return accountDeletionRejection(request, config);
    }
    throw error;
  }
  if (!started.created) {
    return accountDeletionRejection(request, config);
  }

  nudgeAccountDeletionCoordinator(store, env.BUCKET, ctx);
  const document = resourceDocument({
    type: "account-deletion-request-accepted",
    id: `${config.issuerUrl}/account/deletion`,
    data: { accepted: true },
    links: [
      link("self", `${config.issuerUrl}/account/deletion`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
      link("privacy-policy", `${config.issuerUrl}/privacy`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
    ],
    actions: [
      action(
        "read-account-deletion-status",
        "View deletion status",
        "GET",
        `${config.issuerUrl}/account/deletion`,
        {
          authorization: { scheme: "sites-session" },
          fields: [],
        },
      ),
    ],
  });
  const headers = {
    "set-cookie": accountDeletionStatusCookie(statusHandle),
  };
  return acceptsHtml(request)
    ? html(accountDeletionAcceptedPage(), { status: 202, headers })
    : hypermediaJson(request, document, { status: 202, headers });
}

async function accountDeletionStatusGet(
  request: Request,
  env: RuntimeEnv,
  store: AuthStore | null,
  config: ReturnType<typeof loadConfig>,
  identityProvider: UpstreamIdentityProvider,
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
): Promise<Response> {
  const identity = identityProvider.read(request);
  const handle = readAccountDeletionStatusHandle(request);
  if (!identity || !handle) {
    return accountDeletionStatusRejection(request, config);
  }
  const opened = await openAccountDeletionStatus(
    handle,
    identity.email,
    config,
    nowSeconds(),
  );
  if (!opened) return accountDeletionStatusRejection(request, config);
  if (!store) return accountDeletionStatusRejection(request, config, 503);

  const job = await store.getAccountDeletionJob(opened.subject);
  if (!job) return accountDeletionStatusRejection(request, config);
  const status = accountDeletionPublicStatus(job.state);
  if (status !== "completed") {
    if (!env.BUCKET || !ctx) {
      return accountDeletionStatusRejection(request, config, 503);
    }
    nudgeAccountDeletionCoordinator(store, env.BUCKET, ctx);
  }

  const currentAction = accountDeletionStatusAction(status, config.issuerUrl);
  const document = resourceDocument({
    type: "account-deletion-status",
    id: `${config.issuerUrl}/account/deletion`,
    data: { status },
    links: [
      link("self", `${config.issuerUrl}/account/deletion`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("privacy-policy", `${config.issuerUrl}/privacy`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
    ],
    actions: [currentAction],
  });
  return acceptsHtml(request)
    ? html(accountDeletionStatusPage(status))
    : hypermediaJson(request, document);
}

function accountDeletionStatusAction(
  status: AccountDeletionPublicStatus,
  issuerUrl: string,
): HypermediaAction {
  if (status === "completed") {
    return action(
      "sign-out",
      "Sign out",
      "GET",
      `${issuerUrl}/signout-with-chatgpt?return_to=%2F`,
      {
        authorization: { scheme: "sites-session" },
        fields: [],
      },
    );
  }
  return action(
    status === "retry"
      ? "retry-account-deletion"
      : "refresh-account-deletion-status",
    status === "retry" ? "Retry deletion" : "Refresh deletion status",
    "GET",
    `${issuerUrl}/account/deletion`,
    {
      authorization: { scheme: "sites-session" },
      fields: [],
    },
  );
}

function accountDeletionStatusRejection(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  status: 400 | 503 = 400,
): Response {
  return hypermediaError(
    request,
    status === 503 ? "service_unavailable" : "invalid_request",
    "The account deletion status is unavailable",
    status,
    {
      links: [
        link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
        link("privacy-policy", `${config.issuerUrl}/privacy`, {
          type: HYPERMEDIA_MEDIA_TYPE,
        }),
      ],
    },
  );
}

async function readAccountDeletionSubmission(
  request: Request,
): Promise<AccountDeletionSubmissionResult> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const form = await readForm(request, ACCOUNT_DELETION_REQUEST_MAX_BYTES);
      const entries = [...form.entries()];
      if (
        entries.length !== 3 ||
        new Set(entries.map(([name]) => name)).size !== 3
      ) {
        return { ok: false, status: 400 };
      }
      return accountDeletionSubmissionFromUnknown(Object.fromEntries(entries));
    }
    if (!isJsonMediaType(contentType)) return { ok: false, status: 415 };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await readBoundedRequestBody(request, ACCOUNT_DELETION_REQUEST_MAX_BYTES),
    );
    return accountDeletionSubmissionFromUnknown(JSON.parse(text) as unknown);
  } catch {
    return { ok: false, status: 400 };
  }
}

function accountDeletionSubmissionFromUnknown(
  value: unknown,
): AccountDeletionSubmissionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400 };
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 3 ||
    typeof input.confirmation !== "string" ||
    typeof input.confirmation_token !== "string" ||
    typeof input.csrf_token !== "string"
  ) {
    return { ok: false, status: 400 };
  }
  return {
    ok: true,
    value: {
      confirmation: input.confirmation,
      confirmationToken: input.confirmation_token,
      csrfToken: input.csrf_token,
    },
  };
}

function accountDeletionRejection(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  status: 400 | 415 | 503 = 400,
): Response {
  return hypermediaError(
    request,
    status === 503 ? "service_unavailable" : "invalid_request",
    "The account deletion request could not be accepted",
    status,
    {
      links: [
        link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
        link("session", `${config.issuerUrl}/session`, {
          type: HYPERMEDIA_MEDIA_TYPE,
        }),
        link("privacy-policy", `${config.issuerUrl}/privacy`, {
          type: HYPERMEDIA_MEDIA_TYPE,
        }),
      ],
    },
  );
}

function nudgeAccountDeletionCoordinator(
  store: AuthStore,
  bucket: R2Bucket,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): void {
  const work = coordinateAccountDeletionBatch(
    store,
    bucket,
    undefined,
    (phase) => console.error(accountDeletionCoordinatorFailureTelemetry(phase)),
    (phase) => console.warn(accountDeletionCoordinatorDeferredTelemetry(phase)),
    (phase) => console.error(accountCredentialPurgeFailureTelemetry(phase)),
  ).then(
    () => undefined,
    () => undefined,
  );
  try {
    ctx.waitUntil(work);
  } catch {
    void work;
  }
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

function featureUnavailableResponse(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  feature: string,
): Response {
  return hypermediaError(
    request,
    "feature_unavailable",
    `${feature} is disabled for this deployment`,
    503,
    {
      links: [
        link("service", config.issuerUrl, { type: HYPERMEDIA_MEDIA_TYPE }),
        link("privacy-policy", `${config.issuerUrl}/privacy`, {
          type: HYPERMEDIA_MEDIA_TYPE,
        }),
        link("documentation", `${config.issuerUrl}/docs`, {
          type: "text/html",
        }),
      ],
      actions: [
        action("open-service", "Open service", "GET", config.issuerUrl, {
          fields: [],
        }),
      ],
    },
  );
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

async function applicationEventItemRoute(
  request: Request,
  id: string,
  store: AuthStore,
  config: ReturnType<typeof loadConfig>,
  identityProvider: UpstreamIdentityProvider,
): Promise<Response> {
  let endpointRequest = request;
  if (
    !bearerToken(request) &&
    (acceptsHtml(request) || identityProvider.read(request) !== null)
  ) {
    const accessToken = await issueBrowserSessionAccessToken(
      request,
      identityProvider,
      store,
      config,
      ["events.read"],
    );
    if (accessToken instanceof Response) return accessToken;
    const headers = new Headers({ authorization: `Bearer ${accessToken}` });
    const accept = request.headers.get("accept");
    if (accept) headers.set("accept", accept);
    endpointRequest = new Request(request.url, { headers });
  }

  const response = await applicationEventItemEndpoint(
    endpointRequest,
    id,
    store,
    config,
  );
  if (!acceptsHtml(request)) return response;
  if (response.status === 404) {
    return html(
      errorPage("Event not found", "Event not found", {
        status: 404,
        error: "not_found",
        actions: [
          { href: `${config.issuerUrl}/events`, label: "Back to events" },
        ],
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  }
  if (!response.ok) return response;

  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as { data?: unknown } | null;
  if (!payload || !isApplicationEventData(payload.data)) {
    return oauthError("server_error", "Unexpected server error", 500);
  }
  return html(
    applicationEventItemPage(payload.data, `${config.issuerUrl}/events`),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
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
  if (grantType === "client_credentials") {
    response = await issueClientCredentialsToken({
      config,
      store,
      client,
      requestedScope: form.get("scope"),
      now: nowSeconds(),
    });
  } else if (client.type === "service") {
    response = oauthError(
      "unauthorized_client",
      "Service clients can use only client_credentials",
    );
  } else if (grantType === "authorization_code") {
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
        verified.claims.sub,
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
  if (client.type === "public")
    return oauthError("invalid_client", "Client authentication required", 401);
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
  if (!client || client.disabledAt || isBrowserSessionClientId(client.id))
    return negotiatedFormError(
      request,
      "invalid_request",
      "Client is unavailable",
      400,
    );
  const scopeError = validateScopes(
    parseScopes(grant.scope),
    client,
    config.features.events,
  );
  if (scopeError)
    return negotiatedFormError(request, "invalid_scope", scopeError, 400);
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
  const client = await store.getClient(grant.clientId);
  if (!client || client.disabledAt)
    return negotiatedFormError(
      request,
      "invalid_request",
      "Client is unavailable",
      400,
    );
  const scopeError = validateScopes(
    parseScopes(grant.scope),
    client,
    config.features.events,
  );
  if (scopeError)
    return negotiatedFormError(request, "invalid_scope", scopeError, 400);
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
  if (!client || client.disabledAt || isBrowserSessionClientId(client.id))
    return negotiatedFormError(
      request,
      "invalid_request",
      "Client is unavailable",
      400,
    );
  const scopeError = validateScopes(
    parseScopes(authRequest.scope),
    client,
    config.features.events,
  );
  if (scopeError)
    return negotiatedFormError(request, "invalid_scope", scopeError, 400);
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
  const client = await store.getClient(authRequest.clientId);
  if (!client || client.disabledAt)
    return negotiatedFormError(
      request,
      "invalid_request",
      "Client is unavailable",
      400,
    );
  const scopeError = validateScopes(
    parseScopes(authRequest.scope),
    client,
    config.features.events,
  );
  if (scopeError)
    return negotiatedFormError(request, "invalid_scope", scopeError, 400);
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
  const clients = await store.listClients();
  const resultCookie = readAdminResultCookie(request);
  const result = resultCookie
    ? await consumeAdminResult(resultCookie, admin.user.id, config, store)
    : null;
  const csrf = csrfTokenForRequest(request);
  return adminClientsResponse(
    request,
    config,
    clients,
    csrf,
    createAdminSubmissionToken(),
    result,
    Boolean(resultCookie),
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
    return adminClientsError(
      request,
      config.issuerUrl,
      "invalid_request",
      "Same-origin form submission is required",
      403,
    );
  }
  let form: URLSearchParams;
  try {
    form = await readForm(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "unsupported_media_type") {
      return adminClientsError(
        request,
        config.issuerUrl,
        "invalid_request",
        "Unsupported content type",
        415,
      );
    }
    if (message === "request_too_large") {
      return adminClientsError(
        request,
        config.issuerUrl,
        "invalid_request",
        "Request is too large",
        413,
      );
    }
    throw error;
  }
  if (!validCsrf(request, form)) {
    return adminClientsError(
      request,
      config.issuerUrl,
      "invalid_request",
      "CSRF validation failed",
      403,
    );
  }
  if (form.has("action")) {
    const action = parseAdminClientOperation(form.get("action"));
    if (!action) {
      return adminClientsError(
        request,
        config.issuerUrl,
        "invalid_request",
        "Unsupported administrative action",
        400,
      );
    }
    const clientId = form.get("client_id") || "";
    const client = await store.getClient(clientId);
    if (!client || isBrowserSessionClientId(clientId)) {
      return adminClientsError(
        request,
        config.issuerUrl,
        "not_found",
        "Client is unavailable",
        404,
      );
    }
    if (!hasAdminClientControl(client, action)) {
      return adminClientsError(
        request,
        config.issuerUrl,
        "invalid_request",
        "Client operation is unavailable in its current state",
        409,
      );
    }
    const submissionToken = await claimAdminSubmission(
      form,
      admin.user.id,
      store,
    );
    if (!submissionToken) {
      return adminClientsError(
        request,
        config.issuerUrl,
        "invalid_request",
        "Administrative submission is unavailable or already used",
        409,
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
      await auditAdminMutation(store, action, clientId, admin);
      return adminMutationSuccess(
        request,
        config,
        store,
        admin.user.id,
        submissionToken,
        { operation: action, clientId, secret },
      );
    }
    await auditAdminMutation(store, action, clientId, admin);
    return adminMutationSuccess(
      request,
      config,
      store,
      admin.user.id,
      submissionToken,
      { operation: action, clientId },
    );
  }
  const requestedType = form.get("type");
  if (
    requestedType !== "public" &&
    requestedType !== "confidential" &&
    requestedType !== "service"
  ) {
    return adminClientsError(
      request,
      config.issuerUrl,
      "invalid_request",
      "Invalid client type",
      400,
    );
  }
  const input: ClientRegistrationInput = {
    type: requestedType,
    name: form.get("name") || "",
    redirectUris: splitLines(form.get("redirect_uris") || ""),
    scopes: parseScopes(
      (requestedType === "service"
        ? form.get("service_scopes")
        : form.get("interactive_scopes")) ??
        form.get("scopes") ??
        "openid email profile",
    ),
    origins: splitLines(form.get("origins") || ""),
  };
  const validationError = validateClientRegistrationInput(
    input,
    config.features.events,
  );
  if (validationError) {
    return adminClientsError(
      request,
      config.issuerUrl,
      "invalid_request",
      validationError,
      400,
    );
  }
  const submissionToken = await claimAdminSubmission(
    form,
    admin.user.id,
    store,
  );
  if (!submissionToken) {
    return adminClientsError(
      request,
      config.issuerUrl,
      "invalid_request",
      "Administrative submission is unavailable or already used",
      409,
    );
  }
  const result = await createClientRegistration(input, store, nowSeconds(), {
    eventsEnabled: config.features.events,
  });
  await auditAdminMutation(store, "create", result.client.id, admin);
  return adminMutationSuccess(
    request,
    config,
    store,
    admin.user.id,
    submissionToken,
    {
      operation: "create",
      clientId: result.client.id,
      ...(result.secret ? { secret: result.secret } : {}),
    },
  );
}

async function requireAdminIdentity(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
  identityProvider: UpstreamIdentityProvider,
): Promise<{ user: LocalUser; authorizationSource: "subject" } | Response> {
  const identity = identityProvider.read(request);
  if (!identity) {
    if (acceptsHtml(request))
      return requireSitesIdentity(request, identityProvider) as Response;
    return hypermediaError(
      request,
      "login_required",
      "ChatGPT sign-in inside ChatGPT Sites is required",
      401,
      {
        links: [
          link("service", config.issuerUrl, {
            type: HYPERMEDIA_MEDIA_TYPE,
          }),
          link("documentation", `${config.issuerUrl}/docs`, {
            type: "text/html",
          }),
        ],
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
  try {
    await requireActiveSubject(store, user.id);
  } catch (error) {
    if (!isSubjectAuthorizationDenied(error)) throw error;
    return acceptsHtml(request)
      ? html(
          errorPage("Forbidden", "Administrative access is not allowed", {
            status: 403,
            error: "forbidden",
          }),
          { status: 403 },
        )
      : hypermediaError(
          request,
          "forbidden",
          "Administrative access is not allowed",
          403,
        );
  }
  if (!config.adminSubjects.includes(user.id)) {
    return acceptsHtml(request)
      ? html(
          errorPage(
            "Forbidden",
            "Administrative access is not allowed for this account",
            { status: 403, error: "forbidden" },
          ),
          { status: 403 },
        )
      : hypermediaError(
          request,
          "forbidden",
          "Administrative access is not allowed for this account",
          403,
          {
            links: [
              link("service", config.issuerUrl, {
                type: HYPERMEDIA_MEDIA_TYPE,
              }),
              link("documentation", `${config.issuerUrl}/docs`, {
                type: "text/html",
              }),
            ],
          },
        );
  }
  return {
    user,
    authorizationSource: "subject",
  };
}

async function auditAdminMutation(
  store: AuthStore,
  actionName: string,
  clientId: string,
  admin: {
    user: LocalUser;
    authorizationSource: "subject";
  },
): Promise<void> {
  await store.audit(
    "admin.client.mutated",
    {
      action: actionName,
      client_reference: await sha256(clientId),
      identity_source: admin.authorizationSource,
    },
    nowSeconds(),
    { actorSubjectHash: await sha256(admin.user.id) },
  );
}

function adminClientsResponse(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  clients: readonly ClientView[],
  csrf: string,
  submissionToken: string,
  result: AdminMutationResult | null,
  clearResult = false,
): Response {
  const headers = new Headers({ "set-cookie": csrfCookie(csrf) });
  if (clearResult) headers.append("set-cookie", clearAdminResultCookie());
  if (acceptsHtml(request)) {
    return html(
      adminClientsPage(
        clients,
        csrf,
        submissionToken,
        result,
        availableOAuthScopes(config.features.events),
        availableServiceClientScopes(config.features.events),
      ),
      { headers },
    );
  }
  return hypermediaJson(
    request,
    adminClientsDocument(
      config.issuerUrl,
      clients,
      csrf,
      submissionToken,
      result,
      config.features.events,
    ),
    { headers },
  );
}

function adminClientsDocument(
  issuer: string,
  clients: readonly ClientView[],
  csrf: string,
  submissionToken: string,
  result: AdminMutationResult | null,
  eventsEnabled: boolean,
) {
  const operationFields = (clientId: string, operation: string) => [
    field("csrf_token", "CSRF token", "string", "body", {
      required: true,
      secret: true,
      value: csrf,
    }),
    field("submission_token", "One-time submission token", "string", "body", {
      required: true,
      secret: true,
      value: submissionToken,
      description: "Use this value once and refresh the collection after use.",
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
          field(
            "submission_token",
            "One-time submission token",
            "string",
            "body",
            {
              required: true,
              secret: true,
              value: submissionToken,
              description:
                "Use this value once and refresh the collection after use.",
            },
          ),
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
              { value: "service", title: "Service" },
            ],
          }),
          field("redirect_uris", "Exact redirect URIs", "string", "body", {
            description:
              "One URI per line for interactive clients; empty for service clients.",
          }),
          field("scopes", "Allowed scopes", "string", "body", {
            required: true,
            value: "storage.read storage.write storage.delete",
            description: `Space-separated scopes. Interactive clients may use: ${availableOAuthScopes(eventsEnabled).join(" ")}. Service clients may use only: ${availableServiceClientScopes(eventsEnabled).join(" ")}.`,
          }),
          field("origins", "Allowed browser origins", "string", "body", {
            description:
              "One exact origin per line for interactive clients; empty for service clients.",
          }),
        ],
      },
    ),
  ];
  for (const client of clients) {
    for (const control of adminClientControls(client)) {
      actions.push(
        action(
          control.name,
          `${control.label} ${client.name}`,
          "POST",
          `${issuer}/admin/clients`,
          {
            type: "application/x-www-form-urlencoded",
            authorization: { scheme: "sites-session" },
            fields: operationFields(client.id, control.operation),
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
      ...(result
        ? {
            operation_result: {
              operation: result.operation,
              client_id: result.clientId,
            },
            ...(result.secret
              ? {
                  new_client_secret_client_id: result.clientId,
                  new_client_secret: result.secret,
                  secret_displayed_once: true,
                }
              : {}),
          }
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

async function adminMutationSuccess(
  request: Request,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
  adminSubject: string,
  submissionToken: string,
  result: AdminMutationResult,
): Promise<Response> {
  if (acceptsHtml(request)) {
    const sealedResult = await sealAdminResult(
      submissionToken,
      result,
      adminSubject,
      config,
      nowSeconds(),
    );
    const response = redirect("/admin/clients", 303);
    response.headers.append("set-cookie", adminResultCookie(sealedResult));
    return response;
  }
  return adminClientsResponse(
    request,
    config,
    await store.listClients(),
    csrfTokenForRequest(request),
    createAdminSubmissionToken(),
    result,
  );
}

async function claimAdminSubmission(
  form: URLSearchParams,
  adminSubject: string,
  store: AuthStore,
): Promise<string | null> {
  const submissionToken = form.get("submission_token");
  if (!isAdminSubmissionToken(submissionToken)) return null;
  const now = nowSeconds();
  return (await store.claimAdminOperationSubmission(
    await sha256(submissionToken),
    adminSubject,
    now,
    now + ADMIN_SUBMISSION_TTL_SECONDS,
  ))
    ? submissionToken
    : null;
}

async function consumeAdminResult(
  cookie: string,
  adminSubject: string,
  config: ReturnType<typeof loadConfig>,
  store: AuthStore,
): Promise<AdminMutationResult | null> {
  const now = nowSeconds();
  const opened = await openAdminResult(cookie, adminSubject, config, now);
  if (!opened) return null;
  return (await store.consumeAdminOperationResult(
    await sha256(opened.submissionToken),
    adminSubject,
    now,
  ))
    ? opened.result
    : null;
}

function adminClientsError(
  request: Request,
  issuer: string,
  error: string,
  description: string,
  status: number,
): Response {
  if (acceptsHtml(request)) {
    return html(
      errorPage(titleForError(error, status), description, { status, error }),
      { status },
    );
  }
  return hypermediaError(request, error, description, status, {
    links: [
      link("service", issuer, { type: HYPERMEDIA_MEDIA_TYPE }),
      link("client-collection", `${issuer}/admin/clients`, {
        type: HYPERMEDIA_MEDIA_TYPE,
      }),
      link("documentation", `${issuer}/docs`, { type: "text/html" }),
    ],
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
    pathname === "/privacy" ||
    pathname === "/statistics" ||
    pathname === "/session" ||
    pathname === "/account/deletion" ||
    pathname === "/auth-ui.css" ||
    pathname === "/auth-ui.js" ||
    pathname === "/.well-known/openid-configuration" ||
    pathname === "/.well-known/jwks.json" ||
    pathname === "/authorize" ||
    pathname.startsWith("/oauth/") ||
    pathname === "/userinfo" ||
    isEventsRoute(pathname) ||
    pathname.startsWith("/storage/") ||
    pathname === "/openapi.json" ||
    pathname === "/docs" ||
    pathname === "/device" ||
    pathname === "/device/decision" ||
    pathname === "/consent" ||
    pathname.startsWith("/admin/")
  );
}

function isRecordsRoute(pathname: string): boolean {
  return (
    pathname === "/storage/records" || pathname.startsWith("/storage/records/")
  );
}

function isFilesRoute(pathname: string): boolean {
  return (
    pathname === "/storage/files" || pathname.startsWith("/storage/files/")
  );
}

function isEventsRoute(pathname: string): boolean {
  return pathname === "/events" || pathname.startsWith("/events/");
}

const BROWSER_ONLY_MUTATION_ROUTES = new Set([
  "/account/deletion",
  "/userinfo",
  "/device",
  "/device/decision",
  "/consent",
  "/admin/clients",
]);

const DUAL_PROTOCOL_BROWSER_ROUTES = new Set([
  "/oauth/device_authorization",
  "/oauth/token",
  "/oauth/revoke",
  "/oauth/introspect",
]);

function rejectInvalidBrowserMutationOrigin(
  request: Request,
  url: URL,
  canonicalOrigin: string,
): Response | null {
  if (
    !isPreBodyBrowserMutation(request, url) ||
    requireSameOrigin(request, canonicalOrigin)
  ) {
    return null;
  }
  return negotiatedFormError(
    request,
    "invalid_request",
    "Same-origin form submission is required",
    403,
  );
}

function isPreBodyBrowserMutation(request: Request, url: URL): boolean {
  if (request.method !== "POST") return false;
  if (BROWSER_ONLY_MUTATION_ROUTES.has(url.pathname)) return true;
  if (DUAL_PROTOCOL_BROWSER_ROUTES.has(url.pathname)) {
    return acceptsHtml(request);
  }
  if (!isRecordsRoute(url.pathname) && !isFilesRoute(url.pathname)) {
    return false;
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  return (
    acceptsHtml(request) ||
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  );
}

function isExternalOAuthInitiationRoute(pathname: string): boolean {
  return (
    pathname === "/authorize" ||
    pathname === "/oauth/device_authorization" ||
    pathname === "/device" ||
    pathname === "/device/decision" ||
    pathname === "/consent"
  );
}

function rejectUntrustedBrowserFileMultipart(
  request: Request,
  url: URL,
  identityProvider: UpstreamIdentityProvider,
): Response | null {
  if (
    request.method !== "POST" ||
    !isFilesRoute(url.pathname) ||
    !request.headers.get("content-type")?.includes("multipart/form-data")
  ) {
    return null;
  }
  const identity = requireSitesIdentity(request, identityProvider);
  return identity instanceof Response ? identity : null;
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
    pathname === "/privacy" ||
    pathname === "/statistics" ||
    pathname === "/session" ||
    pathname === "/account/deletion" ||
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
  if (isEventsRoute(pathname)) return true;
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
    pathname === "/privacy" ||
    pathname === "/statistics" ||
    pathname === "/session" ||
    pathname === "/account/deletion" ||
    pathname === "/device" ||
    pathname === "/device/decision" ||
    pathname === "/consent" ||
    pathname.startsWith("/admin/") ||
    isEventsRoute(pathname) ||
    pathname.startsWith("/storage/")
  );
}

export function scheduleCleanup(
  store: AuthStore,
  bucket: R2Bucket | undefined,
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  now: number,
  telemetryEnabled: boolean,
): void {
  if (!ctx || now < nextCleanupAt) return;
  nextCleanupAt = now + CLEANUP_INTERVAL_SECONDS;
  const cleanup = Promise.resolve()
    .then(() => store.cleanup(now))
    .then((report) => {
      if (telemetryEnabled) console.info(cleanupTelemetryPayload(report));
    })
    .catch(() => {
      console.error(CLEANUP_FAILURE_EVENT);
    });
  ctx.waitUntil(cleanup);
  if (bucket) ctx.waitUntil(repairStorageFileOrphans(store, bucket, now));
}

function isCorsControlledRoute(pathname: string): boolean {
  return (
    pathname === "/statistics" ||
    pathname.startsWith("/oauth/") ||
    pathname === "/userinfo" ||
    isEventsRoute(pathname) ||
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
  return (
    pathname === "/userinfo" ||
    isEventsRoute(pathname) ||
    pathname.startsWith("/storage/")
  );
}

function needsStore(pathname: string): boolean {
  return ![
    "/",
    "/health",
    "/privacy",
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
