# Sites Auth Broker

[GitHub repository](https://github.com/sendanor/sites-auth-broker)

Sites Auth Broker is an experimental independent authentication broker that converts ChatGPT Sites server-side identity into OAuth 2.0, OpenID Connect, and JWT sessions for web applications, APIs, native applications, and CLI tools.

It is not an official OpenAI project. It does not expose an official "Sign in with ChatGPT" OAuth service, and tokens issued by this project are not OpenAI or ChatGPT tokens. ChatGPT sign-in works only through a compatible Sites environment that supplies authenticated identity headers to server-side code.

The service creates its own local user record with an immutable UUID subject. The upstream email address is used only to locate or create that local user. Self-hosting outside Sites requires replacing the upstream Sites identity adapter.

Current releases are source-available under FSL-1.1-MIT. Each released version converts to the MIT License two years after publication.

## MVP Capabilities

- OAuth 2.0 Device Authorization Grant for CLIs.
- OAuth 2.0 Authorization Code with PKCE for browser and native clients.
- Minimal OpenID Connect issuer discovery, JWKS, ID tokens, UserInfo, introspection, and revocation.
- ES256 JWT signing through Web Crypto with a configured private JWK.
- Opaque hashed refresh tokens with rotation and reuse detection.
- D1-backed durable state with checked-in migrations.
- Per-user, per-client broker storage: JSON records in D1 and file bytes in R2.
- Minimal Sites-protected browser forms for device approval, consent, and admin client bootstrap.

## Local Setup

```sh
npm ci
cp .env.example .env
make generate-local-jwt-key
npm run validate
```

`make generate-local-jwt-key` writes the generated key to `.secrets/jwt-signing-key.json`, which is ignored by Git. Put generated key values into local environment variables or Sites secrets without committing real key material.

## Required Configuration

- `ISSUER_URL`: exact public issuer URL.
- `JWT_KEY_ID`: configured signing key ID.
- `JWT_PRIVATE_JWK`: ES256 P-256 private JWK JSON.
- `ADMIN_EMAILS`: comma-separated exact admin email allowlist.
- D1 binding named `DB`.
- R2 binding named `BUCKET` for `/storage/files/*`.

## API Endpoints

- `GET /health`
- `GET /.well-known/openid-configuration`
- `GET /.well-known/jwks.json`
- `GET /authorize`
- `POST /oauth/device_authorization`
- `POST /oauth/token`
- `POST /oauth/revoke`
- `POST /oauth/introspect`
- `GET /userinfo`
- `GET /storage/records`
- `PUT /storage/records/{key}`
- `GET /storage/records/{key}`
- `DELETE /storage/records/{key}`
- `GET /storage/files`
- `PUT /storage/files/{key}`
- `GET /storage/files/{key}`
- `DELETE /storage/files/{key}`
- `GET /openapi.json`
- `GET /docs`

Browser-facing routes and errors use content negotiation. Browsers that prefer `text/html` receive consistent authentication-service HTML views for metadata, health, device entry, consent, administration, and error/outcome pages. API clients that request JSON, or send generic CLI-style `Accept: */*`, receive JSON. JSON metadata and JSON errors are hypermedia-oriented and advertise `_links` and `actions` so clients can discover available operations instead of hard-coding every route. OAuth token success responses remain protocol-standard and do not add decorative browser content.

The browser UI uses a shared responsive auth-service shell with an identity-to-token visual treatment served from the same-origin `/auth-ui.css` stylesheet. It does not load external fonts, imagery, or third-party client scripts from application code.

## Broker Storage

Client applications may request `storage.read`, `storage.write`, and `storage.delete` local scopes. These scopes authorize storage only inside Sites Auth Broker. They do not grant access to ChatGPT, OpenAI, conversations, files, Projects, connectors, subscriptions, billing, or API quota.

Storage is isolated by the immutable local user UUID and OAuth client ID. JSON records are stored in D1 at `/storage/records/{key}`. File metadata is stored in D1 and file bytes are stored in R2 at `/storage/files/{key}`. Caller-provided keys are logical metadata; the broker generates physical R2 object keys.

## Sites Boundary

Sites owns `/signin-with-chatgpt` and `/signout-with-chatgpt`. This service reads only server-side `oai-authenticated-user-email`, optional `oai-authenticated-user-full-name`, and the full-name encoding header. It never forwards or exposes ChatGPT cookies, credentials, sessions, or tokens.
