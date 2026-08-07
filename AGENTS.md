# Sites Auth Broker Agent Instructions

## Project Purpose and Boundary

Sites Auth Broker is an independent authentication broker that converts ChatGPT Sites identity into standard OAuth 2.0, OpenID Connect, and JWT sessions for web applications, APIs, native applications, and CLI tools.

This project is independent and is not affiliated with, endorsed by, or an official product of OpenAI. Do not describe it as "OpenAI Auth", "ChatGPT OAuth", an official "Sign in with ChatGPT" OAuth service, or anything that implies tokens issued by this service are OpenAI or ChatGPT tokens.

The service uses only the identity signal supplied by the ChatGPT Sites runtime to a server-side request. It creates its own local user identity and issues tokens belonging exclusively to Sites Auth Broker. It does not expose ChatGPT credentials, access ChatGPT conversations, use ChatGPT files, read Projects or Library data, inspect connectors, check subscription state, consume API quota, or infer workspace roles or billing.

Current releases are source-available under FSL-1.1-MIT. Each released version converts to the MIT License two years after publication.

## Canonical Source

GitHub is the canonical source of truth for this repository. Work in the current Git repository. Do not create a second canonical source tree. Preserve existing files, package-manager choices, lockfiles, local user changes, and repository instructions.

Use feature branches for all implementation work. The initial MVP branch is `codex/initial-implementation`. Do not push directly to `main`, do not merge branches, and do not deploy, publish, create a production checkpoint, or change Sites access settings without explicit user approval.

## Sites Runtime Compatibility

The application must use the standard Sites-compatible Vinext and TypeScript shape with Cloudflare Worker-compatible ESM output. Deployed code must not assume Node-only APIs, filesystem writes, process memory durability, timers as durable jobs, or serverful runtime behavior.

Runtime requirements:

- D1 binding name: `DB`.
- R2 binding: absent or `null` unless an actual file-storage requirement appears.
- Web Crypto APIs for cryptography.
- Durable authoritative state in D1 only.
- No authoritative state in `localStorage`, `sessionStorage`, browser cookies, or process memory.
- Configuration from environment variables and Sites secrets.
- No secrets committed to Git.
- `.openai/hosting.json` may contain local logical binding names, but reusable public source must not publish a real production `project_id`.

## Upstream ChatGPT Sites Identity Boundary

Sites owns the ChatGPT sign-in and sign-out routes. Do not implement or override `/signin-with-chatgpt`, `/signout-with-chatgpt`, callback routes, or Sites dispatcher behavior.

The trusted upstream identity for this service consists only of these server-side request headers inside the trusted Sites runtime:

- `oai-authenticated-user-email`
- optional `oai-authenticated-user-full-name`
- `oai-authenticated-user-full-name-encoding`, when present

Decode the full name only when the encoding header is exactly `percent-encoded-utf-8`. Always fall back to the email address for display. Treat the display name as optional and never as an authorization attribute.

Use the email address only to locate or create a local user record. The local user record must have an immutable locally generated UUID, and that UUID is the downstream `sub`. Document and account for the risk that email addresses may change or be reassigned.

Never trust identity information sent from browser JavaScript. Never accept arbitrary `oai-authenticated-user-*` headers outside the trusted Sites runtime. Production code must not include a header-based development bypass. Local tests may use an explicit test-only identity adapter that cannot be enabled in a production build or production environment.

## Local Tokens Versus Upstream Identity

Downstream OAuth access tokens, refresh tokens, ID tokens, authorization codes, device codes, consents, and sessions are issued by Sites Auth Broker only. They are not OpenAI tokens, ChatGPT tokens, ChatGPT sessions, or proof of access to OpenAI services.

The supported local scopes for the MVP are:

- `openid`
- `email`
- `profile`
- `offline_access`

These scopes grant claims or refresh behavior from Sites Auth Broker. They do not grant access to ChatGPT or OpenAI data.

## Repository Structure

Maintain this structure unless `AGENTS.md` is updated in the same task that changes it:

- `.github/workflows/`: CI checks for formatting, linting, type checking, tests, OpenAPI validation, production build, and migration consistency.
- `.openai/hosting.json`: Sites local hosting metadata and logical D1 binding names only.
- `app/`: Vinext route handlers and minimal browser pages. HTTP handlers must delegate protocol and storage behavior to `src/`.
- `db/`: D1 schema definitions and checked-in SQL migrations.
- `docs/`: Markdown documentation, architecture notes, threat model, deployment guide, self-hosting notes, examples, and key rotation instructions.
- `openapi/`: canonical OpenAPI 3.1 source.
- `scripts/`: local administrative scripts such as signing-key generation and OpenAPI checks.
- `src/`: protocol-independent domain logic, repositories, crypto, configuration, HTTP helpers, identity adapters, and service interfaces.
- `tests/`: unit and integration tests, including complete token flows using a test-only identity adapter.

## System Units and Interfaces

Keep interfaces narrow and explicit:

- HTTP routes parse requests, apply HTTP security controls, and call services.
- OAuth services own device authorization, authorization code with PKCE, token exchange, revocation, introspection, scope validation, and consent decisions.
- OIDC services own discovery, JWKS, ID token claims, UserInfo, issuer metadata, nonce propagation, and JWT validation.
- Identity providers own upstream ChatGPT Sites header parsing and test-only identity injection.
- User repository owns email lookup, immutable local UUID creation, and user metadata.
- Client repository owns public and confidential clients, redirect URIs, origins, scopes, disablement, secret hashes, and secret rotation.
- Token repository owns hashed authorization codes, device codes, refresh token families, refresh token hashes, revocations, and expiration cleanup.
- Consent repository owns remembered consent grants keyed by local user, client, and exact scope set.
- Audit repository owns minimal redacted security events.
- Rate-limit repository owns bounded counters and enforcement state.
- Crypto module owns random value generation, hashing, constant-time comparison, PKCE verification, JWT signing, JWT validation, and JWKS publication.
- Configuration module owns environment parsing, defaults, secret presence checks, and production/test separation.

## TypeScript and Coding Conventions

Use strict TypeScript. Avoid `any`; prefer explicit unknown parsing, small interfaces, and type guards. Keep modules small and dependency-free unless a dependency clearly improves correctness. Prefer pure domain functions for protocol behavior and inject repositories or clocks where useful for tests.

Deployed code must be Worker-compatible. Do not use Node-only modules in code that can run in production route handlers. Node-only helpers are allowed in `scripts/` and tests when isolated from production bundles.

Use prepared SQL statements. Pass one SQL statement per `prepare()` call. Do not build SQL from untrusted strings. Store dates as integer Unix seconds or ISO text consistently per table and document the choice in schema comments.

## Cryptographic and Authentication Rules

Use Web Crypto for production cryptography:

- ES256 with P-256 for JWT signing.
- Load the private JWK from a hosted secret.
- Publish only the public JWK at JWKS.
- Include a configured key ID.
- Never generate a signing key during ordinary runtime startup.
- Include an immutable local UUID as `sub`.
- Include unique `jti`.
- Keep access tokens short-lived; default to 600 seconds.
- Use opaque high-entropy refresh tokens stored only as hashes.
- Rotate refresh tokens on every successful use.
- Detect refresh-token reuse and revoke the associated family.
- Validate JWT `iss`, `aud`, `exp`, `iat`, `nbf` when present, signature, algorithm, and key ID.
- Reject incorrect algorithms and unknown keys.
- Never set `email_verified: true` unless upstream Sites documentation explicitly supplies that assurance. Omit it or set it to `false`.

OAuth rules:

- Implement RFC 8628 Device Authorization Grant.
- Implement Authorization Code with PKCE using `S256`.
- Do not implement implicit grant or resource-owner password grant.
- Use high-entropy one-time authorization codes and device codes.
- Enforce exact registered redirect URI matching.
- Preserve OAuth `state` and OIDC `nonce`.
- Use an internal same-origin continuation route before redirecting to clients.
- Never pass an external URL directly as a Sites `return_to` value.
- Require explicit consent unless remembered consent exactly covers the client and requested scopes.
- Return standard OAuth error formats and content types.

## Database and Migration Rules

D1 is the durable state store. Schema and migrations must be checked in. Required entities include:

- local users
- OAuth clients
- redirect URIs
- allowed scopes
- authorization requests
- one-time authorization codes
- device grants
- refresh-token families
- refresh tokens
- remembered consents
- revoked access-token identifiers
- minimal audit events
- rate-limit counters when rate limiting is implemented in D1

Store hashes, not plaintext, for authorization codes, device codes, refresh tokens, confidential client secrets, and bearer-equivalent one-time credentials. Add expiration indexes for bounded cleanup. Cleanup must be safe during ordinary requests and must not require long background jobs.

Migration changes must include schema updates, checked-in SQL, automated migration tests, documentation updates, and validation evidence in the same task.

## OpenAPI Rules

Maintain one canonical OpenAPI 3.1 specification in `openapi/`. Serve it as JSON from `/openapi.json` and provide a minimal interactive viewer at `/docs`.

The OpenAPI spec must describe every REST endpoint, parameters, request bodies, responses, OAuth errors, schemas, authentication requirements, and examples. It must distinguish ChatGPT Sites browser authentication from tokens issued by Sites Auth Broker. Validate OpenAPI in CI and test that documented routes and implemented routes do not silently diverge.

## Configuration and Secrets

All configuration must be explicit. `.env.example` documents names and safe placeholders only. Never commit secret values, generated production keys, client secrets, refresh tokens, device codes, authorization codes, or real deployment identifiers.

Important configuration includes:

- `ISSUER_URL`
- `JWT_PRIVATE_JWK`
- `JWT_KEY_ID`
- `ADMIN_EMAILS`
- access-token lifetime
- refresh-token lifetime
- authorization-code lifetime
- device-code lifetime
- token polling interval
- allowed CORS origins where applicable
- production/test environment marker

Production startup must fail closed when required secrets are missing.

## Logging and PII Redaction

Do not log secrets, access tokens, refresh tokens, authorization codes, device codes, client secrets, CSRF tokens, cookies, or bearer-equivalent values. Redact credentials and PII from structured logs. Use generic authentication errors that do not leak account existence. Minimal audit events may record event type, local user UUID, client ID, request ID, coarse IP or user-agent metadata when needed, and timestamps.

OAuth, identity, and token responses must include `Cache-Control: no-store`.

## Security Controls

Every relevant implementation must include and test:

- exact redirect URI validation
- PKCE `S256`
- `state` preservation
- `nonce` preservation
- one-time authorization-code consumption
- one-time device-grant approval or denial
- device polling intervals and `slow_down`
- short expirations
- refresh-token rotation and reuse detection
- CSRF protection on browser forms
- same-origin validation for browser form submissions
- secure `HttpOnly` `SameSite=Lax` transaction cookies
- strict security headers
- no open redirects
- no token values in URLs
- no secrets in client-side bundles
- no user-controlled issuer or audience
- constant-time comparison where relevant
- least-privilege CORS
- no wildcard credentialed CORS
- exact configured origins for browser clients
- request-size limits
- rate limits for device authorization, token polling, client authentication, and admin operations
- credential redaction

## Minimal Web Interface

This project is a REST API and authentication service, not a marketing website. Do not add a marketing landing page, hero, feature sections, testimonials, pricing, decorative imagery, dashboard, general profile page, or documentation portal beyond the minimal OpenAPI viewer.

The root route must return concise machine-readable service metadata or redirect to minimal API docs. Normal HTML interfaces are limited to device-code entry or confirmation, consent approval or denial, concise OAuth errors, a minimal protected admin client-registration form when needed, and the minimal OpenAPI viewer.

Use plain semantic HTML, minimal CSS, visible focus, meaningful labels, clear validation errors, keyboard accessibility, screen-reader compatibility, and no unnecessary JavaScript.

## Documentation Rules

Create or maintain:

- `README.md`
- `AGENTS.md`
- `PLAN.md`
- `LICENSE.md`
- `SECURITY.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `.env.example`
- architecture documentation
- threat model
- deployment guide
- self-hosting limitations
- OpenAPI specification
- database schema and migrations
- CLI integration example
- browser/native PKCE example
- curl examples
- key generation and rotation instructions
- downstream JWT verification example
- instructions for creating a fresh Sites project from a fork
- explanation of Sites-specific functionality

Documentation must say this project is experimental, independent, and source-available under FSL-1.1-MIT, with each release converting to MIT after two years.

## Required Commands

Keep these commands current as package scripts evolve:

- Install dependencies: `npm ci`
- Format check: `npm run format:check`
- Format write: `npm run format`
- Lint: `npm run lint`
- Type check: `npm run typecheck`
- Unit tests: `npm run test:unit`
- Integration tests: `npm run test:integration`
- Full test suite: `npm test`
- OpenAPI validation: `npm run openapi:check`
- Migration consistency: `npm run db:check`
- Production build: `npm run build`
- Complete local validation: `npm run validate`
- Generate local ES256 key pair without printing the secret: `make generate-local-jwt-key`
- Generate local ES256 key pair to stdout for ephemeral automation only: `npm run keys:generate`

## PLAN.md Workflow

Before source implementation, create `PLAN.md` with a flat list of unchecked tasks. Each task must have a stable identifier such as `TASK-001`. Do not use nested tasks, subtasks, phases, epics, or separate documentation/test tasks.

Process tasks in order unless a dependency discovered during implementation requires a documented reorder. Change a checkbox to `[x]` only after the task's full definition of done passes. If implementation reveals missing work, add a new unchecked flat-list item at the correct dependency position before performing that work. Keep completed task descriptions intact so the file remains an auditable implementation history.

## Definition of Done

Every implementation task must complete all of these in the same task:

1. The unit's public interface or contract.
2. Implementation.
3. Automated tests.
4. User/developer documentation.
5. Successful formatting, linting, type checking, relevant tests, and build validation.
6. Necessary `AGENTS.md`, OpenAPI, schema, migration, or architecture updates.

Agents must not split documentation, tests, and implementation for one unit into separate tasks.

## Git, Commit, PR, and Review Workflow

Use focused commits that correspond to completed `PLAN.md` tasks where practical. Never mark partially complete tasks as complete. Before commit, run the required validation commands relevant to the changed surface; before final handoff, run `npm run validate`.

If authenticated GitHub write access is available after validation, push the feature branch and open a draft pull request. If not, leave the verified commit locally and report that write access is unavailable.

Production deployment, Sites version saving, publishing, access changes, and production checkpoint creation require explicit user approval.

## Updating AGENTS.md

Update this file in the same task whenever architecture, commands, constraints, operational knowledge, security rules, repository structure, deployment procedure, or maintainer workflow changes. If a task changes how future humans or AI agents should work, its definition of done includes an `AGENTS.md` update.
