# AittaDB

<img src="public/aittadb-mark.svg" width="96" height="96" alt="AittaDB logo">

[GitHub repository](https://github.com/aittadb/aittadb)

**An application backend that runs entirely on ChatGPT Sites.**

AittaDB provides authentication, persistent data, object storage, and a path toward persistent events through a single self-contained ChatGPT Sites deployment. It is designed for applications that need backend capabilities without requiring separate application servers, database servers, object-storage services, or authentication infrastructure.

> **Experimental:** AittaDB is under active development. Its interfaces and operational requirements may change before a stable release.

It is not an official OpenAI project. It does not expose an official "Sign in with ChatGPT" OAuth service, and tokens issued by this project are not OpenAI or ChatGPT tokens. ChatGPT sign-in works only through a compatible Sites environment that supplies authenticated identity headers to server-side code.

The service creates its own user record with an immutable UUID subject. The upstream email address is used only to locate or create that AittaDB user. Self-hosting outside Sites requires replacing the upstream Sites identity adapter.

Current releases are source-available under FSL-1.1-MIT. Each released version converts to the MIT License two years after publication.

## Built for ChatGPT Sites

AittaDB is designed to run and be hosted on [ChatGPT Sites](https://learn.chatgpt.com/docs/sites). It uses capabilities provided by the Sites platform:

- Managed application hosting and runtime.
- ChatGPT sign-in supplied inside the Sites trust boundary.
- D1 storage for persistent structured data.
- R2 object storage for files and other binary data.
- Hosted environment configuration and secrets.

Because these capabilities are provided by ChatGPT Sites, a core AittaDB deployment does not need infrastructure outside Sites. Once deployed, AittaDB can act as a shared backend for other websites, ChatGPT Sites, services, native applications, command-line tools, and AI agents through its HTTP APIs.

## What AittaDB Provides

- ChatGPT-based upstream user identity mapped to an independent AittaDB user.
- OAuth 2.0 and OpenID Connect sessions for third-party applications.
- Persistent structured application data.
- Object and file storage.
- HTTP APIs for applications, services, and AI agents.
- Persistent events and long-polling delivery as a planned capability, not part of the current MVP.

The goal is to let developers build persistent, authenticated applications without first deploying and maintaining a conventional backend stack.

## Why AittaDB?

In Finnish, an _aitta_ is a traditional detached storehouse on a farmstead. It was built to keep grain, food, tools, and other valuable supplies safe and available.

AittaDB follows the same idea for software: a dependable place for an application's identity, data, files, and events.

## MVP Capabilities

- OAuth 2.0 Device Authorization Grant for CLIs.
- OAuth 2.0 Authorization Code with PKCE for browser and native clients.
- Minimal OpenID Connect issuer discovery, JWKS, ID tokens, UserInfo, introspection, and revocation.
- ES256 JWT signing through Web Crypto with a configured private JWK.
- Opaque hashed refresh tokens with rotation and reuse detection.
- D1-backed durable state with checked-in migrations.
- Per-user, per-client application storage: JSON records in D1 and file bytes in R2.
- Minimal ChatGPT-sign-in-protected browser forms inside ChatGPT Sites for device approval, consent, and admin client bootstrap.

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
- `GET /session`
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

The public service root does not require authentication because issuer discovery and OAuth initiation must work before sign-in. Its browser operation map links to the real production routes, not a separate demo. `/session` starts Sites-owned ChatGPT sign-in when needed and then shows the immutable local AittaDB subject created for the signed-in user; sign-in alone does not grant a client any storage scope.

Browser-facing routes and errors use content negotiation. Browsers that prefer `text/html` receive consistent authentication-service HTML views, while API clients that request JSON, or send generic CLI-style `Accept: */*`, receive canonical machine responses. Browser forms invoke the same identity, OAuth/OIDC, D1, and R2 services as API clients and do not use mock users, fake tokens, or browser-only storage. JSON metadata and JSON errors are hypermedia-oriented and advertise `_links` and `actions` so clients can discover available operations instead of hard-coding every route. OAuth token success responses remain protocol-standard for API clients.

The browser UI uses a shared responsive AittaDB shell with page-aware trust-boundary copy, the same-origin `aittadb-boundary.jpg` artwork, the supplied `aittadb-mark.svg` storehouse mark, and an AittaDB-specific `og.png` social card. Inter is self-hosted from `/fonts/inter-latin-wght-normal.woff2`, with `system-ui`, `Segoe UI`, and `sans-serif` fallbacks. Styles come from `/auth-ui.css`; the UI loads no third-party runtime fonts, images, tracking code, or client scripts.

## Application Storage

Client applications may request `storage.read`, `storage.write`, and `storage.delete` AittaDB scopes. These scopes authorize storage only inside AittaDB. They do not grant access to ChatGPT, OpenAI, conversations, files, Projects, connectors, subscriptions, billing, or API quota.

Storage is isolated by the immutable AittaDB user UUID and OAuth client ID. JSON records are stored in D1 at `/storage/records/{key}`. File metadata is stored in D1 and file bytes are stored in R2 at `/storage/files/{key}`. Caller-provided keys are logical metadata; AittaDB generates physical R2 object keys.

## ChatGPT Sites Sign-In Boundary

ChatGPT sign-in is supplied inside ChatGPT Sites through Sites-owned `/signin-with-chatgpt` and `/signout-with-chatgpt` routes. This service reads only server-side `oai-authenticated-user-email`, optional `oai-authenticated-user-full-name`, and the full-name encoding header. It never forwards or exposes ChatGPT cookies, credentials, sessions, or tokens.

## Contributing

AittaDB is under active development. You can contribute by:

- Deploying and testing AittaDB on ChatGPT Sites.
- Reporting bugs and compatibility issues.
- Proposing applications and real-world use cases.
- Building client libraries and integrations.
- Improving documentation.
- Reviewing security and privacy.
- Submitting focused pull requests.
- Supporting the project as an early startup investor.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the instructions in each AittaDB repository before contributing.

## Early Investors

AittaDB is currently in its pre-startup stage. In addition to technical contributions, I am open to conversations with people interested in supporting the project as early startup investors.

This is currently a friends-and-family-style phase, although I am very open to making new friends who believe in the idea.

This is an invitation to start a conversation rather than an announcement of a formal funding round. If you are interested, contact me through [my GitHub profile](https://github.com/thejhh).

## Resources

- Explore the [AittaDB repositories](https://github.com/aittadb).
- Read each repository's documentation.
- Use [GitHub Issues](https://github.com/aittadb/aittadb/issues) for bug reports and feature proposals.
- Read the [ChatGPT Sites documentation](https://learn.chatgpt.com/docs/sites).
- Visit the founder's GitHub profile: [@thejhh](https://github.com/thejhh).

## Fun Fact

The name combines _aitta_ with _DB_: a traditional farm storehouse reimagined as hosted application infrastructure.
