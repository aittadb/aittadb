const storageKeyParameter = {
  name: "key",
  in: "path",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 240 },
  description: "Application-defined logical object key.",
} as const;

const hypermediaVendorType = "application/vnd.aittadb+json; version=0.1";

function hypermediaContent(schema: string, includeHtml = true) {
  return {
    "application/json": { schema: { $ref: schema } },
    [hypermediaVendorType]: {
      schema: { $ref: schema },
      examples: {
        versioned: {
          summary: "AittaDB Hypermedia JSON preview contract",
          value: { api_version: "0.1" },
        },
      },
    },
    ...(includeHtml ? { "text/html": { schema: { type: "string" } } } : {}),
  };
}

const representationFormatParameter = {
  name: "format",
  in: "query",
  required: false,
  schema: { type: "string", enum: ["json"] },
  description:
    "Force canonical JSON when a browser Accept header would otherwise select HTML.",
} as const;

const notAcceptableResponse = {
  description:
    "No supported HTML, compatible JSON, or versioned AittaDB hypermedia representation matches Accept. OAuth/OIDC protocol responses and file bytes retain their standards-defined media types instead.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/HypermediaError" },
    },
  },
} as const;

const storageBrowserKeyParameter = {
  name: "key",
  in: "query",
  required: false,
  schema: { type: "string", minLength: 1, maxLength: 240 },
  description:
    "No-JavaScript browser navigation fallback. An HTML request without a bearer token is redirected to the canonical encoded item URL; API collection reads ignore this parameter.",
} as const;

const storagePageSizeParameter = {
  name: "page_size",
  in: "query",
  required: false,
  schema: { type: "integer", minimum: 1 },
  description:
    "Maximum number of resources returned on this page. The value must not exceed the deployment-configured maximum; the server uses its configured default when omitted.",
} as const;

const storageCursorParameter = {
  name: "cursor",
  in: "query",
  required: false,
  schema: { type: "string", minLength: 1 },
  description:
    "Opaque encrypted continuation cursor from the preceding collection response's next link. For a collection that is not mutated during traversal, following only returned next links visits every authorized item exactly once in bounded pages. Authenticated encryption binds the cursor to the resource kind, local user, and OAuth client; it exposes no logical key, timestamp, local-user identifier, OAuth-client identifier, or signing secret and must not be constructed or reused across namespaces. Rotating the private signing-key material immediately invalidates outstanding cursors.",
} as const;

const tokenBoundCorsDescription =
  "For a cross-origin bearer request, Origin must exactly match an allowed origin registered on the active OAuth client identified by the token audience. A preflight is admitted only for an origin registered to at least one active client; the eventual request is still checked against its token's client. Wildcards are not accepted.";

const browserMutationOriginDescription =
  "For an HTML/browser form representation, AittaDB validates the shared same-origin policy before reading the request body, applying rate limits, consulting repositories, accessing R2, or scheduling maintenance. CSRF is then validated independently after the bounded form body is parsed. Standards-defined machine requests and raw bearer storage uploads remain governed by their protocol authentication and CORS rules.";

function rateLimitedResponse(includeHypermedia = false) {
  return {
    description:
      "A deployment rate limit was exceeded. Retry only after the response's Retry-After interval.",
    headers: {
      "Retry-After": {
        description: "Seconds until this request family may be retried.",
        schema: { type: "integer", minimum: 1 },
      },
    },
    content: includeHypermedia
      ? hypermediaContent("#/components/schemas/HypermediaError")
      : {
          "application/json": {
            schema: { $ref: "#/components/schemas/HypermediaError" },
          },
          "text/html": { schema: { type: "string" } },
        },
  } as const;
}

const recordsUnavailableResponse = {
  description:
    "The JSON Records feature is disabled by deployment configuration. The request is rejected before client lookup, authentication, rate limiting, request-body parsing, or record persistence. For create or replace operations, this status can also mean that storage writes are disabled.",
  content: hypermediaContent("#/components/schemas/HypermediaError"),
} as const;

const filesUnavailableResponse = {
  description:
    "The File Storage feature is disabled by deployment configuration. The request is rejected before client lookup, authentication, rate limiting, request-body parsing, D1 file-metadata work, R2 access, or cleanup scheduling. On enabled deployments, this status can also report the documented storage-write switch or R2 unavailability.",
  content: hypermediaContent("#/components/schemas/HypermediaError"),
} as const;

const oauthAppsAdministrationUnavailableResponse = {
  description:
    "Downstream OAuth Apps are disabled by deployment configuration. Client administration is rejected before Sites identity lookup, client repository access, rate limiting, request-body parsing, cleanup scheduling, or mutation. AittaDB's reserved current-session client remains private and available only to the internal signed-in-session adapter.",
  content: hypermediaContent("#/components/schemas/HypermediaError"),
} as const;

const oauthAppsInitiationUnavailableResponse = {
  description:
    "Downstream OAuth Apps are disabled by deployment configuration. Authorization Code and Device Grant initiation and their browser continuations are rejected before client lookup, request-body reading, CORS client lookup, rate limiting, Sites identity lookup, cleanup scheduling, or durable mutation. AittaDB's private signed-in session remains available.",
  content: hypermediaContent("#/components/schemas/HypermediaError"),
} as const;

const oauthAppsTokenUnavailableResponse = {
  description:
    "Downstream OAuth Apps are disabled by deployment configuration. Token GET and POST operations are rejected before request-body reading, CORS client lookup, rate limiting, client authentication, credential lookup or consumption, cleanup scheduling, or durable mutation. POST returns a no-store OAuth temporarily_unavailable error; AittaDB's private signed-in session remains available.",
  content: {
    "application/json": {
      schema: {
        oneOf: [
          { $ref: "#/components/schemas/OAuthError" },
          { $ref: "#/components/schemas/HypermediaError" },
        ],
      },
    },
    [hypermediaVendorType]: {
      schema: { $ref: "#/components/schemas/HypermediaError" },
    },
    "text/html": { schema: { type: "string" } },
  },
} as const;

const oauthAppsLifecycleUnavailableResponse = {
  description:
    "Downstream OAuth Apps are disabled by deployment configuration. Revocation and introspection GET and POST operations are rejected before request-body reading, rate limiting, client authentication, token lookup, revocation, audit or cleanup mutation, or other durable work. POST returns a no-store OAuth temporarily_unavailable error, and issuer discovery omits both endpoints.",
  content: {
    "application/json": {
      schema: {
        oneOf: [
          { $ref: "#/components/schemas/OAuthError" },
          { $ref: "#/components/schemas/HypermediaError" },
        ],
      },
    },
    [hypermediaVendorType]: {
      schema: { $ref: "#/components/schemas/HypermediaError" },
    },
    "text/html": { schema: { type: "string" } },
  },
} as const;

const oauthAppsOidcUnavailableResponse = {
  description:
    "Downstream OAuth Apps are disabled by deployment configuration. UserInfo GET and POST operations are rejected before request-body reading, bearer-token parsing or verification, Sites identity lookup, CORS client lookup, rate limiting, cleanup scheduling, or durable work. Issuer metadata retains only the issuer and public ES256 verification-key metadata needed to validate AittaDB's private session JWTs.",
  content: hypermediaContent("#/components/schemas/HypermediaError"),
} as const;

const storageQuotaExceededResponse = {
  description:
    "The write would exceed a finite deployment-wide, local-user, or user-and-client namespace item or byte limit. A rejected file write commits no metadata; any already-uploaded uncommitted R2 object is retired immediately or queued once for private bounded repair without exposing its physical key.",
  content: hypermediaContent("#/components/schemas/HypermediaError"),
} as const;

const storageConflictResponse = {
  description:
    "The file changed concurrently. The stale mutation did not replace or delete the newer winner; any unreferenced physical object was retired immediately or queued for private bounded repair.",
  content: hypermediaContent("#/components/schemas/HypermediaError"),
} as const;

const boundedFormTooLargeResponse = {
  description:
    "The URL-encoded request body exceeds its finite route limit. A valid declared overflow is rejected without reading the stream; missing, malformed, or undersized Content-Length values do not bypass the streaming byte bound.",
  content: hypermediaContent("#/components/schemas/HypermediaError"),
} as const;

const boundedRecordTooLargeResponse = {
  description:
    "The JSON record body exceeds 64 KiB. Declared and streamed overflow returns invalid_request before JSON parsing, client lookup, rate limiting, or storage repository access.",
  content: hypermediaContent("#/components/schemas/HypermediaError"),
} as const;

const boundedFileTooLargeResponse = {
  description:
    "Canonical raw file bytes exceed 10 MiB. A valid declared overflow is rejected without reading the stream; missing, malformed, or undersized Content-Length values do not bypass the observed-byte limit, and overflow stops before R2 or D1 file-metadata mutation.",
  content: hypermediaContent("#/components/schemas/HypermediaError"),
} as const;

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "AittaDB",
    version: "0.1.0",
    license: { name: "FSL-1.1-MIT" },
    description:
      "AittaDB is a source-available project providing a hosted application backend for third-party apps, services, and agents. Current public releases use FSL-1.1-MIT and become MIT-licensed two years after publication; an MIT license for immediate use is also available commercially. Its current implementation depends on OpenAI-hosted ChatGPT Sites for runtime, ChatGPT sign-in, D1, R2, configuration, and secrets. Within that platform boundary, AittaDB maps the server-side ChatGPT sign-in signal to a separate local user, issues its own OAuth 2.0, OpenID Connect, and JWT credentials, and provides user-and-client-isolated JSON records in D1 and files in R2. Those credentials and stored data belong to AittaDB, are not OpenAI or ChatGPT credentials or data, and ChatGPT credentials are never forwarded. AittaDB is not affiliated with or endorsed by OpenAI. Persistent events and long-polling delivery are planned and are not part of the current MVP. Browser-only forms require a present, independently verified same-origin signal plus a host-only CSRF session cookie; the validated token remains stable across concurrently open operation pages. Application resources negotiate HTML, compatible JSON, or versioned hypermedia using Accept and return 406 when none is acceptable; standards-defined OAuth/OIDC and binary responses retain their protocol media types.",
  },
  paths: {
    "/": {
      get: {
        summary: "Service metadata or browser overview",
        description:
          "Returns hypermedia service metadata, including AittaDB's licensing posture and current ChatGPT Sites platform dependency, or a concise browser overview. Explicit application/json and the versioned vendor media type select JSON; explicit HTML selects HTML; an absent or otherwise indifferent Accept field selects the public HTML overview so link-preview clients can read its Open Graph metadata. Selection never uses User-Agent.",
        responses: {
          "200": {
            description: "AittaDB service metadata",
            content: hypermediaContent("#/components/schemas/ServiceDocument"),
          },
          "406": notAcceptableResponse,
        },
      },
    },
    "/health": {
      get: {
        summary: "Service health",
        responses: {
          "200": {
            description: "Current binding health without secret values",
            content: hypermediaContent("#/components/schemas/HealthDocument"),
          },
          "406": notAcceptableResponse,
        },
      },
    },
    "/privacy": {
      get: {
        summary: "Privacy Policy for this AittaDB deployment",
        description:
          "Returns the deployment operator's privacy notice as accessible HTML or versioned hypermedia JSON. Explicit public contact configuration takes precedence; when required contact values are absent, the service may resolve the first allowlisted local administrator subject to its stored email and optional display name. The subject identifier and allowlist are never returned. Each independent deployment operator must review the policy against its own applications, agreements, providers, and applicable law.",
        responses: {
          "200": {
            description: "Current deployment Privacy Policy",
            content: hypermediaContent(
              "#/components/schemas/PrivacyPolicyDocument",
            ),
          },
          "503": {
            description:
              "No valid explicit contact or resolvable administrator fallback is available; the response contains no configuration or identity details",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "406": notAcceptableResponse,
        },
      },
    },
    "/statistics": {
      get: {
        summary: "Privacy-preserving public service statistics",
        description:
          "Returns only the aggregate number of durable local AittaDB identities in this deployment when FEATURE_STATISTICS_ENABLED is true. When disabled, the operation returns a content-negotiated 503 feature_unavailable response before any aggregate query. It never returns names, email addresses, subjects, activity, client dimensions, storage data, or deployment secrets. Responses are not cached.",
        responses: {
          "200": {
            description: "Aggregate local identity count",
            content: hypermediaContent(
              "#/components/schemas/StatisticsDocument",
            ),
          },
          "503": {
            description:
              "Statistics are disabled by deployment configuration, which returns feature_unavailable before any aggregate query, or D1 is unavailable",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "406": notAcceptableResponse,
        },
      },
    },
    "/session": {
      get: {
        summary: "Current AittaDB local session",
        description:
          "Uses the server-side ChatGPT sign-in signal supplied inside the trusted Sites runtime to locate or create an immutable local AittaDB user. Browsers without that upstream session are sent through the Sites-owned sign-in route. A local subject with any internal account-deletion job receives the same generic authentication failure and no new internal session. An active non-administrator session advertises the protected account-deletion request in equivalent HTML and hypermedia controls only when its required background dependencies are available; its short-lived encrypted confirmation value exposes no subject or email. This does not return or forward ChatGPT credentials.",
        responses: {
          "200": {
            description: "Current local AittaDB identity",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/LocalSessionDocument",
                },
              },
              [hypermediaVendorType]: {
                schema: {
                  $ref: "#/components/schemas/LocalSessionDocument",
                },
              },
              "text/html": { schema: { type: "string" } },
            },
          },
          "302": { description: "Continue to Sites-owned ChatGPT sign-in" },
          "401": { description: "No upstream browser session for JSON client" },
          "406": notAcceptableResponse,
        },
      },
    },
    "/account/deletion": {
      get: {
        summary: "Read deletion status for the accepted local account",
        description:
          "Reads a seven-day, host-only HttpOnly status cookie issued only by the first accepted POST and the exact trusted ChatGPT Sites email signal. AES-GCM authenticated encryption and a distinct HKDF purpose bind the handle to this issuer, configured key ID, key material, exact email, and encrypted former local subject. The handler decrypts and validates the handle before any repository work and resolves the old subject directly from it; it never calls getUserByEmail or findOrCreateUser. Missing, expired, malformed, tampered, key/issuer-mismatched, or switched-account handles fail generically without D1, R2, cleanup, rate-limit, or coordinator work. A valid handle performs one exact deletion-job lookup. Representations contain only pending, running, retry, or completed. Pending/running expose only refresh, retry exposes only same-URI recovery, and completed exposes only the Sites-owned sign-out transition so this operation cannot create a replacement account. Each non-completed success schedules exactly one caught bounded coordinator pass; completed and error responses schedule none.",
        "x-aittadb-sites-identity-required": true,
        parameters: [
          {
            name: "aittadb_account_deletion_status",
            in: "cookie",
            required: true,
            description:
              "Encrypted host-only status handle. Browsers receive it as HttpOnly, Secure, SameSite=Lax, Path=/account/deletion with a seven-day maximum age.",
            schema: { type: "string", minLength: 1, maxLength: 512 },
          },
        ],
        responses: {
          "200": {
            description:
              "The coarse status and its single currently valid refresh, recovery, or Sites sign-out action. No subject, email, attempt, timestamp, count, namespace, client, storage, identity, or credential value is returned.",
            content: hypermediaContent(
              "#/components/schemas/AccountDeletionStatusDocument",
            ),
          },
          "400": {
            description:
              "The trusted identity, encrypted handle, binding, lifetime, or matching deletion job is unavailable. Cryptographically invalid cases perform no repository or background work; all cases share one coarse no-store response.",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "503": {
            description:
              "A cryptographically valid handle cannot be served because D1 is unavailable, or its non-completed job cannot be nudged because R2 or waitUntil is unavailable. No coordinator pass is scheduled.",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "406": notAcceptableResponse,
        },
      },
      post: {
        summary: "Request deletion of the current local AittaDB account",
        description:
          "Starts deletion only for the existing local user resolved from the current trusted ChatGPT Sites identity. The adapter never creates or updates an identity. Before body parsing it requires the shared same-origin browser policy; it then enforces a body limit of 1 KiB, a matching CSRF cookie/body value, an explicit confirmation phrase, and a short-lived AES-GCM confirmation bound to this issuer, purpose, exact local subject, and exact trusted email. Administrators, missing or changed identities, stale cross-account forms, invalid confirmations, and existing jobs fail generically without exposing account state. Before the first atomic start, it seals a separate seven-day status handle with a distinct HKDF/AES-GCM purpose. The first accepted response sets that host-only HttpOnly status cookie and schedules one bounded account-deletion coordinator pass through waitUntil. Acceptance blocks account access but does not report completion or define re-registration.",
        "x-aittadb-sites-identity-required": true,
        requestBody: {
          description:
            "Same-origin and CSRF-protected input. Both encodings have the same strict three-field contract and are stream-bounded to 1 KiB.",
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                $ref: "#/components/schemas/AccountDeletionRequestInput",
              },
            },
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AccountDeletionRequestInput",
              },
            },
          },
        },
        responses: {
          "202": {
            description:
              "Deletion was accepted, one bounded background pass was scheduled, and a distinct encrypted status cookie was issued. The representation contains only a coarse accepted flag and status action, with no subject, job, attempt, timestamp, count, namespace, client, storage, identity, or credential value.",
            headers: {
              "Set-Cookie": {
                description:
                  "Host-only aittadb_account_deletion_status handle scoped with HttpOnly, Secure, SameSite=Lax, Path=/account/deletion, and Max-Age=604800.",
                schema: { type: "string" },
              },
            },
            content: hypermediaContent(
              "#/components/schemas/AccountDeletionAcceptedDocument",
            ),
          },
          "400": {
            description:
              "The identity, local user, confirmation phrase/token, CSRF value, or one-time start condition was unavailable. Sensitive cases share one generic response and create no additional job.",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "403": {
            description:
              "The same-origin browser signal was absent or invalid; rejection occurs before body reading, rate limiting, identity lookup, repository work, R2 access, or maintenance scheduling.",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "413": {
            description:
              "The URL-encoded or JSON request body exceeds 1 KiB. Declared and streamed overflow is rejected before rate limiting or identity/repository work.",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "415": {
            description:
              "The request is neither URL-encoded form data nor JSON.",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "429": rateLimitedResponse(true),
          "503": {
            description:
              "The database, R2 binding, or background execution context required to start and nudge deletion is unavailable. No deletion job is started.",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "406": notAcceptableResponse,
        },
      },
    },
    "/.well-known/openid-configuration": {
      get: {
        summary: "OpenID Provider metadata",
        description:
          "When downstream OAuth Apps are enabled, this is the complete issuer discovery document. When disabled, it intentionally contains only issuer, jwks_uri, and the supported ES256 verification algorithm; it advertises no grants, authorization endpoint, token endpoint, lifecycle endpoint, scopes, claims, or UserInfo operation.",
        parameters: [representationFormatParameter],
        responses: {
          "200": {
            description: "OIDC metadata or readable browser representation",
            content: {
              "application/json": { schema: { type: "object" } },
              "text/html": { schema: { type: "string" } },
            },
          },
        },
      },
    },
    "/.well-known/jwks.json": {
      get: {
        summary: "JSON Web Key Set",
        description:
          "Always publishes only the configured public P-256 verification JWK, including when downstream OAuth Apps are disabled, so AittaDB's own session JWTs remain externally verifiable. The private JWK is never returned and this route performs no D1 work.",
        parameters: [representationFormatParameter],
        responses: {
          "200": {
            description:
              "Public ES256 signing keys or readable browser representation",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/JsonWebKeySet" },
              },
              "text/html": { schema: { type: "string" } },
            },
          },
        },
      },
    },
    "/authorize": {
      get: {
        summary:
          "OAuth 2.0 Authorization Code with PKCE authorization endpoint",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. Disabled deployments return feature_unavailable locally without trusting a redirect URI or creating authorization state.",
        parameters: [
          {
            name: "response_type",
            in: "query",
            schema: { const: "code" },
            required: false,
            description:
              "Required with client_id to begin a protocol authorization request; omit all request parameters to retrieve the operation resource.",
          },
          {
            name: "client_id",
            in: "query",
            schema: { type: "string" },
            required: false,
          },
          {
            name: "redirect_uri",
            in: "query",
            schema: { type: "string", format: "uri" },
            required: false,
          },
          { name: "scope", in: "query", schema: { type: "string" } },
          { name: "state", in: "query", schema: { type: "string" } },
          { name: "nonce", in: "query", schema: { type: "string" } },
          {
            name: "code_challenge",
            in: "query",
            schema: { type: "string", minLength: 43, maxLength: 43 },
            required: false,
          },
          {
            name: "code_challenge_method",
            in: "query",
            schema: { const: "S256" },
            required: false,
          },
        ],
        responses: {
          "200": {
            description:
              "Operation resource or browser request form when no client request parameters are supplied",
            content: hypermediaContent(
              "#/components/schemas/ProtocolEndpointDocument",
            ),
          },
          "302": {
            description:
              "Continues to same-origin consent or redirects an OAuth error",
          },
          "429": rateLimitedResponse(),
          "503": oauthAppsInitiationUnavailableResponse,
        },
      },
    },
    "/oauth/device_authorization": {
      get: {
        summary: "Device Authorization Grant operation resource",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. Returns hypermedia controls or an HTML form that posts to the production device authorization operation. API clients may follow the advertised POST action.",
        responses: {
          "200": {
            description: "Device authorization operation",
            content: hypermediaContent(
              "#/components/schemas/ProtocolEndpointDocument",
            ),
          },
          "503": oauthAppsInitiationUnavailableResponse,
        },
      },
      post: {
        summary: "OAuth 2.0 Device Authorization Grant endpoint",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. Disabled deployments reject the request before reading its body, authenticating a client, rate limiting, or creating a device grant.",
        requestBody: {
          description: browserMutationOriginDescription,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["client_id"],
                properties: {
                  client_id: { type: "string" },
                  client_secret: {
                    type: "string",
                    description: "Required only for confidential clients.",
                  },
                  scope: { type: "string" },
                  ui: {
                    type: "string",
                    const: "1",
                    description:
                      "Browser-only representation marker. Requires csrf_token and same-origin submission.",
                  },
                  csrf_token: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Device code response or readable HTML result",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/DeviceAuthorizationResponse",
                },
              },
              "text/html": { schema: { type: "string" } },
            },
          },
          "400": { description: "OAuth error" },
          "403": { description: "Browser CSRF or same-origin rejection" },
          "413": boundedFormTooLargeResponse,
          "429": rateLimitedResponse(),
          "503": oauthAppsInitiationUnavailableResponse,
        },
      },
    },
    "/oauth/token": {
      get: {
        summary: "Token exchange operation resource",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. Returns hypermedia controls or an HTML form for the production token operation. A grant-specific action field with required=true is required only while its visible_when condition matches the selected grant; inactive HTML controls are disabled and not required.",
        responses: {
          "200": {
            description: "Token operation",
            content: hypermediaContent(
              "#/components/schemas/ProtocolEndpointDocument",
            ),
          },
          "503": oauthAppsTokenUnavailableResponse,
        },
      },
      post: {
        summary:
          "OAuth 2.0 token endpoint for device, authorization_code, refresh_token, and client_credentials grants",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. Disabled deployments reject every grant before reading the body or accessing client and credential state. A service client authenticates with its secret and may use client_credentials to obtain a short-lived access token limited to its registered storage scopes and isolated service namespace; this grant returns no user claims, ID token, or refresh token. Service clients cannot use interactive grants. When enabled, a cross-origin preflight is allowed only for an exact origin registered on an active interactive OAuth client, so service clients are server-to-server only. The actual request is bound to the client_id or HTTP Basic client before any authorization code, device code, or refresh token is consumed; a foreign origin is rejected without changing that credential. Every interactive token grant rejects an inactive local subject generically; refresh exchange creates no successor after that denial.",
        requestBody: {
          description: browserMutationOriginDescription,
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["grant_type"],
                properties: {
                  grant_type: {
                    type: "string",
                    enum: [
                      "urn:ietf:params:oauth:grant-type:device_code",
                      "authorization_code",
                      "refresh_token",
                      "client_credentials",
                    ],
                  },
                  client_id: { type: "string" },
                  client_secret: { type: "string" },
                  device_code: { type: "string" },
                  code: { type: "string" },
                  redirect_uri: { type: "string", format: "uri" },
                  code_verifier: {
                    type: "string",
                    minLength: 43,
                    maxLength: 128,
                  },
                  refresh_token: { type: "string" },
                  scope: {
                    type: "string",
                    description:
                      "Optional subset of the service client's registered storage scopes for client_credentials.",
                  },
                  ui: { type: "string", const: "1" },
                  csrf_token: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Protocol-standard JSON token response or deliberate one-time HTML credential result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TokenResponse" },
              },
              "text/html": { schema: { type: "string" } },
            },
          },
          "400": { description: "OAuth error" },
          "401": { description: "Client authentication failed" },
          "403": { description: "Browser CSRF or same-origin rejection" },
          "413": boundedFormTooLargeResponse,
          "429": rateLimitedResponse(),
          "503": oauthAppsTokenUnavailableResponse,
        },
      },
    },
    "/oauth/revoke": {
      get: {
        summary: "Token revocation operation resource",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. Disabled deployments omit this endpoint from issuer discovery and expose no revocation form or action.",
        responses: {
          "200": {
            description: "Revocation operation",
            content: hypermediaContent(
              "#/components/schemas/ProtocolEndpointDocument",
            ),
          },
          "503": oauthAppsLifecycleUnavailableResponse,
        },
      },
      post: {
        summary: "Token revocation",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. Disabled deployments reject before reading or mutating client, token, revocation, or audit state. When enabled, the owning public, confidential, or service client authenticates as at the token endpoint. Access tokens are revoked by verified jti; opaque refresh tokens revoke their family. An omitted or incorrect token_type_hint is treated only as a lookup hint, and success never discloses prior token state.",
        requestBody: {
          description: browserMutationOriginDescription,
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["token"],
                properties: {
                  token: { type: "string" },
                  token_type_hint: { type: "string" },
                  client_id: { type: "string" },
                  client_secret: { type: "string" },
                  ui: { type: "string", const: "1" },
                  csrf_token: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Revocation accepted",
            content: {
              "application/json": { schema: { type: "object" } },
              "text/html": { schema: { type: "string" } },
            },
          },
          "400": { description: "Malformed request body or OAuth error" },
          "413": boundedFormTooLargeResponse,
          "429": rateLimitedResponse(),
          "503": oauthAppsLifecycleUnavailableResponse,
        },
      },
    },
    "/oauth/introspect": {
      get: {
        summary: "Token introspection operation resource",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. Disabled deployments omit this endpoint from issuer discovery and expose no introspection form or action.",
        responses: {
          "200": {
            description: "Introspection operation",
            content: hypermediaContent(
              "#/components/schemas/ProtocolEndpointDocument",
            ),
          },
          "503": oauthAppsLifecycleUnavailableResponse,
        },
      },
      post: {
        summary: "Token introspection for secret-bearing clients",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. Disabled deployments reject before reading or authenticating a client or looking up token state. When enabled, only a signed, unexpired AittaDB access-token JWT whose token_use is access and whose audience is the authenticated confidential or service client can be active. ID tokens, opaque refresh tokens, tokens for another client, revoked tokens, and invalid JWTs return active false without disclosing why.",
        security: [{ clientSecretBasic: [] }],
        requestBody: {
          description: browserMutationOriginDescription,
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["token"],
                properties: {
                  token: { type: "string" },
                  token_type_hint: { type: "string" },
                  client_id: { type: "string" },
                  client_secret: { type: "string" },
                  ui: { type: "string", const: "1" },
                  csrf_token: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Introspection result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/IntrospectionResponse" },
              },
              "text/html": { schema: { type: "string" } },
            },
          },
          "401": { description: "Client authentication failed" },
          "400": { description: "Malformed request body or OAuth error" },
          "413": boundedFormTooLargeResponse,
          "429": rateLimitedResponse(),
          "503": oauthAppsLifecycleUnavailableResponse,
        },
      },
    },
    "/userinfo": {
      get: {
        summary: "OpenID Connect UserInfo",
        description: `Available only when FEATURE_OAUTH_APPS_ENABLED is true. Disabled deployments reject the operation before bearer lookup or durable work and do not advertise it in discovery or session representations. API clients send an AittaDB bearer access token containing the openid scope. The token audience must identify an existing active OAuth client; ID tokens, tokens for disabled or missing clients, and access tokens without openid are rejected with the same generic invalid-token response. A browser requesting HTML without a bearer token receives a same-origin form that can use either the current ChatGPT-signed-in AittaDB session or an explicit access token. ${tokenBoundCorsDescription}`,
        security: [{ bearer: [] }],
        responses: {
          "200": {
            description:
              "Local user claims, an operation resource when no bearer token is supplied with the vendor media type, or the equivalent HTML interface",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UserInfo" },
              },
              [hypermediaVendorType]: {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/UserInfo" },
                    {
                      $ref: "#/components/schemas/ProtocolEndpointDocument",
                    },
                  ],
                },
              },
              "text/html": { schema: { type: "string" } },
            },
          },
          "401": {
            description:
              "Invalid bearer token, missing openid scope, unknown audience client, or disabled audience client",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "503": oauthAppsOidcUnavailableResponse,
        },
      },
      post: {
        summary: "Browser-only UserInfo form submission",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. Uses either the current signed-in browser session or an explicit bearer token from a CSRF-protected same-origin form, then invokes the same UserInfo validation as GET. The current-session credential is short-lived, internal, and never returned to the page. Disabled deployments reject before reading the form or looking up identity or tokens. Non-browser clients should use GET with Authorization: Bearer.",
        requestBody: {
          description: browserMutationOriginDescription,
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["ui", "csrf_token", "auth_mode"],
                properties: {
                  ui: { type: "string", const: "1" },
                  csrf_token: { type: "string" },
                  auth_mode: {
                    type: "string",
                    enum: ["session", "token"],
                    description:
                      "Current ChatGPT-signed-in AittaDB session or an explicitly supplied AittaDB access token.",
                  },
                  access_token: {
                    type: "string",
                    description: "Required only when auth_mode is token.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Standard UserInfo JSON or its equivalent readable browser representation",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UserInfo" },
              },
              "text/html": { schema: { type: "string" } },
            },
          },
          "401": { description: "Invalid AittaDB access token" },
          "302": {
            description:
              "Redirect to the Sites-owned ChatGPT sign-in route when session mode is selected anonymously",
          },
          "403": { description: "CSRF or same-origin rejection" },
          "405": { description: "Browser representation marker missing" },
          "400": { description: "Malformed request body" },
          "413": boundedFormTooLargeResponse,
          "503": oauthAppsOidcUnavailableResponse,
        },
      },
    },
    "/storage/records": {
      get: {
        summary:
          "List JSON records for the access token's local user and OAuth client",
        description: `Requires an AittaDB access token with storage.read for API use. An HTML request without a bearer token renders this collection's list and item-navigation interface. Records are AittaDB application storage; they do not expose ChatGPT or OpenAI data. Results use encrypted cursor pagination and report aggregate record-and-file usage only for the authenticated local-user and OAuth-client namespace. ${tokenBoundCorsDescription}`,
        parameters: [
          storageBrowserKeyParameter,
          storagePageSizeParameter,
          storageCursorParameter,
        ],
        security: [{ bearer: [] }],
        responses: {
          "200": {
            description:
              "Record collection for bearer clients or a protected browser operation form when no Authorization header is present",
            content: hypermediaContent(
              "#/components/schemas/StorageCollectionDocument",
            ),
          },
          "400": { description: "Invalid page_size or storage cursor" },
          "401": { description: "Invalid bearer token" },
          "403": { description: "Missing storage.read scope" },
          "429": rateLimitedResponse(true),
          "503": recordsUnavailableResponse,
        },
      },
      post: {
        summary: "Browser-only JSON record collection read",
        description:
          "CSRF-protected same-origin form action for this exact collection URL. The fixed _method=GET override invokes the canonical collection GET. Item reads, writes, and deletes post only to /storage/records/{key}. Current-session mode creates a minimal short-lived internal access token for the signed-in local UUID and reserved browser client; token mode uses the submitted AittaDB access token. Neither credential is returned to HTML.",
        requestBody: {
          description: browserMutationOriginDescription,
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["ui", "csrf_token", "_method", "auth_mode"],
                properties: {
                  ui: { type: "string", const: "1" },
                  csrf_token: { type: "string" },
                  _method: { type: "string", const: "GET" },
                  auth_mode: {
                    type: "string",
                    enum: ["session", "token"],
                  },
                  access_token: {
                    type: "string",
                    description: "Required only when auth_mode is token.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Readable result from the production storage route",
            content: hypermediaContent(
              "#/components/schemas/StorageCollectionDocument",
            ),
          },
          "302": {
            description:
              "Redirect to the Sites-owned ChatGPT sign-in route when session mode is selected anonymously",
          },
          "403": { description: "Scope, CSRF, or same-origin rejection" },
          "400": { description: "Malformed request body" },
          "405": { description: "Browser representation marker missing" },
          "413": boundedFormTooLargeResponse,
          "429": rateLimitedResponse(true),
          "503": recordsUnavailableResponse,
          "507": storageQuotaExceededResponse,
        },
      },
    },
    "/storage/records/{key}": {
      get: {
        summary: "Read one JSON record",
        description: `A bearer request performs the canonical read. An HTML request without a bearer token renders read, replace, and delete forms for only the key in this exact resource URL. ${tokenBoundCorsDescription}`,
        security: [{ bearer: [] }],
        parameters: [storageKeyParameter],
        responses: {
          "200": {
            description:
              "Storage record or a browser operation form when no Authorization header is present",
            content: hypermediaContent(
              "#/components/schemas/StorageRecordDocument",
            ),
          },
          "404": { description: "Record not found" },
          "429": rateLimitedResponse(true),
          "503": recordsUnavailableResponse,
        },
      },
      post: {
        summary: "Browser-only action on one JSON record",
        description:
          "CSRF-protected same-origin adapter on this exact item URL. _method selects the canonical GET, PUT, or DELETE operation; the logical key comes only from the URL and cannot be overridden by a form field. Current-session and explicit AittaDB access-token modes preserve the canonical storage scope and ownership checks.",
        parameters: [storageKeyParameter],
        requestBody: {
          description: browserMutationOriginDescription,
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["ui", "csrf_token", "_method", "auth_mode"],
                properties: {
                  ui: { type: "string", const: "1" },
                  csrf_token: { type: "string" },
                  _method: {
                    type: "string",
                    enum: ["GET", "PUT", "DELETE"],
                  },
                  auth_mode: {
                    type: "string",
                    enum: ["session", "token"],
                  },
                  access_token: {
                    type: "string",
                    description: "Required only when auth_mode is token.",
                  },
                  value: {
                    type: "string",
                    description: "Required JSON text only when _method is PUT.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Readable result from the canonical item operation",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/StorageRecordDocument" },
                    { $ref: "#/components/schemas/StorageDeletionDocument" },
                  ],
                },
              },
              [hypermediaVendorType]: {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/StorageRecordDocument" },
                    { $ref: "#/components/schemas/StorageDeletionDocument" },
                  ],
                },
              },
              "text/html": { schema: { type: "string" } },
            },
          },
          "302": { description: "Continue to Sites-owned ChatGPT sign-in" },
          "400": {
            description:
              "Malformed request body or method override does not match this resource",
          },
          "403": { description: "Scope, CSRF, or same-origin rejection" },
          "413": boundedFormTooLargeResponse,
          "429": rateLimitedResponse(true),
          "503": recordsUnavailableResponse,
          "507": storageQuotaExceededResponse,
        },
      },
      put: {
        summary: "Create or replace one JSON record",
        description: `Requires storage.write. The request body must be JSON and is stored in D1 under the local user UUID and client ID. Writes are subject to finite deployment-wide, local-user, and user-and-client namespace item and byte limits and to the deployment storage-write switch. ${tokenBoundCorsDescription}`,
        security: [{ bearer: [] }],
        parameters: [storageKeyParameter],
        requestBody: {
          required: true,
          content: { "application/json": { schema: true } },
        },
        responses: {
          "200": {
            description: "Stored record",
            content: hypermediaContent(
              "#/components/schemas/StorageRecordDocument",
              false,
            ),
          },
          "400": { description: "Malformed JSON request body" },
          "413": boundedRecordTooLargeResponse,
          "415": { description: "JSON content type is required" },
          "429": rateLimitedResponse(true),
          "503": recordsUnavailableResponse,
          "507": storageQuotaExceededResponse,
        },
      },
      delete: {
        summary: "Delete one JSON record",
        description: `Requires storage.delete. Deletion remains available when new storage writes are disabled. ${tokenBoundCorsDescription}`,
        security: [{ bearer: [] }],
        parameters: [storageKeyParameter],
        responses: {
          "200": {
            description: "Deleted",
            content: hypermediaContent(
              "#/components/schemas/StorageDeletionDocument",
              false,
            ),
          },
          "429": rateLimitedResponse(true),
          "503": recordsUnavailableResponse,
        },
      },
    },
    "/storage/files": {
      get: {
        summary:
          "List file metadata for the access token's local user and OAuth client",
        description: `Requires storage.read for API use. An HTML request without a bearer token renders this collection's list and item-navigation interface. File bytes are stored in R2 and searchable logical metadata is stored in D1; physical R2 keys are never returned. Results use encrypted cursor pagination and report aggregate record-and-file usage only for the authenticated local-user and OAuth-client namespace. ${tokenBoundCorsDescription}`,
        parameters: [
          storageBrowserKeyParameter,
          storagePageSizeParameter,
          storageCursorParameter,
        ],
        security: [{ bearer: [] }],
        responses: {
          "200": {
            description:
              "File metadata collection for bearer clients or a protected browser operation form when no Authorization header is present",
            content: hypermediaContent(
              "#/components/schemas/StorageCollectionDocument",
            ),
          },
          "400": { description: "Invalid page_size or storage cursor" },
          "401": { description: "Invalid bearer token" },
          "403": { description: "Missing storage.read scope" },
          "429": rateLimitedResponse(true),
          "503": filesUnavailableResponse,
        },
      },
      post: {
        summary: "Create a file or submit the browser file-collection form",
        description: `A bearer API request uploads raw bytes and creates a file under a server-generated logical UUID key. Bearer JSON/hypermedia and explicit access-token HTML responses return 201 Created with the exact item Location. A successful current-session HTML upload accepts an absolute Location only from the request or configured issuer origin, validates the exact /storage/files/{key} path, and constructs 303 See Other on the request origin so refresh performs only the canonical item GET. A missing, malformed, or foreign target retains the non-redirect 201 result. The same URL also accepts the CSRF-protected no-JavaScript collection-read adapter. Multipart parsing requires a trusted ChatGPT Sites identity first, including when the form later selects explicit-token mode; raw bearer API uploads do not require a Sites browser session. Caller-selected logical keys use PUT /storage/files/{key} instead. File creation is subject to finite deployment-wide, local-user, and user-and-client namespace item and byte limits and to the deployment storage-write switch. ${tokenBoundCorsDescription}`,
        security: [{ bearer: [] }],
        requestBody: {
          description: browserMutationOriginDescription,
          required: true,
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["ui", "csrf_token", "_method", "auth_mode"],
                properties: {
                  ui: { type: "string", const: "1" },
                  csrf_token: { type: "string" },
                  _method: { type: "string", const: "GET" },
                  auth_mode: {
                    type: "string",
                    enum: ["session", "token"],
                  },
                  access_token: {
                    type: "string",
                    description: "Required only when auth_mode is token.",
                  },
                },
              },
            },
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["ui", "csrf_token", "_method", "auth_mode", "file"],
                properties: {
                  ui: { type: "string", const: "1" },
                  csrf_token: { type: "string" },
                  _method: { type: "string", const: "POST" },
                  auth_mode: {
                    type: "string",
                    enum: ["session", "token"],
                  },
                  access_token: {
                    type: "string",
                    description: "Required only when auth_mode is token.",
                  },
                  file: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description:
              "Created file metadata and canonical item location for bearer JSON/hypermedia, explicit-token HTML, or a safe current-session HTML fallback",
            headers: {
              Location: {
                description: "Absolute canonical URL for the generated key.",
                schema: { type: "string", format: "uri" },
              },
            },
            content: hypermediaContent(
              "#/components/schemas/StorageFileDocument",
            ),
          },
          "200": {
            description:
              "Readable collection result for the browser _method=GET adapter",
            content: hypermediaContent(
              "#/components/schemas/StorageCollectionDocument",
            ),
          },
          "302": {
            description:
              "Redirect to the Sites-owned ChatGPT sign-in route when session mode is selected anonymously",
          },
          "303": {
            description:
              "Successful current-session HTML upload redirects to the validated canonical item GET",
            headers: {
              Location: {
                description:
                  "Absolute same-origin canonical URL for the generated key.",
                schema: { type: "string", format: "uri" },
              },
            },
          },
          "400": { description: "Malformed request body" },
          "403": { description: "Scope, CSRF, or same-origin rejection" },
          "409": storageConflictResponse,
          "405": { description: "Browser representation marker missing" },
          "413": {
            description:
              "The URL-encoded or multipart browser wrapper exceeds its finite limit, or canonical raw file bytes exceed 10 MiB. Raw-byte overflow is stream-bounded before R2 or D1 file-metadata mutation.",
          },
          "429": rateLimitedResponse(true),
          "503": filesUnavailableResponse,
          "507": storageQuotaExceededResponse,
        },
      },
    },
    "/storage/files/{key}": {
      get: {
        summary: "Read one file from R2",
        description: `A bearer request returns the canonical file bytes. An HTML request without a bearer token renders download, upload-or-replace, and delete forms for only the key in this exact resource URL. ${tokenBoundCorsDescription}`,
        security: [{ bearer: [] }],
        parameters: [storageKeyParameter],
        responses: {
          "200": {
            description:
              "File bytes for bearer clients or a browser operation form when no Authorization header is present",
            headers: {
              "content-disposition": {
                description:
                  "Attachment disposition with a sanitized fallback filename and RFC 5987 encoded logical-key filename.",
                schema: { type: "string" },
              },
              "x-aittadb-storage-key": {
                description: "Percent-encoded logical application key.",
                schema: { type: "string" },
              },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StorageFileDocument" },
              },
              [hypermediaVendorType]: {
                schema: { $ref: "#/components/schemas/StorageFileDocument" },
              },
              "application/octet-stream": {
                schema: { type: "string", format: "binary" },
              },
              "text/html": { schema: { type: "string" } },
            },
          },
          "404": { description: "File not found" },
          "429": rateLimitedResponse(true),
          "503": filesUnavailableResponse,
        },
      },
      post: {
        summary: "Browser-only action on one stored file",
        description:
          "CSRF-protected same-origin adapter on this exact item URL. URL-encoded _method=GET or DELETE invokes the canonical download or deletion. Multipart _method=PUT requires a trusted ChatGPT Sites identity before parsing and uploads bytes through the canonical file PUT. The logical key comes only from the URL and cannot be overridden by a form field.",
        parameters: [storageKeyParameter],
        requestBody: {
          description: browserMutationOriginDescription,
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["ui", "csrf_token", "_method", "auth_mode"],
                properties: {
                  ui: { type: "string", const: "1" },
                  csrf_token: { type: "string" },
                  _method: { type: "string", enum: ["GET", "DELETE"] },
                  auth_mode: {
                    type: "string",
                    enum: ["session", "token"],
                  },
                  access_token: {
                    type: "string",
                    description: "Required only when auth_mode is token.",
                  },
                },
              },
            },
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["ui", "csrf_token", "_method", "auth_mode", "file"],
                properties: {
                  ui: { type: "string", const: "1" },
                  csrf_token: { type: "string" },
                  _method: { type: "string", const: "PUT" },
                  auth_mode: {
                    type: "string",
                    enum: ["session", "token"],
                  },
                  access_token: {
                    type: "string",
                    description: "Required only when auth_mode is token.",
                  },
                  file: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Readable metadata/deletion result or original attachment bytes for download",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/StorageFileDocument" },
                    { $ref: "#/components/schemas/StorageDeletionDocument" },
                  ],
                },
              },
              [hypermediaVendorType]: {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/StorageFileDocument" },
                    { $ref: "#/components/schemas/StorageDeletionDocument" },
                  ],
                },
              },
              "text/html": { schema: { type: "string" } },
              "application/octet-stream": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          "302": { description: "Continue to Sites-owned ChatGPT sign-in" },
          "400": {
            description:
              "Malformed request body or method override does not match this resource",
          },
          "403": { description: "Scope, CSRF, or same-origin rejection" },
          "409": storageConflictResponse,
          "413": {
            description:
              "URL-encoded or multipart form, or canonical file bytes, exceed the applicable finite limit",
          },
          "415": { description: "Upload was not submitted as multipart data" },
          "429": rateLimitedResponse(true),
          "503": filesUnavailableResponse,
          "507": storageQuotaExceededResponse,
        },
      },
      put: {
        summary: "Create or replace one file in R2",
        description: `Requires storage.write. The caller's key is metadata only; AittaDB generates the physical R2 object key. Replacement uses copy-on-write bytes and a D1 compare-and-set against the observed physical key, so a stale writer receives 409 without changing a newer winner. Raw bytes are bounded from the observed request stream; Content-Length is only an early-rejection hint. Writes are subject to finite deployment-wide, local-user, and user-and-client namespace item and byte limits and to the deployment storage-write switch. ${tokenBoundCorsDescription}`,
        security: [{ bearer: [] }],
        parameters: [storageKeyParameter],
        requestBody: {
          required: true,
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        responses: {
          "200": {
            description: "Stored file metadata",
            content: hypermediaContent(
              "#/components/schemas/StorageFileDocument",
              false,
            ),
          },
          "400": {
            description:
              "The canonical raw-file request stream failed before the file could be buffered",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "413": boundedFileTooLargeResponse,
          "409": storageConflictResponse,
          "429": rateLimitedResponse(true),
          "503": filesUnavailableResponse,
          "507": storageQuotaExceededResponse,
        },
      },
      delete: {
        summary: "Delete one file from R2 and D1 metadata",
        description: `Requires storage.delete. Metadata deletion compares the observed physical key in D1, so a stale delete receives 409 without deleting a newer winner. Deletion remains available when new storage writes are disabled but needs R2 when metadata identifies an existing object. ${tokenBoundCorsDescription}`,
        security: [{ bearer: [] }],
        parameters: [storageKeyParameter],
        responses: {
          "200": {
            description: "Deleted",
            content: hypermediaContent(
              "#/components/schemas/StorageDeletionDocument",
              false,
            ),
          },
          "409": storageConflictResponse,
          "429": rateLimitedResponse(true),
          "503": filesUnavailableResponse,
        },
      },
    },
    "/auth-ui.css": {
      get: {
        summary: "Self-hosted authentication interface styles",
        description:
          "Internal same-origin static stylesheet used by AittaDB's minimal HTML representations.",
        responses: {
          "200": {
            description: "AittaDB interface stylesheet",
            content: { "text/css": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/auth-ui.js": {
      get: {
        summary: "Self-hosted progressive-enhancement script",
        description:
          "Internal same-origin JavaScript for conditional form controls and accessible file drag-and-drop. Core forms remain usable without it.",
        responses: {
          "200": {
            description: "AittaDB interface script",
            content: {
              "text/javascript": { schema: { type: "string" } },
            },
          },
        },
      },
    },
    "/device": {
      get: {
        summary: "Enter an RFC 8628 user code",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. Returns the same device-code entry resource as hypermedia JSON or accessible HTML. The subsequent review requires ChatGPT sign-in supplied by the trusted Sites runtime.",
        parameters: [
          {
            name: "user_code",
            in: "query",
            required: false,
            schema: { type: "string", minLength: 8, maxLength: 9 },
          },
        ],
        responses: {
          "200": {
            description: "Device-code entry resource",
            content: hypermediaContent(
              "#/components/schemas/DeviceCodeEntryDocument",
            ),
          },
          "503": oauthAppsInitiationUnavailableResponse,
        },
      },
      post: {
        summary: "Review a pending device authorization request",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. CSRF-protected same-origin transition. A valid code is resolved server-side and the trusted Sites identity is required; browser-supplied identity values are never accepted.",
        requestBody: {
          description: browserMutationOriginDescription,
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["csrf_token", "user_code"],
                properties: {
                  csrf_token: { type: "string" },
                  user_code: { type: "string", minLength: 8, maxLength: 9 },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Pending device request and approve/deny controls",
            content: hypermediaContent(
              "#/components/schemas/DeviceRequestDocument",
            ),
          },
          "302": { description: "Continue through Sites-owned sign-in" },
          "400": {
            description: "Invalid or expired user code",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "401": {
            description: "Trusted Sites browser identity is required",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "403": {
            description: "CSRF or same-origin rejection",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "413": boundedFormTooLargeResponse,
          "503": oauthAppsInitiationUnavailableResponse,
        },
      },
    },
    "/device/decision": {
      post: {
        summary: "Approve or deny a pending device request",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. One-time CSRF-protected decision by the trusted Sites-signed-in user. Terminal, expired, and unknown grants are rejected without exposing credentials.",
        requestBody: {
          description: browserMutationOriginDescription,
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["csrf_token", "user_code", "decision"],
                properties: {
                  csrf_token: { type: "string" },
                  user_code: { type: "string", minLength: 8, maxLength: 9 },
                  decision: {
                    type: "string",
                    enum: ["approve", "deny"],
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Terminal device decision",
            content: hypermediaContent(
              "#/components/schemas/DeviceDecisionDocument",
            ),
          },
          "302": { description: "Continue through Sites-owned sign-in" },
          "400": {
            description: "Request is no longer pending",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "401": {
            description: "Trusted Sites browser identity is required",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "403": {
            description: "CSRF or same-origin rejection",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "413": boundedFormTooLargeResponse,
          "503": oauthAppsInitiationUnavailableResponse,
        },
      },
    },
    "/consent": {
      get: {
        summary: "Review an authorization-code consent request",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. Returns consent controls when remembered consent does not already cover the exact client and local scopes. Existing exact consent immediately continues through a one-time authorization-code redirect.",
        parameters: [
          {
            name: "request_id",
            in: "query",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Authorization consent resource",
            content: hypermediaContent(
              "#/components/schemas/AuthorizationConsentDocument",
            ),
          },
          "302": {
            description:
              "Sites-owned sign-in continuation or standard OAuth redirect after remembered consent",
          },
          "400": {
            description:
              "Expired, terminal, invalid, or replayed authorization request; the error is returned locally without redirecting to the client",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "401": {
            description: "Trusted Sites browser identity is required",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "503": oauthAppsInitiationUnavailableResponse,
        },
      },
      post: {
        summary: "Approve or deny authorization consent",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. CSRF-protected same-origin decision followed by a standards-defined redirect to the exact registered client redirect URI. The redirect carries a one-time code or OAuth error, never an access token.",
        requestBody: {
          description: browserMutationOriginDescription,
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["csrf_token", "request_id", "decision"],
                properties: {
                  csrf_token: { type: "string" },
                  request_id: { type: "string", format: "uuid" },
                  decision: {
                    type: "string",
                    enum: ["approve", "deny"],
                  },
                },
              },
            },
          },
        },
        responses: {
          "302": {
            description:
              "Redirect to the exact registered client URI with a one-time code, state, or standard OAuth denial",
          },
          "400": {
            description:
              "Expired, terminal, invalid, or replayed authorization request; a concurrent loser is returned locally without redirecting to the client",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "401": {
            description: "Trusted Sites browser identity is required",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "403": {
            description: "CSRF or same-origin rejection",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "413": boundedFormTooLargeResponse,
          "503": oauthAppsInitiationUnavailableResponse,
        },
      },
    },
    "/admin/clients": {
      get: {
        summary: "List and manage registered OAuth clients",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. Administrative client data requires a trusted ChatGPT sign-in inside ChatGPT Sites whose AittaDB local UUID is present in the deployment's configured local-subject allowlist. Sites owns the browser sign-in mechanism, so this requirement is described by the x-aittadb-sites-identity-required extension instead of a caller-supplied OpenAPI credential. HTML forms and versioned hypermedia actions are derived from the same availability policy: active clients advertise disable, disabled clients advertise enable, confidential and service clients advertise secret rotation, and every listed client advertises grant revocation. A successful HTML mutation redirects here and may display its encrypted, atomically consumed result once; direct and later reads never repeat a client secret.",
        "x-aittadb-sites-identity-required": true,
        responses: {
          "200": {
            description: "OAuth client administration resource",
            content: hypermediaContent(
              "#/components/schemas/OAuthClientCollectionDocument",
            ),
          },
          "302": { description: "Continue through Sites-owned sign-in" },
          "401": {
            description: "Trusted Sites identity is missing",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "403": {
            description: "Signed-in identity is not allowlisted",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "429": rateLimitedResponse(true),
          "503": oauthAppsAdministrationUnavailableResponse,
          "406": notAcceptableResponse,
        },
      },
      post: {
        summary: "Create or operate on an OAuth client",
        description:
          "Available only when FEATURE_OAUTH_APPS_ENABLED is true. CSRF-protected same-origin administration for creation, enable/disable, confidential-or-service secret rotation, and active-grant revocation. Every operation requires trusted ChatGPT sign-in inside ChatGPT Sites and an AittaDB local UUID present in the configured local-subject allowlist. The server enforces the same state/type policy advertised by HTML and hypermedia controls. Every advertised action carries a one-time submission token; its hash is claimed atomically before mutation so replay cannot repeat the operation. JSON receives an immediate no-store result. HTML uses Post/Redirect/Get and a short-lived encrypted HttpOnly result cookie whose token hash is consumed atomically on the redirected GET. Generated secrets are tied to the affected client, never enter a URL or durable plaintext storage, and disappear after that result is consumed.",
        "x-aittadb-sites-identity-required": true,
        requestBody: {
          description: browserMutationOriginDescription,
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/OAuthClientCreateInput" },
                  { $ref: "#/components/schemas/OAuthClientOperationInput" },
                ],
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Updated JSON client collection, with a newly generated confidential or service secret only when applicable",
            content: hypermediaContent(
              "#/components/schemas/OAuthClientCollectionDocument",
              false,
            ),
          },
          "302": { description: "Continue through Sites-owned sign-in" },
          "303": {
            description:
              "Successful HTML mutation redirected to the client collection; refreshing the resulting GET does not repeat the POST",
            headers: {
              Location: {
                schema: { type: "string", const: "/admin/clients" },
              },
              "Set-Cookie": {
                description:
                  "Short-lived encrypted HttpOnly one-time result state. It contains no URL-visible or durable plaintext secret.",
                schema: { type: "string" },
              },
            },
          },
          "400": {
            description: "Invalid registration or operation input",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "401": {
            description: "Trusted Sites identity is missing",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "403": {
            description: "Allowlist, CSRF, or same-origin rejection",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "404": {
            description: "Client is unavailable",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "409": {
            description:
              "The requested operation is unavailable for the client's current state or type, or the one-time submission was already used",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "413": boundedFormTooLargeResponse,
          "415": {
            description: "Administrative form media type is unsupported",
            content: hypermediaContent("#/components/schemas/HypermediaError"),
          },
          "429": rateLimitedResponse(true),
          "503": oauthAppsAdministrationUnavailableResponse,
          "406": notAcceptableResponse,
        },
      },
    },
    "/openapi.json": {
      get: {
        summary: "OpenAPI 3.1 JSON",
        parameters: [representationFormatParameter],
        responses: {
          "200": {
            description:
              "Canonical OpenAPI document or readable browser representation",
            content: {
              "application/json": { schema: { type: "object" } },
              "text/html": { schema: { type: "string" } },
            },
          },
        },
      },
    },
    "/docs": {
      get: {
        summary: "Self-hosted interactive Swagger UI",
        description:
          "Loads the canonical /openapi.json document and calls real same-origin AittaDB routes. Browser assets are pinned and self-hosted; no CDN is used.",
        responses: {
          "200": {
            description: "Interactive HTML API viewer",
            content: { "text/html": { schema: { type: "string" } } },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "AittaDB access-token JWT only. ID tokens and refresh tokens are not bearer authorization credentials. Every consumer rejects a local subject with any internal account-deletion job using its generic invalid-credential response.",
      },
      clientSecretBasic: { type: "http", scheme: "basic" },
    },
    schemas: {
      HypermediaLink: {
        type: "object",
        required: ["rel", "href"],
        properties: {
          rel: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          href: { type: "string", format: "uri-reference" },
          type: { type: "string" },
          title: { type: "string" },
          templated: { type: "boolean" },
        },
        additionalProperties: false,
      },
      HypermediaFieldOption: {
        type: "object",
        required: ["value", "title"],
        properties: {
          value: { type: "string" },
          title: { type: "string" },
        },
        additionalProperties: false,
      },
      HypermediaFieldCondition: {
        type: "object",
        required: ["field", "value"],
        properties: {
          field: { type: "string" },
          value: { type: "string" },
        },
        additionalProperties: false,
      },
      HypermediaField: {
        type: "object",
        required: ["name", "title", "type", "location"],
        properties: {
          name: { type: "string" },
          title: { type: "string" },
          type: {
            type: "string",
            enum: ["string", "integer", "number", "boolean", "object", "file"],
          },
          location: {
            type: "string",
            enum: ["path", "query", "header", "body"],
          },
          required: {
            type: "boolean",
            description:
              "Whether the field is required while active. When visible_when is present, the requirement applies only when that condition matches.",
          },
          secret: { type: "boolean" },
          value: true,
          min: { type: "number" },
          max: { type: "number" },
          min_length: { type: "integer", minimum: 0 },
          max_length: { type: "integer", minimum: 0 },
          max_bytes: { type: "integer", minimum: 0 },
          options: {
            type: "array",
            items: { $ref: "#/components/schemas/HypermediaFieldOption" },
          },
          visible_when: {
            $ref: "#/components/schemas/HypermediaFieldCondition",
            description:
              "Condition that activates and displays this field. An inactive field is not required even when required is true.",
          },
          description: { type: "string" },
        },
        additionalProperties: false,
      },
      HypermediaAuthorization: {
        type: "object",
        required: ["scheme"],
        properties: {
          scheme: {
            type: "string",
            enum: ["none", "bearer", "basic", "sites-session"],
          },
          scopes: { type: "array", items: { type: "string" } },
          description: { type: "string" },
        },
        additionalProperties: false,
      },
      HypermediaAction: {
        type: "object",
        required: ["name", "title", "method", "href", "fields"],
        properties: {
          name: { type: "string" },
          title: { type: "string" },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          },
          href: { type: "string", format: "uri-reference" },
          type: { type: "string" },
          accept: { type: "string" },
          templated: { type: "boolean" },
          fields: {
            type: "array",
            items: { $ref: "#/components/schemas/HypermediaField" },
          },
          authorization: {
            $ref: "#/components/schemas/HypermediaAuthorization",
          },
          description: { type: "string" },
        },
        additionalProperties: false,
      },
      HypermediaDocument: {
        type: "object",
        required: ["api_version", "type", "data", "links", "actions"],
        properties: {
          api_version: { type: "string", const: "0.1" },
          type: { type: "string" },
          id: { type: "string" },
          data: true,
          links: {
            type: "array",
            items: { $ref: "#/components/schemas/HypermediaLink" },
          },
          actions: {
            type: "array",
            items: { $ref: "#/components/schemas/HypermediaAction" },
          },
        },
        additionalProperties: false,
      },
      ServiceMetadataData: {
        type: "object",
        required: [
          "service",
          "description",
          "hostingPlatform",
          "issuer",
          "docs",
          "openapi",
          "officialOpenAIProduct",
          "upstreamSignIn",
          "sessionIssuer",
          "features",
          "capabilities",
          "plannedCapabilities",
        ],
        properties: {
          service: { type: "string", const: "AittaDB" },
          description: { type: "string" },
          hostingPlatform: {
            type: "string",
            const: "OpenAI-hosted ChatGPT Sites",
            description:
              "The current implementation depends on this platform for runtime, ChatGPT sign-in, D1, R2, configuration, and secrets.",
          },
          issuer: { type: "string", format: "uri" },
          docs: { type: "string", format: "uri" },
          openapi: { type: "string", format: "uri" },
          officialOpenAIProduct: {
            type: "boolean",
            const: false,
            description:
              "False because AittaDB is not affiliated with or endorsed by OpenAI; this does not imply technical independence from ChatGPT Sites.",
          },
          upstreamSignIn: {
            type: "object",
            required: [
              "source",
              "identitySignal",
              "stableSubjectSupplied",
              "credentialsForwarded",
            ],
            properties: {
              source: {
                type: "string",
                const: "ChatGPT sign-in inside ChatGPT Sites",
              },
              identitySignal: { type: "string" },
              stableSubjectSupplied: { type: "boolean", const: false },
              credentialsForwarded: { type: "boolean", const: false },
            },
            additionalProperties: false,
          },
          sessionIssuer: { type: "string", const: "AittaDB" },
          features: {
            type: "object",
            description:
              "Effective deployment feature availability. These booleans are server-controlled and never reveal configuration values or secrets.",
            required: ["records", "files", "statistics", "oauthApps"],
            properties: {
              records: {
                type: "boolean",
                default: true,
                description:
                  "When false, record routes return 503 feature_unavailable before repository work and record controls are omitted from runtime discovery.",
              },
              files: {
                type: "boolean",
                default: true,
                description:
                  "When false, file routes return 503 feature_unavailable before D1 metadata, R2, or cleanup work and file controls are omitted from runtime discovery.",
              },
              statistics: {
                type: "boolean",
                default: true,
                description:
                  "When false, service discovery omits statistics controls and GET /statistics returns feature_unavailable before querying D1.",
              },
              oauthApps: { type: "boolean", default: false },
            },
            additionalProperties: false,
          },
          capabilities: { type: "array", items: { type: "string" } },
          plannedCapabilities: {
            type: "array",
            description:
              "Planned capabilities, including Events, that are not available in the current MVP.",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
      ServiceDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "service" },
              data: { $ref: "#/components/schemas/ServiceMetadataData" },
            },
          },
        ],
      },
      HealthDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "health" },
              data: {
                type: "object",
                required: ["ok", "service", "d1", "r2"],
                properties: {
                  ok: { type: "boolean" },
                  service: { type: "string", const: "aittadb" },
                  d1: { type: "boolean" },
                  r2: { type: "boolean" },
                },
                additionalProperties: false,
              },
            },
          },
        ],
      },
      PrivacyController: {
        type: "object",
        required: ["name", "email"],
        properties: {
          name: { type: "string", minLength: 1 },
          identifier: { type: "string", minLength: 1 },
          contact_name: { type: "string", minLength: 1 },
          email: { type: "string", format: "email" },
          phone: { type: "string", minLength: 1 },
          postal_address: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      PrivacyPolicySection: {
        type: "object",
        required: ["id", "title", "paragraphs"],
        properties: {
          id: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          paragraphs: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          items: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        },
        additionalProperties: false,
      },
      PrivacyPolicyReference: {
        type: "object",
        required: ["title", "href"],
        properties: {
          title: { type: "string", minLength: 1 },
          href: { type: "string", format: "uri" },
        },
        additionalProperties: false,
      },
      PrivacyPolicyData: {
        type: "object",
        required: [
          "title",
          "deployment",
          "controller",
          "sections",
          "references",
        ],
        properties: {
          title: { type: "string", const: "Privacy Policy" },
          deployment: { type: "string", format: "uri" },
          controller: { $ref: "#/components/schemas/PrivacyController" },
          sections: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/components/schemas/PrivacyPolicySection" },
          },
          references: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/components/schemas/PrivacyPolicyReference" },
          },
        },
        additionalProperties: false,
      },
      PrivacyPolicyDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "privacy-policy" },
              data: { $ref: "#/components/schemas/PrivacyPolicyData" },
            },
          },
        ],
      },
      StatisticsDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "service-statistics" },
              data: {
                type: "object",
                required: ["identity_count"],
                properties: {
                  identity_count: { type: "integer", minimum: 0 },
                },
                additionalProperties: false,
              },
            },
          },
        ],
      },
      JsonWebKeySet: {
        type: "object",
        required: ["keys"],
        properties: {
          keys: {
            type: "array",
            items: {
              type: "object",
              required: ["kty", "crv", "x", "y", "alg", "use", "kid"],
              properties: {
                kty: { type: "string", const: "EC" },
                crv: { type: "string", const: "P-256" },
                x: { type: "string" },
                y: { type: "string" },
                alg: { type: "string", const: "ES256" },
                use: { type: "string", const: "sig" },
                kid: { type: "string" },
              },
            },
          },
        },
      },
      DeviceAuthorizationResponse: {
        type: "object",
        required: [
          "device_code",
          "user_code",
          "verification_uri",
          "verification_uri_complete",
          "expires_in",
          "interval",
          "api_version",
          "links",
          "actions",
        ],
        properties: {
          device_code: { type: "string" },
          user_code: { type: "string" },
          verification_uri: { type: "string", format: "uri" },
          verification_uri_complete: { type: "string", format: "uri" },
          expires_in: { type: "integer" },
          interval: { type: "integer" },
          api_version: { type: "string", const: "0.1" },
          links: {
            type: "array",
            items: { $ref: "#/components/schemas/HypermediaLink" },
          },
          actions: {
            type: "array",
            items: { $ref: "#/components/schemas/HypermediaAction" },
          },
        },
        examples: [
          {
            device_code: "opaque-high-entropy-device-code",
            user_code: "ABCD-EFGH",
            verification_uri: "https://aittadb.com/device",
            verification_uri_complete:
              "https://aittadb.com/device?user_code=ABCD-EFGH",
            expires_in: 600,
            interval: 5,
          },
        ],
      },
      TokenResponse: {
        type: "object",
        required: ["access_token", "token_type", "expires_in", "scope"],
        properties: {
          access_token: { type: "string" },
          token_type: { type: "string", const: "Bearer" },
          expires_in: { type: "integer" },
          scope: { type: "string" },
          id_token: { type: "string" },
          refresh_token: { type: "string" },
        },
      },
      IntrospectionResponse: {
        type: "object",
        required: ["active"],
        properties: {
          active: { type: "boolean" },
          iss: { type: "string", format: "uri" },
          sub: { type: "string", format: "uuid" },
          aud: { type: "string" },
          exp: { type: "integer" },
          iat: { type: "integer" },
          nbf: { type: "integer" },
          jti: { type: "string", format: "uuid" },
          scope: { type: "string" },
          token_use: { type: "string", const: "access" },
          subject_type: {
            type: "string",
            const: "service",
            description:
              "Present only for a service-client access token; this is not a user identity.",
          },
          client_id: {
            type: "string",
            format: "uuid",
            description: "Present only for a service-client access token.",
          },
        },
      },
      HypermediaError: {
        type: "object",
        required: ["error", "api_version", "type", "data", "links", "actions"],
        properties: {
          error: { type: "string" },
          error_description: { type: "string" },
          api_version: { type: "string", const: "0.1" },
          type: { type: "string", const: "error" },
          data: {
            type: "object",
            required: ["error"],
            properties: {
              error: { type: "string" },
              error_description: { type: "string" },
            },
          },
          links: {
            type: "array",
            items: { $ref: "#/components/schemas/HypermediaLink" },
          },
          actions: {
            type: "array",
            items: { $ref: "#/components/schemas/HypermediaAction" },
          },
        },
      },
      OAuthError: { $ref: "#/components/schemas/HypermediaError" },
      LocalSessionData: {
        type: "object",
        required: [
          "authenticated",
          "user",
          "upstreamSignIn",
          "sessionIssuer",
          "credentialsForwarded",
        ],
        properties: {
          authenticated: { type: "boolean", const: true },
          user: {
            type: "object",
            required: ["sub", "email", "name", "created_at", "updated_at"],
            properties: {
              sub: { type: "string", format: "uuid" },
              email: { type: "string", format: "email" },
              name: { type: "string" },
              created_at: { type: "integer" },
              updated_at: { type: "integer" },
            },
          },
          upstreamSignIn: {
            type: "string",
            const: "ChatGPT sign-in inside ChatGPT Sites",
          },
          sessionIssuer: { type: "string", const: "AittaDB" },
          credentialsForwarded: { type: "boolean", const: false },
        },
        additionalProperties: false,
      },
      LocalSessionDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "local-session" },
              data: { $ref: "#/components/schemas/LocalSessionData" },
            },
          },
        ],
      },
      AccountDeletionRequestInput: {
        type: "object",
        required: ["csrf_token", "confirmation_token", "confirmation"],
        properties: {
          csrf_token: {
            type: "string",
            pattern: "^[A-Za-z0-9_-]{32}$",
            description:
              "Must exactly match the protected host-only CSRF cookie.",
          },
          confirmation_token: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            writeOnly: true,
            description:
              "Short-lived encrypted confirmation emitted only by the current session representation and bound to that exact local account and trusted email.",
          },
          confirmation: {
            type: "string",
            const: "delete my account",
          },
        },
        additionalProperties: false,
      },
      AccountDeletionAcceptedDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "account-deletion-request-accepted" },
              data: {
                type: "object",
                required: ["accepted"],
                properties: { accepted: { type: "boolean", const: true } },
                additionalProperties: false,
              },
            },
          },
        ],
      },
      AccountDeletionStatusDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "account-deletion-status" },
              data: {
                type: "object",
                required: ["status"],
                properties: {
                  status: {
                    type: "string",
                    enum: ["pending", "running", "retry", "completed"],
                  },
                },
                additionalProperties: false,
              },
            },
          },
        ],
      },
      ProtocolEndpointDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              data: {
                type: "object",
                required: ["title", "protocol_response"],
                properties: {
                  title: { type: "string" },
                  protocol_response: { type: "string" },
                },
              },
            },
          },
        ],
      },
      StorageRecordData: {
        type: "object",
        required: ["key", "value", "created_at", "updated_at"],
        properties: {
          key: { type: "string" },
          value: true,
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
        },
        additionalProperties: false,
      },
      StorageFileData: {
        type: "object",
        required: [
          "key",
          "content_type",
          "size",
          "sha256",
          "created_at",
          "updated_at",
        ],
        properties: {
          key: { type: "string" },
          content_type: { type: "string" },
          size: { type: "integer" },
          sha256: { type: "string" },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
        },
        additionalProperties: false,
      },
      StorageRecordDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "storage-record" },
              data: { $ref: "#/components/schemas/StorageRecordData" },
            },
          },
        ],
      },
      StorageFileDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "storage-file" },
              data: { $ref: "#/components/schemas/StorageFileData" },
            },
          },
        ],
      },
      StorageCollectionData: {
        type: "object",
        required: ["count", "page_size", "has_more", "usage", "items"],
        properties: {
          count: {
            type: "integer",
            minimum: 0,
            description: "Number of resources in this page, not a total count.",
          },
          page_size: {
            type: "integer",
            minimum: 1,
            description: "Effective maximum page size used for this response.",
          },
          has_more: {
            type: "boolean",
            description:
              "True when the response includes a next link with an encrypted continuation cursor.",
          },
          usage: { $ref: "#/components/schemas/StorageNamespaceUsage" },
          items: {
            type: "array",
            items: {
              oneOf: [
                { $ref: "#/components/schemas/StorageRecordDocument" },
                { $ref: "#/components/schemas/StorageFileDocument" },
              ],
            },
          },
        },
        additionalProperties: false,
      },
      StorageNamespaceUsage: {
        type: "object",
        required: [
          "item_count",
          "byte_count",
          "item_limit",
          "byte_limit",
          "writes_enabled",
        ],
        properties: {
          item_count: {
            type: "integer",
            minimum: 0,
            description:
              "Total JSON-record and file count in this local-user and OAuth-client namespace.",
          },
          byte_count: {
            type: "integer",
            minimum: 0,
            description:
              "Total stored JSON bytes and file bytes in this local-user and OAuth-client namespace.",
          },
          item_limit: {
            type: "integer",
            minimum: 1,
            description:
              "Configured finite item ceiling for this local-user and OAuth-client namespace.",
          },
          byte_limit: {
            type: "integer",
            minimum: 1,
            description:
              "Configured finite byte ceiling for this local-user and OAuth-client namespace.",
          },
          writes_enabled: {
            type: "boolean",
            description:
              "Whether storage.write operations are currently enabled for this deployment. Deletes are controlled separately.",
          },
        },
        additionalProperties: false,
      },
      StorageCollectionDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [
                  "storage-records-collection",
                  "storage-files-collection",
                ],
              },
              data: { $ref: "#/components/schemas/StorageCollectionData" },
            },
          },
        ],
      },
      StorageDeletionDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["storage-record-deletion", "storage-file-deletion"],
              },
              data: {
                type: "object",
                required: ["deleted", "key", "resource_type"],
                properties: {
                  deleted: { type: "boolean", const: true },
                  key: { type: "string" },
                  resource_type: { type: "string" },
                },
              },
            },
          },
        ],
      },
      UserInfo: {
        type: "object",
        required: ["sub"],
        properties: {
          sub: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          email_verified: { type: "boolean", const: false },
          name: { type: "string" },
        },
      },
      DeviceCodeEntryDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "device-code-entry" },
              data: {
                type: "object",
                required: ["user_code"],
                properties: { user_code: { type: "string" } },
              },
            },
          },
        ],
      },
      DeviceRequestDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "device-request" },
              data: {
                type: "object",
                required: [
                  "client_name",
                  "user_code",
                  "scopes",
                  "status",
                  "expires_at",
                ],
                properties: {
                  client_name: { type: "string" },
                  user_code: { type: "string" },
                  scopes: { type: "array", items: { type: "string" } },
                  status: { type: "string", const: "pending" },
                  expires_at: { type: "integer" },
                },
              },
            },
          },
        ],
      },
      DeviceDecisionDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "device-request-decision" },
              data: {
                type: "object",
                required: ["status"],
                properties: {
                  status: {
                    type: "string",
                    enum: ["approved", "denied", "used"],
                  },
                },
              },
            },
          },
        ],
      },
      AuthorizationConsentDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "authorization-consent" },
              data: {
                type: "object",
                required: [
                  "client_name",
                  "scopes",
                  "redirect_uri",
                  "status",
                  "expires_at",
                ],
                properties: {
                  client_name: { type: "string" },
                  scopes: { type: "array", items: { type: "string" } },
                  redirect_uri: { type: "string", format: "uri" },
                  status: { type: "string", const: "pending" },
                  expires_at: { type: "integer" },
                },
              },
            },
          },
        ],
      },
      OAuthClientCreateInput: {
        type: "object",
        required: ["csrf_token", "submission_token", "name", "type", "scopes"],
        properties: {
          csrf_token: { type: "string" },
          submission_token: {
            type: "string",
            minLength: 32,
            maxLength: 32,
            description:
              "One-time value from the current collection representation. Its hash is stored only to reject replay.",
          },
          name: { type: "string", minLength: 1, maxLength: 120 },
          type: {
            type: "string",
            enum: ["public", "confidential", "service"],
          },
          redirect_uris: {
            type: "string",
            description:
              "One exact redirect URI per line for interactive clients; omit for service clients.",
          },
          scopes: {
            type: "string",
            description: "Space-separated allowed AittaDB scopes.",
          },
          origins: {
            type: "string",
            description:
              "One exact allowed browser origin per line for interactive clients; omit for service clients.",
          },
        },
        additionalProperties: false,
      },
      OAuthClientOperationInput: {
        type: "object",
        required: ["csrf_token", "submission_token", "action", "client_id"],
        properties: {
          csrf_token: { type: "string" },
          submission_token: {
            type: "string",
            minLength: 32,
            maxLength: 32,
            description:
              "One-time value from the current collection representation. Its hash is stored only to reject replay.",
          },
          action: {
            type: "string",
            enum: ["enable", "disable", "rotate_secret", "revoke_grants"],
          },
          client_id: { type: "string", format: "uuid" },
        },
        additionalProperties: false,
      },
      OAuthClientCollectionDocument: {
        allOf: [
          { $ref: "#/components/schemas/HypermediaDocument" },
          {
            type: "object",
            properties: {
              type: { const: "oauth-client-collection" },
              data: {
                type: "object",
                required: ["clients"],
                properties: {
                  clients: {
                    type: "array",
                    items: {
                      type: "object",
                      required: [
                        "id",
                        "name",
                        "type",
                        "disabled",
                        "redirect_uris",
                        "scopes",
                        "origins",
                        "created_at",
                      ],
                      properties: {
                        id: { type: "string", format: "uuid" },
                        name: { type: "string" },
                        type: {
                          type: "string",
                          enum: ["public", "confidential", "service"],
                        },
                        disabled: { type: "boolean" },
                        redirect_uris: {
                          type: "array",
                          items: { type: "string", format: "uri" },
                        },
                        scopes: {
                          type: "array",
                          items: { type: "string" },
                        },
                        origins: {
                          type: "array",
                          items: { type: "string", format: "uri" },
                        },
                        created_at: { type: "integer" },
                      },
                    },
                  },
                  operation_result: {
                    type: "object",
                    readOnly: true,
                    required: ["operation", "client_id"],
                    properties: {
                      operation: {
                        type: "string",
                        enum: [
                          "create",
                          "enable",
                          "disable",
                          "rotate_secret",
                          "revoke_grants",
                        ],
                      },
                      client_id: { type: "string", format: "uuid" },
                    },
                    additionalProperties: false,
                  },
                  new_client_secret: {
                    type: "string",
                    readOnly: true,
                    description:
                      "Returned once immediately after creation or rotation.",
                  },
                  new_client_secret_client_id: {
                    type: "string",
                    format: "uuid",
                    readOnly: true,
                    description:
                      "Client whose newly generated secret accompanies this immediate response.",
                  },
                  secret_displayed_once: {
                    type: "boolean",
                    const: true,
                    readOnly: true,
                  },
                },
              },
            },
          },
        ],
      },
    },
  },
} as const;

export function oidcConfiguration(
  issuer: string,
  options: { oauthAppsEnabled?: boolean } = {},
) {
  const oauthAppsEnabled = options.oauthAppsEnabled ?? true;
  if (!oauthAppsEnabled) {
    return {
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ["ES256"],
    };
  }
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    introspection_endpoint: `${issuer}/oauth/introspect`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      "urn:ietf:params:oauth:grant-type:device_code",
      "refresh_token",
      "client_credentials",
    ],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["ES256"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ],
    scopes_supported: [
      "openid",
      "email",
      "profile",
      "offline_access",
      "storage.read",
      "storage.write",
      "storage.delete",
    ],
    code_challenge_methods_supported: ["S256"],
    claims_supported: [
      "iss",
      "sub",
      "aud",
      "exp",
      "iat",
      "nbf",
      "jti",
      "email",
      "name",
      "nonce",
    ],
  };
}
