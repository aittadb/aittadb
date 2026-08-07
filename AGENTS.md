# AittaDB Agent Instructions

## Project Purpose and Boundary

AittaDB is an independent hosted application backend based on ChatGPT sign-in inside ChatGPT Sites. It maps the server-side identity signal to a separate AittaDB user, issues standard OAuth 2.0, OpenID Connect, and JWT sessions, and provides per-user, per-client JSON record and object storage for web applications, APIs, native applications, and CLI tools.

This project is independent and is not affiliated with, endorsed by, or an official product of OpenAI. Do not describe it as "OpenAI Auth", "ChatGPT OAuth", an official "Sign in with ChatGPT" OAuth service, or anything that implies tokens issued by this service are OpenAI or ChatGPT tokens.

The service uses only the identity signal supplied by the ChatGPT Sites runtime to a server-side request. It creates its own local user identity and issues tokens belonging exclusively to AittaDB. It does not expose ChatGPT credentials, access ChatGPT conversations, use ChatGPT files, read Projects or Library data, inspect connectors, check subscription state, consume API quota, or infer workspace roles or billing.

Current releases are source-available under FSL-1.1-MIT. Each released version converts to the MIT License two years after publication.

## Canonical Source

GitHub at `https://github.com/aittadb/aittadb` is the canonical source of truth for this repository. Work in the current Git repository. Do not create a second canonical source tree. Preserve existing files, package-manager choices, lockfiles, local user changes, and repository instructions.

The canonical public service origin is `https://aittadb.com`. Hosted issuer metadata, absolute hypermedia links, Open Graph metadata, OAuth verification URIs, and OIDC discovery must use that origin through the configured `ISSUER_URL`. The legacy `chatgpt.site` hostname may continue to route at the platform level, but it is not the canonical issuer or public URL.

Use feature branches for all implementation work. The initial MVP branch is `codex/initial-implementation`. Do not push directly to `main`, do not merge branches, and do not deploy, publish, create a production checkpoint, or change Sites access settings without explicit user approval.

## Sites Runtime Compatibility

The application must use the standard Sites-compatible Vinext and TypeScript shape with Cloudflare Worker-compatible ESM output. Deployed code must not assume Node-only APIs, filesystem writes, process memory durability, timers as durable jobs, or serverful runtime behavior.

Runtime requirements:

- D1 binding name: `DB`.
- R2 binding name: `BUCKET` for AittaDB object storage.
- Web Crypto APIs for cryptography.
- Durable authoritative state in D1 only.
- No authoritative state in `localStorage`, `sessionStorage`, browser cookies, or process memory.
- Process memory may hold only non-authoritative performance hints, such as the next bounded cleanup time. Correctness must not depend on their survival or uniqueness.
- Public metadata, health, discovery, JWKS, OpenAPI, docs, and stylesheet routes must not initialize D1 work. Static assets must pass directly to Vinext. Durable-route cleanup must be bounded and scheduled with `waitUntil`, never awaited on every response.
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

Downstream OAuth access tokens, refresh tokens, ID tokens, authorization codes, device codes, consents, and sessions are issued by AittaDB only. They are not OpenAI tokens, ChatGPT tokens, ChatGPT sessions, or proof of access to OpenAI services.

The supported local scopes for the MVP are:

- `openid`
- `email`
- `profile`
- `offline_access`
- `storage.read`
- `storage.write`
- `storage.delete`

These scopes grant claims, refresh behavior, or AittaDB application-storage operations. They do not grant access to ChatGPT or OpenAI data.

## Product Terminology

On first reference in user-facing UI, JSON metadata, and documentation, call the upstream browser authentication "ChatGPT sign-in inside ChatGPT Sites." A shorter later reference may use "ChatGPT sign-in." Do not use the standalone phrase "Sites identity" in user-facing content because it does not explain the identity source.

"ChatGPT sign-in" names only the upstream browser authentication supplied by the Sites runtime. In the same context, distinguish the immutable local UUID and tokens issued independently by AittaDB. Never imply a general OpenAI or ChatGPT OAuth service, credential issuance, endorsement, or access to ChatGPT data. Internal implementation names may use "Sites identity adapter" or "Sites identity provider" when discussing the runtime interface precisely.

Use "Session issuer" in user-facing metadata for the service that issues downstream OAuth, OIDC, and JWT credentials. Do not use "Token authority" in browser copy or JSON metadata because it can be confused with AI-model token accounting.

## Repository Structure

Maintain this structure unless `AGENTS.md` is updated in the same task that changes it:

- `.github/workflows/`: CI checks for formatting, linting, type checking, tests, OpenAPI validation, production build, and migration consistency.
- `.openai/hosting.example.json`: safe reusable Sites hosting template with logical D1 and R2 binding names.
- `.openai/hosting.json`: ignored checkout-local Sites project metadata; it may hold the active `project_id` and must never be committed.
- `app/`: Vinext route handlers and minimal browser pages. HTTP handlers must delegate protocol and storage behavior to `src/`.
- `build/`: Node-only build integration for Vinext/Sites, including typed hosting metadata loading and deterministic packaging of reviewed SQL into Sites migration artifacts. It must not contain deployed domain behavior.
- `db/`: D1 required-table manifest and canonical checked-in SQL migration history.
- `docs/`: Markdown documentation, architecture notes, threat model, deployment guide, self-hosting notes, examples, and key rotation instructions.
- `docs/performance.md`: request-path invariants, baseline evidence, and live measurement requirements.
- `openapi/`: canonical OpenAPI 3.1 source.
- `public/`: same-origin static assets. `aittadb-mark.svg` is the canonical brand mark, `aittadb-boundary.jpg` is shared decorative boundary artwork, `og.png` is the 1200x630 social preview, and `fonts/` contains the self-hosted Inter variable font and its license.
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
- Storage repository owns AittaDB JSON records, file metadata, and per-user/per-client object ownership. File bytes live in R2 behind generated object keys.
- Storage browser adapter owns only same-origin HTML form parsing and representation. It must translate a protected form into a synthetic request to the production `storageEndpoint`; it must not duplicate authorization, scope checks, key validation, D1/R2 persistence, or storage state.
- Browser-session adapter maps the trusted current Sites identity to the local UUID and a minimal short-lived internal AittaDB access token. It must never return, persist, log, or render that token.
- Reserved system-client policy owns the fixed browser-session client identity. The client is migration-seeded, hidden from client administration, immutable through repository mutation methods, and rejected by all external OAuth grant paths.
- Crypto module owns random value generation, hashing, constant-time comparison, PKCE verification, JWT signing, JWT validation, and JWKS publication.
- Configuration module owns environment parsing, defaults, secret presence checks, and production/test separation.
- Representation negotiation owns the HTML-versus-JSON boundary. It may render browser forms and readable results, but it must call the same route validation, domain services, repositories, and cryptographic interfaces as the canonical API operation. Do not build mock or duplicate "demo" authentication or storage logic.

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
- Browser-facing responses and errors must use the shared content-negotiated HTML page shell when the client prefers `text/html`. JSON API errors must include hypermedia `_links` and `actions`; token success responses must remain OAuth/OIDC protocol-compatible.
- Browser helpers for protocol endpoints must be explicit HTML representations of the real endpoint. They must not weaken client authentication, redirect matching, PKCE, consent, scopes, token handling, rate limits, or other protocol checks. Browser-only state-changing forms require same-origin and CSRF validation without changing standards-compliant non-browser API requests. Same-origin checks must recognize the configured `ISSUER_URL` origin when Sites dispatches the Worker under an internal request URL, and may accept `Origin: null` only with `Sec-Fetch-Site: same-origin`. Use one validated, host-only, `HttpOnly`, `SameSite=Lax`, secure CSRF token per browser session window rather than rotating it on every form render; concurrent operation pages must remain usable, while missing, malformed, mismatched, and cross-origin submissions fail closed.
- Device token polling must authenticate the client and require an exact match with the client that created the device grant. The current signed-in browser session may approve a pending code but may not replace the polling client's identity or secret.
- Browser UI styles must be served from same-origin stylesheet routes such as `/auth-ui.css`; do not rely on inline `<style>` blocks that are blocked by the strict CSP.

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
- storage records
- storage file metadata

Store hashes, not plaintext, for authorization codes, device codes, refresh tokens, confidential client secrets, and bearer-equivalent one-time credentials. Add expiration indexes for bounded cleanup. Cleanup must be safe during ordinary requests and must not require long background jobs.

Migration changes must include schema updates, checked-in SQL, automated migration tests, documentation updates, and validation evidence in the same task.

This repository intentionally uses prepared D1 statements and handwritten SQL migrations, not Drizzle ORM or Drizzle Kit. `db/migrations/` is the canonical reviewed SQL history, `db/schema.ts` is the required-table manifest used by consistency checks, and `build/sites-migrations.ts` deterministically emits Sites-compatible SQL artifacts and a migration journal into `dist/.openai/drizzle/` during the build. Sites applies those artifacts during deployment. Production request handlers must never run `CREATE`, `ALTER`, or `DROP`, and no runtime migration copy may silently diverge from the canonical SQL. Do not reintroduce ORM tooling unless a future architecture task adopts it completely with schema declarations, generated migrations, tests, and documentation.

Storage rules:

- JSON records are D1 data keyed by local user UUID, OAuth client ID, and logical application key.
- File metadata is D1 data keyed by local user UUID, OAuth client ID, and logical application key.
- File bytes are stored in R2 through binding `BUCKET`.
- Caller-supplied logical keys must never be used as physical R2 object keys. Generate physical R2 keys server-side.
- Storage endpoints require this service's own bearer access tokens and `storage.read`, `storage.write`, or `storage.delete` scopes as applicable.
- Every storage repository operation must bind both local user UUID and OAuth client ID. There is no generic SQL, D1-table, R2-listing, environment, binding, or secret API. Success and error responses must omit owner IDs, client IDs, physical R2 keys, private signing material, and deployment configuration.
- Storage scopes are local AittaDB permissions only; never describe them as granting ChatGPT or OpenAI access.
- Browser record and file forms default to current-session mode when a trusted Sites identity is present and otherwise default to explicit token mode. Current-session data is keyed by the local UUID plus reserved browser-client ID and must remain invisible to ordinary OAuth clients, including clients used by the same user. Explicit bearer values are accepted only in CSRF-protected form bodies. Record forms cap URL-encoded input before forwarding and rely on the canonical 64 KiB JSON limit. File forms use bounded multipart parsing, reject declared bodies above the 10 MiB file limit plus bounded form overhead, recheck actual `File.size`, and forward bytes to the canonical R2 operation. Submitted and internally issued tokens must never be copied into result HTML, URLs, cookies, logs, or browser storage.

## OpenAPI Rules

Maintain one canonical OpenAPI 3.1 specification in `src/openapi.ts`. Serve it as JSON from `/openapi.json` and provide a self-hosted Swagger UI at `/docs`. Swagger assets must be served from the AittaDB origin, load the canonical spec rather than a second generated copy, work under the strict CSP, and introduce no CDN or runtime third-party dependency. Scope AittaDB shell styles to named components or direct shell content; global element selectors must not override Swagger operation or schema controls.

The OpenAPI spec must describe every REST endpoint, parameters, request bodies, responses, OAuth errors, schemas, authentication requirements, examples, and supported HTML representations. It must distinguish ChatGPT Sites browser authentication from tokens issued by AittaDB. Validate OpenAPI in CI and test that documented routes and implemented routes do not silently diverge.

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

For the canonical hosted service, `ISSUER_URL` must be exactly `https://aittadb.com` with no path or trailing slash. Changing the issuer is an operational token-boundary change: previously issued JWTs with another `iss` value will no longer validate under the new configuration and this must be called out during deployment acceptance.

Build tooling must prefer the ignored checkout-local `.openai/hosting.json` when it exists and fall back to the checked-in `.openai/hosting.example.json` only for clean-checkout validation. The safe template is not deployable configuration and must never substitute for creating a fork-specific Sites project before deployment.

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

This project is a hosted application backend with REST APIs and authentication, not a marketing website. Do not add a marketing landing page, feature sections, testimonials, pricing, a general dashboard, a general profile page, or a documentation portal beyond the OpenAPI viewer and focused operational interfaces.

The root route is public. It must return concise hypermedia service metadata to API clients and a polished service entry page to browsers. It must explain the ChatGPT sign-in boundary and link to the real session, OAuth/OIDC, storage, health, OpenAPI, and administrator routes. Public discovery and authorization initiation must not require authentication; protected routes must start the actual Sites-owned ChatGPT sign-in flow when identity is required.

The browser interface is not a simulated demo. Every sign-in, device grant, authorization, token, UserInfo, revocation, introspection, JSON-record, file-storage, and administrator action exposed from the interface must execute the production route and domain logic with the same validation and durable state as its API representation. Do not create separate mock users, sample-only grants, fake tokens, fake storage, or browser-only authorization shortcuts.

Every API endpoint must provide a useful content-aware HTML representation when a browser explicitly prefers `text/html`, while preserving its canonical JSON, OAuth, OIDC, or binary behavior for API clients. Read-only endpoints may render structured values and raw-JSON links. State-changing or credential-bearing operations must use focused forms, never place credentials or bearer values in URLs, validate CSRF and same origin for browser-only submissions, and render secrets only in a deliberate one-time result where the underlying protocol requires returning them. Binary file downloads may remain binary after an authenticated browser operation, but their collection and item routes must provide working HTML controls for listing, upload, download, and deletion.

The protected local session view is an authentication boundary and operational identity view, not a general account profile. It may show the signed-in user's own email, display name, and immutable AittaDB subject UUID, explain that AittaDB creates its own identity and sessions, and link to real operations available to that user. Authorization must continue to come from server-side policy, client grants, and scopes; never from display name or merely being signed in.

The operation map must explain how the current session participates in each flow. It approves device codes, supplies the user at Authorization Code consent, provides current-session UserInfo and a reserved personal storage namespace, and authorizes client administration only for exact `ADMIN_EMAILS` matches. It does not replace client registration, exact redirects, PKCE, state, nonce, client secrets, grants, token revocation credentials, or confidential-client introspection.

Use semantic HTML, visible focus, meaningful labels, clear validation errors, keyboard accessibility, screen-reader compatibility, and no unnecessary JavaScript.

HTML pages must follow `docs/style-guide.md`. The interface should match the polish level expected from contemporary ChatGPT Sites generated pages while remaining a compact application-backend service: strong typography, generous spacing, refined panels, purposeful local visual assets or CSS artwork, responsive layouts, and a consistent GitHub project affordance. Do not load runtime fonts, tracking scripts, or images from third-party origins.

The shared browser shell uses `public/aittadb-mark.svg`, the AittaDB wordmark, the self-hosted Inter variable font, and `public/aittadb-boundary.jpg`. Render `Aitta` at Inter weight `750` in midnight navy `#0B234A`, `DB` at Inter weight `750` in red-orange `#F04A32`, and icon accents in teal `#159CA6`; use `Inter, system-ui, "Segoe UI", sans-serif` as the font stack. Keep decorative artwork free of text, logos, secrets, PII, and deployment identifiers; render it with empty alternative text and page-specific adjacent copy. `public/og.png` is the canonical social card, and root-page Open Graph metadata must construct its absolute URL from the configured issuer. New HTML response types must define content-aware visual copy and use the shared shell unless a documented protocol constraint prevents HTML.

## Current Implementation State

The core AittaDB OAuth/OIDC issuer, ChatGPT Sites identity adapter, D1 persistence, R2-backed per-user/per-client storage APIs, security controls, OpenAPI document, self-hosted Swagger UI, production-backed protocol and storage browser forms, tests, CI, patched dependency set, shared branded HTML shell, public operation map, and protected local-session view are implemented on `codex/initial-implementation`. Live acceptance discovered five follow-up units in `PLAN.md`: storage isolation (`TASK-039`), Swagger style isolation (`TASK-040`), request-path performance and deployment-owned migrations (`TASK-041`), current-session operation coverage (`TASK-042`), and concurrent-tab CSRF continuity (`TASK-043`). They remain unchecked until their complete definitions of done pass. `TASK-037` remains the final hosted-domain and deployment acceptance item. Do not describe the release as complete until every checkbox, GitHub CI, final Sites deployment, live route parity, browser QA, and representative real Sites checks pass.

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
- style guide
- performance notes
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
- Swagger UI vendor consistency: `npm run swagger:check`
- Refresh pinned Swagger UI browser assets: `npm run swagger:sync`
- Migration consistency: `npm run db:check`
- High-severity dependency audit: `npm run audit:high`
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
