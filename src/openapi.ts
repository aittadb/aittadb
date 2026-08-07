const storageKeyParameter = {
  name: "key",
  in: "path",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 240 },
  description: "Application-defined logical object key.",
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
    "/.well-known/openid-configuration": {
      get: {
        summary: "OpenID Provider metadata",
        responses: { "200": { description: "OIDC metadata" } },
      },
    },
    "/.well-known/jwks.json": {
      get: {
        summary: "JSON Web Key Set",
        responses: { "200": { description: "Public ES256 signing keys" } },
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
          "302": {
            description:
              "Continues to same-origin consent or redirects an OAuth error",
          },
        },
      },
    },
    "/oauth/device_authorization": {
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
                  scope: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Device code response" },
          "400": { description: "OAuth error" },
        },
      },
    },
    "/oauth/token": {
      post: {
        summary:
          "OAuth 2.0 token endpoint for device, authorization_code, and refresh_token grants",
        responses: {
          "200": { description: "Token response" },
          "400": { description: "OAuth error" },
        },
      },
    },
    "/oauth/revoke": {
      post: {
        summary: "Token revocation",
        responses: { "200": { description: "Revoked" } },
      },
    },
    "/oauth/introspect": {
      post: {
        summary: "Token introspection for confidential clients",
        responses: { "200": { description: "Introspection result" } },
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
    },
    "/storage/records": {
      get: {
        summary:
          "List JSON records for the access token's local user and OAuth client",
        description:
          "Requires an AittaDB access token with storage.read. Records are AittaDB application storage; they do not expose ChatGPT or OpenAI data.",
        security: [{ bearer: [] }],
        responses: {
          "200": { description: "Record collection" },
          "401": { description: "Invalid bearer token" },
          "403": { description: "Missing storage.read scope" },
        },
      },
    },
    "/storage/records/{key}": {
      get: {
        summary: "Read one JSON record",
        security: [{ bearer: [] }],
        parameters: [storageKeyParameter],
        responses: {
          "200": { description: "Storage record" },
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
          "200": { description: "File metadata collection" },
          "401": { description: "Invalid bearer token" },
          "403": { description: "Missing storage.read scope" },
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
            description: "File bytes",
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
        responses: { "200": { description: "OpenAPI spec" } },
      },
    },
    "/docs": {
      get: {
        summary: "Minimal OpenAPI viewer",
        responses: { "200": { description: "HTML viewer" } },
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
          "tokenAuthority",
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
          tokenAuthority: {
            type: "string",
            const: "AittaDB",
          },
          _links: { $ref: "#/components/schemas/HypermediaLinks" },
          actions: { type: "object", additionalProperties: true },
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
