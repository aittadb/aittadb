export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Sites Auth Broker",
    version: "0.1.0",
    license: { name: "FSL-1.1-MIT" },
    description:
      "Independent OAuth 2.0, OpenID Connect, and JWT sessions from ChatGPT Sites identity. Tokens are issued by Sites Auth Broker, not by OpenAI or ChatGPT.",
  },
  paths: {
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
      OAuthError: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string" },
          error_description: { type: "string" },
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
    scopes_supported: ["openid", "email", "profile", "offline_access"],
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
