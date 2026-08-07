const storageKeyParameter = {
  name: "key",
  in: "path",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 240 },
  description: "Application-defined logical object key.",
} as const;

const representationFormatParameter = {
  name: "format",
  in: "query",
  required: false,
  schema: { type: "string", enum: ["json"] },
  description:
    "Force canonical JSON when a browser Accept header would otherwise select HTML.",
} as const;

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "AittaDB",
    version: "0.1.0",
    license: { name: "FSL-1.1-MIT" },
    description:
      "AittaDB is an independent hosted application backend based on ChatGPT sign-in inside ChatGPT Sites. It creates a separate local user, issues its own OAuth 2.0, OpenID Connect, and JWT sessions, and provides client-isolated D1/R2 storage. Its tokens and stored data are not OpenAI or ChatGPT tokens or data.",
  },
  paths: {
    "/": {
      get: {
        summary: "Service metadata or browser overview",
        description:
          "Returns hypermedia service metadata to API clients and a concise browser overview when the request prefers HTML.",
        responses: {
          "200": {
            description: "AittaDB service metadata",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ServiceMetadata" },
              },
              "text/html": { schema: { type: "string" } },
            },
          },
        },
      },
    },
    "/health": {
      get: {
        summary: "Service health",
        responses: { "200": { description: "Healthy" } },
      },
    },
    "/session": {
      get: {
        summary: "Current AittaDB local session",
        description:
          "Uses the server-side ChatGPT sign-in signal supplied inside the trusted Sites runtime to locate or create an immutable local AittaDB user. Browsers without that upstream session are sent through the Sites-owned sign-in route. This does not return or forward ChatGPT credentials.",
        responses: {
          "200": {
            description: "Current local AittaDB identity",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LocalSession" },
              },
              "text/html": { schema: { type: "string" } },
            },
          },
          "302": { description: "Continue to Sites-owned ChatGPT sign-in" },
          "401": { description: "No upstream browser session for JSON client" },
        },
      },
    },
    "/.well-known/openid-configuration": {
      get: {
        summary: "OpenID Provider metadata",
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
        parameters: [
          {
            name: "response_type",
            in: "query",
            schema: { const: "code" },
            required: true,
          },
          {
            name: "client_id",
            in: "query",
            schema: { type: "string" },
            required: true,
          },
          {
            name: "redirect_uri",
            in: "query",
            schema: { type: "string", format: "uri" },
            required: true,
          },
          { name: "scope", in: "query", schema: { type: "string" } },
          { name: "state", in: "query", schema: { type: "string" } },
          { name: "nonce", in: "query", schema: { type: "string" } },
          {
            name: "code_challenge",
            in: "query",
            schema: { type: "string" },
            required: true,
          },
          {
            name: "code_challenge_method",
            in: "query",
            schema: { const: "S256" },
            required: true,
          },
        ],
        responses: {
          "200": {
            description:
              "Browser request form when no client request parameters are supplied",
            content: { "text/html": { schema: { type: "string" } } },
          },
          "302": {
            description:
              "Continues to same-origin consent or redirects an OAuth error",
          },
        },
      },
    },
    "/oauth/device_authorization": {
      get: {
        summary: "Browser form for Device Authorization Grant initiation",
        description:
          "Returns an HTML form that posts to the production device authorization operation. API clients should use POST directly.",
        responses: {
          "200": {
            description: "Same-origin HTML form with CSRF protection",
            content: { "text/html": { schema: { type: "string" } } },
          },
          "405": { description: "JSON clients must use POST" },
        },
      },
      post: {
        summary: "OAuth 2.0 Device Authorization Grant endpoint",
        requestBody: {
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
        },
      },
    },
    "/oauth/token": {
      get: {
        summary: "Browser form for token exchange",
        description:
          "Returns an HTML form that posts to the production token operation. API clients should use POST directly.",
        responses: {
          "200": {
            description: "Same-origin HTML form with CSRF protection",
            content: { "text/html": { schema: { type: "string" } } },
          },
          "405": { description: "JSON clients must use POST" },
        },
      },
      post: {
        summary:
          "OAuth 2.0 token endpoint for device, authorization_code, and refresh_token grants",
        requestBody: {
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
                    ],
                  },
                  client_id: { type: "string" },
                  client_secret: { type: "string" },
                  device_code: { type: "string" },
                  code: { type: "string" },
                  redirect_uri: { type: "string", format: "uri" },
                  code_verifier: { type: "string" },
                  refresh_token: { type: "string" },
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
        },
      },
    },
    "/oauth/revoke": {
      get: {
        summary: "Browser form for token revocation",
        responses: {
          "200": {
            description: "Same-origin HTML form with CSRF protection",
            content: { "text/html": { schema: { type: "string" } } },
          },
          "405": { description: "JSON clients must use POST" },
        },
      },
      post: {
        summary: "Token revocation",
        requestBody: {
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
        },
      },
    },
    "/oauth/introspect": {
      get: {
        summary: "Browser form for token introspection",
        responses: {
          "200": {
            description: "Same-origin HTML form with CSRF protection",
            content: { "text/html": { schema: { type: "string" } } },
          },
          "405": { description: "JSON clients must use POST" },
        },
      },
      post: {
        summary: "Token introspection for confidential clients",
        security: [{ clientSecretBasic: [] }],
        requestBody: {
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
          "401": { description: "Confidential client authentication failed" },
        },
      },
    },
    "/userinfo": {
      get: {
        summary: "OpenID Connect UserInfo",
        security: [{ bearer: [] }],
        responses: {
          "200": { description: "Local user claims" },
          "401": { description: "Invalid bearer token" },
        },
      },
      post: {
        summary: "Browser-only UserInfo form submission",
        description:
          "Accepts a bearer token in a CSRF-protected same-origin form body, then invokes the same UserInfo validation as GET. Non-browser clients should use GET with Authorization: Bearer.",
        requestBody: {
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["ui", "csrf_token", "access_token"],
                properties: {
                  ui: { type: "string", const: "1" },
                  csrf_token: { type: "string" },
                  access_token: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Readable UserInfo claims",
            content: { "text/html": { schema: { type: "string" } } },
          },
          "401": { description: "Invalid AittaDB access token" },
          "403": { description: "CSRF or same-origin rejection" },
          "405": { description: "Browser representation marker missing" },
        },
      },
    },
    "/storage/records": {
      get: {
        summary:
          "List JSON records for the access token's local user and OAuth client",
        description:
          "Requires an AittaDB access token with storage.read. Records are AittaDB application storage; they do not expose ChatGPT or OpenAI data.",
        security: [{ bearer: [] }],
        responses: {
          "200": {
            description:
              "Record collection for bearer clients or a protected browser operation form when no Authorization header is present",
            content: {
              "application/json": { schema: { type: "object" } },
              "text/html": { schema: { type: "string" } },
            },
          },
          "401": { description: "Invalid bearer token" },
          "403": { description: "Missing storage.read scope" },
        },
      },
      post: {
        summary: "Browser-only JSON record operation",
        description:
          "CSRF-protected same-origin adapter for list, read, write, and delete. It places the submitted token in a synthetic Authorization header and invokes the same production storage operation as a REST client.",
        requestBody: {
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["ui", "csrf_token", "operation", "access_token"],
                properties: {
                  ui: { type: "string", const: "1" },
                  csrf_token: { type: "string" },
                  operation: {
                    type: "string",
                    enum: ["list", "read", "write", "delete"],
                  },
                  access_token: { type: "string" },
                  key: { type: "string", minLength: 1, maxLength: 240 },
                  value: {
                    type: "string",
                    description: "JSON text for the write operation.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Readable result from the production storage route",
            content: { "text/html": { schema: { type: "string" } } },
          },
          "403": { description: "Scope, CSRF, or same-origin rejection" },
          "405": { description: "Browser representation marker missing" },
          "413": { description: "Form or JSON record exceeds the limit" },
        },
      },
    },
    "/storage/records/{key}": {
      get: {
        summary: "Read one JSON record",
        security: [{ bearer: [] }],
        parameters: [storageKeyParameter],
        responses: {
          "200": {
            description:
              "Storage record or a browser operation form when no Authorization header is present",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StorageRecord" },
              },
              "text/html": { schema: { type: "string" } },
            },
          },
          "404": { description: "Record not found" },
        },
      },
      put: {
        summary: "Create or replace one JSON record",
        description:
          "Requires storage.write. The request body must be JSON and is stored in D1 under the local user UUID and client ID.",
        security: [{ bearer: [] }],
        parameters: [storageKeyParameter],
        requestBody: {
          required: true,
          content: { "application/json": { schema: true } },
        },
        responses: {
          "200": { description: "Stored record" },
          "413": { description: "Record exceeds the AittaDB limit" },
        },
      },
      delete: {
        summary: "Delete one JSON record",
        security: [{ bearer: [] }],
        parameters: [storageKeyParameter],
        responses: { "200": { description: "Deleted" } },
      },
    },
    "/storage/files": {
      get: {
        summary:
          "List file metadata for the access token's local user and OAuth client",
        description:
          "Requires storage.read. File bytes are stored in R2 and searchable metadata is stored in D1.",
        security: [{ bearer: [] }],
        responses: {
          "200": {
            description:
              "File metadata collection for bearer clients or a protected browser operation form when no Authorization header is present",
            content: {
              "application/json": { schema: { type: "object" } },
              "text/html": { schema: { type: "string" } },
            },
          },
          "401": { description: "Invalid bearer token" },
          "403": { description: "Missing storage.read scope" },
        },
      },
      post: {
        summary: "Browser-only file storage operation",
        description:
          "Bounded CSRF-protected same-origin multipart adapter for list, download, upload, and delete. It invokes the same D1 metadata and R2 byte operations as REST clients.",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["ui", "csrf_token", "operation", "access_token"],
                properties: {
                  ui: { type: "string", const: "1" },
                  csrf_token: { type: "string" },
                  operation: {
                    type: "string",
                    enum: ["list", "download", "upload", "delete"],
                  },
                  access_token: { type: "string" },
                  key: { type: "string", minLength: 1, maxLength: 240 },
                  file: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Readable operation result or original file bytes as an attachment for download",
          },
          "403": { description: "Scope, CSRF, or same-origin rejection" },
          "405": { description: "Browser representation marker missing" },
          "413": { description: "Multipart form or file exceeds the limit" },
        },
      },
    },
    "/storage/files/{key}": {
      get: {
        summary: "Read one file from R2",
        security: [{ bearer: [] }],
        parameters: [storageKeyParameter],
        responses: {
          "200": {
            description:
              "File bytes for bearer clients or a browser operation form when no Authorization header is present",
            headers: {
              "x-aittadb-storage-key": {
                description: "Percent-encoded logical application key.",
                schema: { type: "string" },
              },
            },
          },
          "404": { description: "File not found" },
        },
      },
      put: {
        summary: "Create or replace one file in R2",
        description:
          "Requires storage.write. The caller's key is metadata only; AittaDB generates the physical R2 object key.",
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
          "200": { description: "Stored file metadata" },
          "413": { description: "File exceeds the AittaDB limit" },
          "503": { description: "R2 bucket is unavailable" },
        },
      },
      delete: {
        summary: "Delete one file from R2 and D1 metadata",
        security: [{ bearer: [] }],
        parameters: [storageKeyParameter],
        responses: { "200": { description: "Deleted" } },
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
        responses: { "200": { description: "Interactive HTML API viewer" } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      clientSecretBasic: { type: "http", scheme: "basic" },
    },
    schemas: {
      ServiceMetadata: {
        type: "object",
        required: [
          "service",
          "issuer",
          "officialOpenAIProduct",
          "upstreamSignIn",
          "sessionIssuer",
          "_links",
          "actions",
        ],
        properties: {
          service: { type: "string", const: "AittaDB" },
          issuer: { type: "string", format: "uri" },
          docs: { type: "string", format: "uri" },
          openapi: { type: "string", format: "uri" },
          officialOpenAIProduct: { type: "boolean", const: false },
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
              identitySignal: {
                type: "string",
                description:
                  "Server-side email and optional display name supplied after ChatGPT sign-in.",
              },
              stableSubjectSupplied: { type: "boolean", const: false },
              credentialsForwarded: { type: "boolean", const: false },
            },
          },
          sessionIssuer: {
            type: "string",
            const: "AittaDB",
            description:
              "Service that issues the downstream OAuth, OIDC, and JWT session credentials.",
          },
          _links: { $ref: "#/components/schemas/HypermediaLinks" },
          actions: { type: "object", additionalProperties: true },
        },
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
        ],
        properties: {
          device_code: { type: "string" },
          user_code: { type: "string" },
          verification_uri: { type: "string", format: "uri" },
          verification_uri_complete: { type: "string", format: "uri" },
          expires_in: { type: "integer" },
          interval: { type: "integer" },
          _links: { $ref: "#/components/schemas/HypermediaLinks" },
          actions: { type: "object", additionalProperties: true },
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
        },
      },
      OAuthError: {
        type: "object",
        required: ["error", "_links"],
        properties: {
          error: { type: "string" },
          error_description: { type: "string" },
          _links: { $ref: "#/components/schemas/HypermediaLinks" },
          actions: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      LocalSession: {
        type: "object",
        required: [
          "authenticated",
          "user",
          "upstreamSignIn",
          "sessionIssuer",
          "credentialsForwarded",
          "_links",
          "actions",
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
          _links: { $ref: "#/components/schemas/HypermediaLinks" },
          actions: { type: "object", additionalProperties: true },
        },
      },
      HypermediaLinks: {
        type: "object",
        additionalProperties: {
          type: "object",
          required: ["href"],
          properties: {
            href: { type: "string" },
            type: { type: "string" },
          },
        },
      },
      StorageRecord: {
        type: "object",
        required: ["key", "value", "created_at", "updated_at", "_links"],
        properties: {
          key: { type: "string" },
          value: true,
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
          _links: { $ref: "#/components/schemas/HypermediaLinks" },
          actions: { type: "object", additionalProperties: true },
        },
      },
      StorageFile: {
        type: "object",
        required: [
          "key",
          "content_type",
          "size",
          "sha256",
          "created_at",
          "updated_at",
          "_links",
        ],
        properties: {
          key: { type: "string" },
          content_type: { type: "string" },
          size: { type: "integer" },
          sha256: { type: "string" },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
          _links: { $ref: "#/components/schemas/HypermediaLinks" },
          actions: { type: "object", additionalProperties: true },
        },
      },
    },
  },
} as const;

export function oidcConfiguration(issuer: string) {
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
