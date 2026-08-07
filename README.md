# Sites Auth Broker

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
- Minimal Sites-protected browser forms for device approval, consent, and admin client bootstrap.

## Local Setup

```sh
npm ci
cp .env.example .env
npm run keys:generate
npm run validate
```

Put generated key values into local environment variables or Sites secrets. Do not commit real key material.

## Required Configuration

- `ISSUER_URL`: exact public issuer URL.
- `JWT_KEY_ID`: configured signing key ID.
- `JWT_PRIVATE_JWK`: ES256 P-256 private JWK JSON.
- `ADMIN_EMAILS`: comma-separated exact admin email allowlist.
- D1 binding named `DB`.

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
- `GET /openapi.json`
- `GET /docs`

## Sites Boundary

Sites owns `/signin-with-chatgpt` and `/signout-with-chatgpt`. This service reads only server-side `oai-authenticated-user-email`, optional `oai-authenticated-user-full-name`, and the full-name encoding header. It never forwards or exposes ChatGPT cookies, credentials, sessions, or tokens.
