# AittaDB Agent Instructions

This file is authoritative for humans and AI agents working in this repository. Read it before changing code. Keep it concise and below 32,000 bytes; `npm run agents:check` enforces the limit. Put extended rationale in `docs/` and link it here when useful. Never shorten a mandatory boundary merely to meet the limit.

## Purpose and Product Boundary

AittaDB is a general-purpose hosted database server and application-backend service for third-party applications, services, and agents. Develop it as a focused server product of small, independent, reusable primitives exposed through stable HTTP protocols. On OpenAI-hosted ChatGPT Sites it maps trusted server-side sign-in to a local AittaDB user, issues its own OAuth/OIDC/JWT credentials, and provides isolated data.

Current capabilities are identity mapping, OAuth/OIDC/JWT sessions, D1-backed JSON records, and R2-backed files with D1 metadata. Persistent events and long-polling are planned, not implemented. Do not describe planned behavior as available.

The server boundary includes identity/authentication; user, client, application, and namespace isolation; records and objects; events and delivery; conditional writes, versions, cursors, idempotency, bounded atomic operations, quotas, rate limits, expiry, retention, cleanup, hypermedia, OpenAPI, and protocol/operational documentation. Client SDKs, libraries, application integrations, and provider adapters belong in separate repositories. This repository may document protocol use, but must not own those implementations.

Application workflows such as billing, memberships, infrastructure provisioning, messaging, or games belong outside AittaDB and compose its public primitives. Examples may motivate/evaluate a primitive, but must not determine provider-specific routes, schemas, configuration, scopes, or business rules here.

AittaDB is a source-available project, not affiliated with or endorsed by OpenAI. The current implementation depends on OpenAI-hosted ChatGPT Sites for runtime, sign-in, D1, R2, configuration, and secrets. Local users, credentials, grants, sessions, and stored data belong to that AittaDB deployment, not OpenAI or ChatGPT. Never call it "OpenAI Auth", "ChatGPT OAuth", an official "Sign in with ChatGPT" OAuth service, or imply that AittaDB credentials are OpenAI or ChatGPT credentials.

AittaDB does not expose or forward ChatGPT cookies, credentials, tokens, or sessions. It does not access ChatGPT conversations, files, Projects, Library, connectors, subscriptions, workspace roles, billing, or API quota. Its scopes authorize only AittaDB claims, sessions, and storage.

Current public releases use FSL-1.1-MIT and convert to MIT two years after publication. An MIT license for immediate use is also available commercially. Describe a current public FSL release as source-available, not open source; a converted or directly MIT-licensed version is open-source software.

## Canonical Source and Origin

GitHub at `https://github.com/aittadb/aittadb` is canonical. Work in the current checkout; do not create another canonical tree. Preserve its files, npm lockfile, package choices, instructions, uncommitted user changes, and unrelated work.

The canonical public origin and issuer is `https://aittadb.com`. `ISSUER_URL`, discovery, JWT `iss`, verification URLs, absolute hypermedia, and social metadata must use it. A legacy `chatgpt.site` host may route at the platform, but is not canonical.

Use feature branches. Never push directly to `main`, merge, deploy, publish, save a production version/checkpoint, rotate hosted secrets, or change Sites access settings without the user's explicit approval. A task-specific approval does not authorize unrelated operational changes.

## Runtime Contract

Use strict TypeScript, Vinext, and Cloudflare Worker-compatible ESM. Deployed modules must not require Node-only APIs, filesystem writes, server processes, or durable process memory. Node APIs are allowed only in isolated build scripts, local administration, and tests.

Runtime requirements:

- D1 binding: `DB`; structured authoritative state lives in D1.
- R2 binding: `BUCKET`; file bytes live in R2. Add no other R2 dependency without a real requirement.
- Web Crypto for production cryptography.
- Environment variables and Sites secrets for configuration.
- No authoritative state in `localStorage`, `sessionStorage`, process memory, or browser cookies. Cookies may carry protected transaction state only.
- Process memory may hold non-authoritative performance hints; correctness cannot depend on survival or uniqueness.
- Public metadata, health, discovery, JWKS, OpenAPI, docs, CSS, and JavaScript routes must not initialize D1. Static assets pass to Vinext. Durable-route cleanup is bounded and scheduled with `waitUntil`, not awaited on every response.
- `.openai/hosting.json` is ignored checkout-local metadata and may contain the active project ID and logical bindings. Never commit a real reusable `project_id`. Keep `.openai/hosting.example.json` safe for forks.

## Upstream Identity Trust Boundary

Sites owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, callbacks, and dispatcher behavior. Do not implement or override them. Internal `return_to` values must be same-origin relative paths; never pass a registered client URL directly to Sites sign-in.

Trust only these server-side headers inside the trusted Sites runtime:

- `oai-authenticated-user-email`
- optional `oai-authenticated-user-full-name`
- `oai-authenticated-user-full-name-encoding`, when present

Decode a full name only when encoding is exactly `percent-encoded-utf-8`. Fall back to email for display. A display name is never authorization data. Use email only to find or create a local user with an immutable generated UUID; that UUID is downstream `sub`. Document email change and reassignment risk.

Never trust browser JavaScript for identity or accept arbitrary `oai-authenticated-user-*` headers outside Sites. Production app assembly injects only the Sites header provider and has no identity bypass or test binding. Mock providers live under `tests/` and enter only through explicit dependency injection. Automated tests never require a real ChatGPT account.

## AittaDB Credentials and Scopes

AittaDB alone issues downstream access tokens, refresh tokens, ID tokens, authorization codes, device codes, consents, and sessions. Supported scopes are `openid`, `email`, `profile`, `offline_access`, `storage.read`, `storage.write`, and `storage.delete`. The data model may permit future custom scopes, but do not invent more MVP scopes.

Lead public descriptions with "source-available hosted application backend for third-party apps", then ChatGPT sign-in inside ChatGPT Sites, AittaDB-issued sessions, JSON records, and files. State the current Sites dependency without leading with defensive "third-party" or "non-official" labels; keep the no-affiliation/no-endorsement boundary as secondary trust copy and never imply technical independence. Do not use unexplained "Sites identity" or "Token authority" copy. Use "Session issuer" where needed. Keep `officialOpenAIProduct: false` in machine metadata, not a browser row.

## Repository Structure

- `.github/workflows/`: lockfile install and validation CI; no deployment credentials or deployment job.
- `.openai/`: ignored active hosting metadata plus safe checked-in template.
- `app/`: Vinext entry routes; delegate behavior to `src/`.
- `build/`: Node-only Vinext/Sites packaging and deterministic migration artifacts; no deployed domain behavior.
- `db/`: required-table manifest and canonical handwritten SQL migrations.
- `docs/`: architecture, style, performance, threat model, deployment, self-hosting, examples, and key operations.
- `openapi/`: supporting OpenAPI material; `src/openapi.ts` is canonical.
- `public/`: same-origin static brand, font, social, and pinned Swagger assets.
- `scripts/`: Node-only validation and local administrative tools.
- `src/`: deployed domain, protocol, repositories, cryptography, configuration, HTTP, identity, storage, and HTML representations.
- `tests/`: unit and integration coverage using test-only adapters and in-memory fakes.

Update this section in the same task if ownership moves.

## Unit Interfaces

Every server unit is a reusable primitive with a small vendor-neutral contract, bounded execution, authorization/isolation, defined failures, and natural composition. Keep dependencies narrow:

- HTTP handlers parse/limit/negotiate, apply CORS/security, and call domain services.
- `UpstreamIdentityProvider` parses trusted identity; production injects Sites and tests inject mocks.
- User repository owns email lookup, generated immutable UUIDs, and user metadata.
- Client repository owns client type, name, exact redirects, origins, scopes, disablement, secret hashes, and rotation.
- OAuth owns RFC 8628, Authorization Code/PKCE, exchange, scopes, consent, revocation, and introspection.
- OIDC owns discovery, JWKS, ID claims, nonce, UserInfo, issuer metadata, and verification.
- Token repository owns hashed codes, device grants, refresh families/tokens, revocations, and expiration cleanup.
- Consent, audit, and rate-limit repositories own their narrowly keyed durable records.
- Storage repository owns records and file metadata keyed by local UUID plus OAuth client ID. R2 bytes use generated physical keys.
- Storage HTML adapts protected forms to canonical `storageEndpoint` without duplicating scope, ownership, key, D1, or R2 logic.
- Browser sessions map trusted identity to a short-lived internal token for reserved client `aittadb-browser-session-v1`; never log, render, return, or persist it. Keep that migration-seeded client hidden, admin-immutable, and invalid for external grants.
- Crypto owns secure randomness, hashing, constant-time comparison, PKCE, JWT signing/validation, and JWKS.
- Configuration owns parsing, defaults, required-secret checks, and production/test separation.
- Representation negotiation chooses HTML or JSON/binary; pages execute real route/domain logic, never demos.

Use dependency injection where useful. Separate protocol-independent logic from HTTP and keep storage behind repository interfaces.

## TypeScript and Coding Rules

Use TypeScript `strict`; avoid `any`. Parse unknown input with explicit guards and structured APIs. Prefer small modules, pure domain functions, existing local patterns, and conservative changes. Use succinct comments only for non-obvious blocks.

Before adding work, answer: (1) is it a database-server or application-backend primitive; (2) does it solve one demonstrated problem; (3) can unrelated applications use it without application- or provider-specific behavior; (4) can an existing primitive be extended; (5) is its contract smaller than the motivating application feature; (6) can that external application build the use case entirely through public AittaDB protocols; and (7) is every new abstraction needed now? If the proposal is mainly an application feature, client implementation, provider integration, or speculative extension system, keep it outside this repository. If a request conflicts, stop before implementation, identify the conflict, propose the smallest general-purpose enabling primitive, and request an explicit architecture decision only when no suitable primitive exists.

Prefer the smallest design that completely solves the demonstrated server requirement. Reuse a primitive before adding an abstraction. Add no framework, plugin/extension system, generic query language, workflow engine, or configuration layer without a concrete requirement that cannot be handled simply. Do not generalize one example without an independent server contract, merely rename or relocate complexity, or add infrastructure outside the database-server role. Prefer explicit data models, narrow interfaces, and short sequences of composable operations. Keep runtime behavior deterministic, bounded, observable, and testable; preserve public contracts unless a necessary change is explicitly versioned. Simplicity never weakens correctness, durability, security, privacy, authorization, or failure handling.

Use prepared SQL with one statement per `prepare()` and bound untrusted values. Never construct SQL identifiers or clauses from caller input. Use documented integer Unix seconds or ISO text consistently. Use Web-standard `Request`, `Response`, URL, streams, and Web Crypto in deployed code.

## Cryptography and Authentication

- JWTs use ES256/P-256 through Web Crypto. Load the private JWK only from a hosted secret, publish only its public form, require configured `kid`, and never generate startup keys.
- Include immutable local UUID `sub`, unique `jti`, and a default 600-second access lifetime. Validate signature, exact algorithm, `kid`, `iss`, `aud`, `exp`, `iat`, and optional `nbf`; reject wrong algorithms and unknown keys.
- Omit `email_verified` or set it false unless Sites explicitly documents that assurance.
- Authorization/device/refresh credentials are random; store only hashes for bearer-equivalent values and client secrets. Rotate refresh tokens on use; reuse revokes the family.
- Access-token consumers require `token_use=access` and a valid `jti`; ID tokens never authorize UserInfo, introspection, storage, or administration. UserInfo also requires the `openid` scope.
- One-time D1/memory transitions use affected-row-gated compare-and-set; never separate pending/unused reads from consumption writes.
- Generated client secrets appear once, are SHA-256 hashed, and are compared without timing-dependent early exit.
- Never log or put access, refresh, device, authorization, client, CSRF, cookie, or signing credentials in URLs or client bundles.

OAuth rules:

- Implement RFC 8628 and Authorization Code with PKCE `S256`; never implicit or password grants. Public clients use no secret; confidential clients authenticate.
- Enforce exact redirects/scopes; authorization codes are high-entropy, short-lived, and one-time.
- Preserve `state` and OIDC `nonce`.
- Require explicit consent unless remembered consent exactly covers client and scopes.
- Device polling enforces interval, `slow_down`, pending/denied/expired, client binding, and one-time approval. Persist code hashes only; reconstruct display solely from the matching same-origin submission.
- Use standard OAuth content types and errors. Token success remains protocol-standard.
- Introspection is confidential-client-only and reports active access tokens. Revocation authenticates the owner, handles access/refresh tokens despite missing/wrong hints, revokes families, records access-token `jti`, and remains non-disclosing.

Admin operations require the current trusted ChatGPT Sites session mapped to a canonical local UUIDv4 in `ADMIN_SUBJECTS`. There is no email allowlist, administrator password/key, key header, unlock form, or separate admin cookie. Non-admin representations expose no client data/actions; mutations still require same-origin and CSRF. Support list/create, public/confidential type, display name, exact redirects, scopes, origins, disable, secret rotation, grant revocation, and redacted mutation audits. No unrestricted dynamic registration. Subject allowlisting inherits upstream email-reassignment risk.

## Storage Isolation

- JSON records: D1 rows keyed by local UUID, client ID, and logical key.
- File metadata: same ownership key in D1; bytes in `BUCKET` under generated physical keys.
- Caller keys never become physical R2 keys.
- Every repository read/list/write/delete binds both local UUID and client ID.
- Canonical storage methods require AittaDB bearer access tokens and `storage.read`, `storage.write`, or `storage.delete`.
- Expose no generic SQL, table, D1, R2 listing, environment, binding, owner/client ID, physical key, configuration, or secret API.
- Omit private JWKs, secrets, deployment values, owner IDs, client IDs, and R2 keys from success and failure output.
- Record JSON is limited to 64 KiB. File bytes are limited to 10 MiB. Require trusted Sites identity before parsing a browser multipart wrapper; then stream-bound it, distrust `Content-Length`, bound overhead, and recheck file size. Raw bearer uploads remain canonical API operations.
- File replacement uses copy-on-write physical keys and D1 compare-and-set against the observed R2 key. Stale mutations fail `409` and retire their objects. D1/R2 failures use bounded cleanup or rollback; persistent cross-service failures fail generically and never disclose keys.
- Attachment filenames are safe and logical-key based.
- Enforce finite deployment, local-user, and local-user/client item and byte ceilings atomically in D1. The write kill switch blocks create/replace but leaves authorized deletion available. Responses disclose only the current user/client namespace usage and limits.
- Collection reads use bounded deterministic keyset pages. Continuation cursors use canonical AES-GCM authenticated encryption derived from private signing-key material and bound to resource kind, local subject, and client; expose no position, user/client identifier, signing material, or secret. Private signing-key rotation invalidates them immediately.

Current-session storage uses the reserved browser client, so it is durable but isolated from every normal OAuth client, even for the same user. Token mode uses the token's client namespace. Submitted and internal tokens never reach HTML, URLs, cookies, logs, or browser storage.

## Browser and Hypermedia Contract

The root is public and returns concise hypermedia JSON or a polished service entry page. It is an operation map, not marketing or a fake demo. Do not add a hero marketing site, pricing, testimonials, blog, dashboard, general account/profile pages, or nonessential navigation. `/session` is a focused protected identity/operations view.

Follow `docs/hypermedia-json-rest-api.md`. One resource URI has equivalent HTML and JSON selected by `Accept`, never `User-Agent`; `Content-Type` describes input. Do not split API/web routes. Preview `0.1` JSON uses `data`, semantic `links`, authorized `actions`, media type `application/vnd.aittadb+json; version=0.1`, JSON compatibility, and `AittaDB-API-Version`; stable breaking changes require a new version.

Build one resource/operation model and render machine controls or semantic HTML. Actions provide stable names plus concrete/templated targets, methods, encodings, typed fields, constraints, choices, and values. Omit unavailable controls by identity, scope, permission, resource, or protocol state, but always enforce authorization server-side. OpenAPI describes possible versioned operations; hypermedia describes what this caller can do now.

Every application endpoint supplies useful HTML and hypermedia JSON. OAuth/OIDC discovery, JWKS, authorization, token, revocation, introspection, and UserInfo retain standard wire formats; entry resources may advertise forms. Errors include valid recovery controls. HTML executes real validation and durable state, never mock users, credentials, storage, or browser-only authorization.

Browser mutations require same-origin and CSRF. Accept the issuer origin behind Sites dispatch; allow `Origin: null` only with `Sec-Fetch-Site: same-origin`. Use a bounded host-only secure `HttpOnly`, `SameSite=Lax` CSRF cookie that supports concurrent tabs. Missing, malformed, mismatched, or cross-origin submissions fail closed.

Storage HTML stays resource-oriented: collections render bounded lists/empty states, item navigation, and create/upload; item GET renders only actions valid for its URL key. Browser POST adapts to that same URL via validated `_method`; keys never come from override fields. No-JavaScript `?key=` navigation redirects only to an encoded same-origin item path. Never mix unrelated URLs in an operation selector or render JSON dumps as HTML results.

`/auth-ui.js` only progressively hides/disables inactive fields, links required state to visibility, and upgrades navigation. HTML works without JavaScript; server validation is authoritative. Assets are same-origin, CSP-compatible, and perform no D1 work. Use semantic accessible responsive HTML, visible focus, clear errors, minimal JavaScript, no third-party runtime assets/trackers, and scoped shell CSS that does not break Swagger. Follow `docs/style-guide.md`.

Retain the reviewed `vendor/image-size-compat` override while Vinext's build-only dependency remains vulnerable; verify `npm ls image-size`, focused malformed-container tests, and the high-severity audit before changing it. Self-host Inter with system fallbacks; use the AittaDB navy/red-orange/teal contract and checked-in mark, boundary image, and social card. Shared HTML uses the common shell and GitHub footer unless protocol/binary output forbids it.

## Database and Migrations

D1 schema must explicitly cover local users, clients, redirects, scopes, authorization requests/codes, device grants, refresh families/tokens, consents, revoked access-token IDs where needed, audit events, rate limits, storage records, and file metadata. Rate increments are single-statement atomic. Index expiration, cleanup joins, and pages; bound every cleanup category and retain new empty refresh families through the documented race-prevention grace window.

`db/migrations/` is canonical reviewed SQL. `db/schema.ts` is the required-table manifest. `build/sites-migrations.ts` deterministically emits Sites artifacts and journal under `dist/.openai/drizzle/`; Sites applies them. Runtime handlers never execute `CREATE`, `ALTER`, or `DROP`. This project intentionally uses handwritten migrations, not Drizzle ORM/Kit. Do not reintroduce ORM tooling without a complete architecture task.

Every schema change includes the manifest, checked-in migration, migration tests, architecture/docs, and validation in the same task. Migrations are forward, deterministic, reviewed, and safe for existing data; never rewrite applied history casually.

## OpenAPI

Maintain one OpenAPI 3.1 source in `src/openapi.ts`; serve it at `/openapi.json`. `/docs` is self-hosted Swagger UI using pinned same-origin assets and that canonical document, with no CDN or persisted authorization.

Document every REST and browser method, parameter, body, response, OAuth error, schema, auth requirement, example, content type, Device Grant, and PKCE flow. Clearly separate upstream ChatGPT sign-in from AittaDB credentials. Update implementation and OpenAPI together. `npm run openapi:check` must catch route drift; `npm run swagger:check` must catch vendor drift.

## Configuration, Secrets, Logs

`.env.example` lists names and documentation, never values. Important configuration includes issuer/signing data, token lifetimes, exact client origins, finite storage ceilings/page/rate settings, a storage write switch, and canonical administrator subjects. Production fails closed when required secrets are absent. The canonical `ISSUER_URL` is exactly `https://aittadb.com` with no path or trailing slash; issuer changes invalidate the old token boundary and require explicit acceptance notes.

Generate local ES256 keys only through the documented script/Make target. Secret key files are ignored. Never print a generated private key in agent conversation, commit it, or place it in public hosting metadata. Bootstrap administration by signing in at `/session`, then configuring that deployment-local UUID in `ADMIN_SUBJECTS`; never substitute email addresses or display names. The upstream email-reassignment risk remains explicit.

`/privacy` is public HTML and versioned hypermedia JSON. `PRIVACY_CONTROLLER_*`/`PRIVACY_CONTACT_*` values take precedence; otherwise resolve only the first `ADMIN_SUBJECTS` UUID and publish its stored email plus optional name, never UUIDs, allowlists, provenance, or other fields. Invalid/unresolved data returns generic `503`. Link every HTML page and keep the policy and OpenAPI synchronized with actual data, retention, hosting, residency, cookies, rights, and operator-review behavior.

Redact PII and every credential from logs. Use generic auth errors that do not reveal account existence. Minimal audit events may contain event type, local UUID, client ID, request ID, carefully bounded coarse request metadata, and timestamps. OAuth, identity, storage, and token responses use `Cache-Control: no-store` where sensitive.

Security headers include restrictive CSP, `frame-ancestors 'none'`, no sniffing, referrer policy, permissions policy, and production HTTPS HSTS. Bearer CORS is bound to the token audience's active client and exact origin. Token-endpoint CORS binds the submitted active client before consuming a credential. Never use wildcard credentialed CORS or user-controlled issuer/audience. Stream-enforce bounds and rate-limit OAuth, storage, client-authentication, and administration. See `docs/threat-model.md` and `SECURITY.md`.

## Documentation Set

Maintain `README.md`, `AGENTS.md`, `PLAN.md`, `ROADMAP.md`, `BACKLOG.md`, `LICENSE.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `.env.example`, architecture, style, performance, privacy baseline, threat model, deployment, self-hosting limits, OpenAPI, schema/migrations, CLI Device Grant example, browser/native PKCE example, curl examples, key generation/rotation, downstream JWT verification, fork setup, and Sites-specific behavior.

README must prominently state experimental status; source availability under FSL-1.1-MIT, two-year MIT conversion, and immediate commercial MIT licensing; current Sites platform and identity-header dependencies; separate local identity/credentials; that AittaDB does not provide an official ChatGPT OAuth service; and self-hosting adapter replacement. Keep claims current and put no-affiliation/no-endorsement language after the positive product description.

## Commands

- Install: `npm ci`
- Format check/write: `npm run format:check`, `npm run format`
- Lint: `npm run lint`
- Type check: `npm run typecheck`
- Unit/integration/all tests: `npm run test:unit`, `npm run test:integration`, `npm test`
- OpenAPI: `npm run openapi:check`
- Swagger check/sync: `npm run swagger:check`, `npm run swagger:sync`
- Migration consistency: `npm run db:check`
- Agent instruction budget: `npm run agents:check`
- High-severity audit: `npm run audit:high`
- Production build: `npm run build`
- Complete validation: `npm run validate`
- Local key file: `make generate-local-jwt-key`
- Ephemeral stdout key generation: `npm run keys:generate`

Keep commands synchronized with `package.json`, CI, README, and contributor docs. CI uses lockfile installation and runs format, lint, typecheck, unit/integration tests, OpenAPI, Swagger, migration, AGENTS-size, audit, and production build checks. It never deploys.

## PLAN.md Workflow

Before implementing any repository-affecting user request, first capture it in root `PLAN.md` by adding or amending an unchecked task. Follow-ups precede action; questions needing no repository change need no task. PLAN is the unfinished-work queue: one flat unchecked `TASK-NNN` list with identifiers stable across PLAN and `CHANGELOG.md`. Each dependency-ordered focused-commit item delivers one server primitive with contract, implementation, tests, docs, failures, configuration/migration/OpenAPI/AGENTS changes, and evidence. Describe the primitive, not its motivating application; apply the boundary rule across plans, architecture, OpenAPI, migrations, tests, and implementation.

Process in order unless a documented dependency requires otherwise. Add missing work before doing it. After the full definition of done passes, atomically remove the task from PLAN and append its stable identifier and unchanged full description to the current `CHANGELOG.md` completed-task archive. Never archive partial work or keep completed checkboxes in PLAN.

Parallelize independent work when practical. Implementation subagents MUST edit only isolated Git worktrees. The primary worktree integrates only reviewed, complete, validated agent commits; never import partial work. Coordination files such as `PLAN.md`, `ROADMAP.md`, `BACKLOG.md`, and `CHANGELOG.md` MAY be edited directly there.

Prefer the smallest coherent risk-reducing implementation. For feature/task/deployment/release readiness, report evidence-based readiness confidence from `0/100` to `100/100`, decisive evidence, and residual uncertainty; rarely use `100/100`. It never replaces security gates or the definition of done. Capture every material residual finding in `PLAN.md`, `ROADMAP.md`, or `BACKLOG.md` before handoff.

`ROADMAP.md` is a flat stable `ROADMAP-NNN` future-direction list; `BACKLOG.md` is a flat stable `BACKLOG-NNN` unscheduled-idea list. Neither implies availability or authority to implement. Move work into PLAN first; update the source only after completion or documented retirement.

Backup/restore/sync stays inside the authorized user/client namespace and excludes internal auth tables, other namespaces, physical keys, bindings, secrets, and deployment data. Capacity is unknown; require bounded, resumable, idempotent, integrity-checked operations with explicit conflict, deletion, recovery, quota, and partial-failure semantics.

## Definition of Done

Every implementation task completes all six in the same task:

1. The unit's public interface or contract.
2. Implementation.
3. Automated tests, including relevant negative paths.
4. User and developer documentation.
5. Successful formatting, linting, type checking, relevant tests, and build validation.
6. Necessary `AGENTS.md`, OpenAPI, schema, migration, architecture, configuration, and operational updates.

Never split one unit's implementation, tests, or documentation into separate tasks. Scale coverage to security risk and blast radius.

## Git, Review, and Deployment

Keep the primary worktree checkpointed: stage and make focused commits for intended changes promptly, and push after relevant checks when authenticated access is available. Planning-only checkpoints may be committed directly. Preserve unrelated user work; never use destructive reset/checkout without explicit instruction. Run `npm run validate` before handoff. Update/open a draft PR after validation; if push access is unavailable, retain the verified local commit and report it. Never leave intended changes loose at handoff and never merge. Reviews prioritize security, regressions, protocol divergence, and missing tests.

Production or preview deployment still requires the approval described under Canonical Source. Publish the exact validated committed source, apply checked-in migration artifacts through Sites, preserve D1/R2 bindings and hosted secrets, and verify deployment status. Never claim ChatGPT authentication works end to end unless a real private/public Sites deployment was tested. Record unverified Sites behavior and the exact next manual step.

## Maintaining This File

Update `AGENTS.md` in the same task whenever architecture, interfaces, commands, constraints, security policy, repository structure, deployment procedure, current operational knowledge, or workflow changes. Keep it below 32,000 bytes. Prefer compact normative rules here and deeper explanation in maintained docs; remove stale statements instead of appending contradictions.
