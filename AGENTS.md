# AittaDB Agent Instructions

Read before changes. Keep below 32,000 bytes (`npm run agents:check`); put rationale in `docs/` and retain boundaries.

## Purpose and Product Boundary

AittaDB is a general-purpose hosted database server and application-backend service. It exposes small, independent, reusable primitives through stable HTTP protocols. On ChatGPT Sites it maps trusted server-side sign-in to a local user, issues AittaDB OAuth/OIDC/JWT credentials, and isolates data.

Current: identity, OAuth/OIDC/JWT, records, files, and feature-gated Events.

Server boundary: identity/authentication; isolation; records/objects/events; conditional writes/versions/cursors/idempotency; bounded atomics/quotas/expiry/cleanup; hypermedia/OpenAPI/ops docs. Client SDKs, libraries, application integrations, and provider adapters belong in separate repositories; this repository documents protocols only.

Application workflows (billing, membership, provisioning, messaging, games) belong outside AittaDB and compose primitives. Examples cannot define provider routes/schemas/configuration/scopes/rules.

AittaDB is source-available and not affiliated with/endorsed by OpenAI. The current implementation depends on OpenAI-hosted ChatGPT Sites for runtime/sign-in/D1/R2/configuration/secrets. Local users, credentials, grants, sessions, and data belong to that AittaDB deployment, not OpenAI or ChatGPT. Never call it "OpenAI Auth", "ChatGPT OAuth", or an official "Sign in with ChatGPT" OAuth service, or imply its credentials are OpenAI/ChatGPT credentials.

AittaDB does not expose or forward ChatGPT cookies, credentials, tokens, or sessions. It does not access ChatGPT conversations, files, Projects, Library, connectors, subscriptions, roles, billing, or API quota. Its scopes authorize only AittaDB resources.

Public releases use FSL-1.1-MIT and convert to MIT after two years; an immediate MIT license is available commercially. Call a current FSL release source-available, not open source; converted or direct MIT versions are open-source software.

## Canonical Source and Origin

`https://github.com/aittadb/aittadb` is canonical/public/secret-free. Preserve files/lockfile/package choices/instructions/unrelated changes. Commit no secrets/private deployment material; use inert placeholders/synthetic fixtures. Never echo suspected exposure; escalate privately. Rotation, revocation, or history rewrites need approval.

Production issuer is `https://aittadb.com`; each acceptance/fork uses its own HTTPS issuer. `ISSUER_URL`, discovery, JWT `iss`, verification URLs, absolute hypermedia, and social metadata use that deployment's issuer. A legacy `chatgpt.site` host may route at the platform, but is not canonical.

`develop` tracks `main`; only validated main-ready work belongs there. Keep unfinished work separate. `test.aittadb.com` permits bounded reversible tests; restore settings and delete fixtures/secrets. Production must use the accepted commit/build. Approval is required to push/merge `main` or alter `aittadb.com` deployment, secrets, access, or versions.

## Runtime Contract

Use strict TypeScript, Vinext, and Cloudflare Worker ESM. Deployed code cannot require Node APIs, filesystem writes, server processes, or durable memory; Node APIs are only for builds, local administration, and tests.

Runtime requirements:

- D1 binding: `DB`; structured authoritative state lives in D1.
- R2 binding: `BUCKET`; file bytes live in R2. Add no other R2 dependency without a real requirement.
- Web Crypto for production cryptography.
- Environment variables and Sites secrets for configuration.
- No authoritative state in `localStorage`, `sessionStorage`, process memory, or browser cookies. Cookies may carry protected transaction state only.
- Process memory may cache hints only; correctness cannot depend on it.
- Root metadata, health, discovery, JWKS, OpenAPI, docs, and assets avoid D1; Vinext serves assets and `waitUntil` runs bounded cleanup/repair.
- `.openai/hosting.json` is ignored checkout-local metadata and may contain the active project ID and logical bindings. Never commit a real reusable `project_id`. Keep `.openai/hosting.example.json` safe for forks.

## Upstream Identity Trust Boundary

Sites owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, callbacks, and dispatcher behavior. Do not implement or override them. Internal `return_to` values must be same-origin relative paths; never pass a registered client URL directly to Sites sign-in.

Trust only these server-side headers inside the trusted Sites runtime:

- `oai-authenticated-user-email`
- optional `oai-authenticated-user-full-name`
- `oai-authenticated-user-full-name-encoding`, when present

Decode a full name only when encoding is exactly `percent-encoded-utf-8`. Fall back to email for display. A display name is never authorization data. Use email only to find or create a local user with an immutable generated UUID; that UUID is downstream `sub`. Document email change and reassignment risk.

Never trust browser JavaScript for identity or accept arbitrary `oai-authenticated-user-*` headers outside Sites. Production injects only the Sites provider; no identity bypass/test binding. Mocks live under `tests/` and use explicit dependency injection. Tests never require a real ChatGPT account.

## AittaDB Credentials and Scopes

AittaDB issues all downstream credentials. Scopes are `openid`, `email`, `profile`, `offline_access`, `storage.read`, `storage.write`, `storage.delete`, `events.publish`, `events.read`, and `events.subscribe`. Events scopes require `FEATURE_EVENTS_ENABLED=true` and authorize AittaDB only: publication requires `events.publish`, reads require `events.read`, and bounded waits also require `events.subscribe`. Add no scope without its owning task.

Lead public descriptions with "source-available hosted application backend for third-party apps", then ChatGPT sign-in inside ChatGPT Sites, AittaDB sessions, JSON records, files, and enabled Events. State the Sites dependency without leading with defensive "third-party"/"non-official" labels; keep no-affiliation/no-endorsement secondary and never imply technical independence. Avoid unexplained "Sites identity" or "Token authority"; use "Session issuer". Keep `officialOpenAIProduct: false` in machine metadata, not browser copy.

## Repository Structure

- `.github/workflows/`: lockfile CI validation only; never deploy or hold credentials.
- `.openai/`: ignored active hosting metadata and safe template.
- `app/`: Vinext entries delegating to `src/`.
- `build/`: Node-only packaging/migration artifacts; no deployed domain behavior.
- `db/`: table manifest and canonical handwritten migrations.
- `docs/`: architecture, security, operations, deployment, and examples.
- `openapi/`: supporting material; `src/openapi.ts` is canonical.
- `public/`: same-origin brand, fonts, social, and Swagger assets.
- `scripts/`: Node-only validation/local administration.
- `src/`: deployed domain, protocols, repositories, crypto, config, HTTP, identity, storage, and HTML.
- `tests/`: unit/integration tests with test-only adapters/fakes.

## Unit Interfaces

Semantic units. Co-locate code/tests; avoid dumping grounds. Prefer owned files/narrow composition points to avoid hot spots. Declarative registration; no registry/plugins without a second use.

- HTTP handlers parse/limit/negotiate, apply CORS/security, and call domain services.
- `UpstreamIdentityProvider` parses trusted identity; production injects Sites and tests inject mocks.
- User repository owns email lookup, UUIDs, and metadata; client repository owns type, redirects/origins/scopes, disablement, hashes, and rotation.
- OAuth owns grants, consent, revocation, and introspection; OIDC owns discovery, JWKS, claims, nonce, UserInfo, and verification; token storage owns hashes, grants, revocations, expiry.
- Consent, audit, and rate-limit repositories own narrow records. Audit actor attribution is nullable canonical SHA-256 base64url, never generic JSON.
- Storage owns scoped records, finite receipts, and file metadata; R2 keys are generated. Events owns immutable publication/reads/waits: valid-token ownership, hashed idempotency, bounded read+subscribe cursor waits, no fan-out/payload logs, and exact leased-subject purge.
- Account deletion follows `docs/account-deletion-jobs.md`: trusted exact-email POST needs origin/CSRF/phrase/bound encryption; admins/replay reject. GET authenticates the handle before D1/identity. Leased purge covers credentials/records/events/files; finalization clears audit attribution and needs no owned rows; status is coarse. Same email gets a UUID/empty namespace; old JWTs only verify to `exp`, never authorize/identify.
- Storage HTML adapts forms to canonical `storageEndpoint` without duplicate authorization/storage logic; browser sessions map trusted identity to a short-lived hidden reserved-client token.
- Crypto owns randomness, hashing, constant-time comparison, PKCE, JWTs, and JWKS. Configuration owns parsing/defaults/secrets/production-test separation/availability; disabled features fail before domain/repository work and vanish from every representation. Negotiation chooses HTML or JSON/binary; pages execute real routes, never demos.

Use narrow interfaces for services, repositories, adapters, handlers, boundary data, and props. Core depends on contracts; implementations depend on core. Inject explicitly; no globals, hidden singletons, cycles, or init-order behavior. Validate boundaries, export only needed contracts, use DI where it improves tests. Each task owns contract, code, tests, docs, and config/migrations.

## TypeScript and React Architecture

Use strict TypeScript; no `any`. Validate `unknown` at boundaries; use guards, named types, generics, and exhaustive discriminated unions. Separate pure domain from effects. Use domain names; comments explain contracts, invariants, or non-obvious intent, never syntax.

Keep focused semantic files, not arbitrary one-liners. Prefer feature modules and narrow interfaces over central hot spots; keep refactors narrow. Use a small typed strategy/handler/adapter/factory/middleware for independent behaviors. No DI container/plugin system/layer for one simple implementation.

React components have one visible responsibility and semantic accessible HTML. Prefer composition and typed props over configurable/nested variants. Keep data, validation, and transitions outside rendering; use hooks/services only for real reusable boundaries. Keep state local until shared; make loading, empty, unavailable, error, and success explicit. No UI dependency unless standardized or required.

Test independently: inject effects through parameters, constructors, props, or small factories, not globals; test observable component behavior; keep fixtures local; add defect regressions. Before coding, identify the boundary, edits, composition point, and parallel-safe ownership. Growing central conditionals, mixed rendering/networking/validation/persistence, broad utilities, leaked feature logic, concrete imports, or global setup signal the smallest needed refactor boundary.

Before adding work, answer: (1) server primitive? (2) demonstrated problem? (3) reusable across unrelated apps? (4) extend one? (5) smaller vendor-neutral contract? (6) compose through public protocols? (7) every new abstraction needed now? If mainly an application feature, client implementation, provider integration, or speculative extension system, keep it outside this repository. If a request conflicts, stop before implementation; propose the smallest general-purpose enabling primitive and seek a decision only if none fits. Choose the smallest bounded, testable design; never weaken security, privacy, authorization, durability, or failure handling. Use prepared SQL with bound values, documented times, and Worker APIs.

## Cryptography and Authentication

- JWTs use ES256/P-256 Web Crypto and hosted private JWKs; publish only public JWKs, require `kid`, and never generate startup keys. Follow `docs/key-rotation.md` for protected files, no private stdout/clobber, validation, and JWKS matching.
- Human tokens use immutable local UUID `sub`; service tokens use their client UUID as non-user `sub` and `aud`. Include unique `jti` and default 600-second access lifetime. Validate exact algorithm, key, signature, issuer, audience, times, and purpose.
- Omit `email_verified` or set it false unless Sites explicitly documents that assurance.
- Authorization/device/refresh credentials are random; store only hashes for bearer-equivalent values and client secrets. Rotate refresh tokens on use; reuse revokes the family.
- Access-token consumers require `token_use=access` and a valid `jti`; ID tokens never authorize UserInfo, introspection, storage, or administration. UserInfo also requires the `openid` scope.
- One-time D1/memory transitions use affected-row-gated compare-and-set; never separate pending/unused reads from consumption writes.
- Generated client secrets appear once, are SHA-256 hashed, and are compared without timing-dependent early exit.
- Never log or put access, refresh, device, authorization, client, CSRF, cookie, or signing credentials in URLs or client bundles.

Downstream OAuth Apps default off. Gate them before client auth, credential lookup/consumption, or writes; omit their routes/actions. The reserved browser client and Sites session remain separate.

OAuth rules when enabled:

- Implement RFC 8628, Authorization Code with PKCE `S256`, and service-only Client Credentials; never implicit/password grants. Public clients have no secret; confidential/service clients authenticate. Service clients have no redirects/origins, accept only enabled storage/Events scopes, use one isolated non-human namespace, and receive no user claims, ID token, or refresh token.
- Enforce exact redirects/scopes; authorization codes are high-entropy, short-lived, and one-time.
- Preserve `state` and OIDC `nonce`.
- Require explicit consent unless remembered consent exactly covers client and scopes.
- Device polling enforces interval, `slow_down`, pending/denied/expired, client binding, and one-time approval. Persist code hashes only; reconstruct display solely from the matching same-origin submission.
- Use standard OAuth content types and errors. Token success remains protocol-standard.
- Introspection is secret-client-only and reports active access tokens. Revocation authenticates the owner, handles access/refresh tokens despite hints, revokes families, records access-token `jti`, and remains non-disclosing.

OAuth administration requires a Sites session mapped to `ADMIN_SUBJECTS`, never email or another credential. Hide non-admin data/actions; require origin/CSRF and one cross-representation policy. Atomically claim submissions; use PRG with a subject-bound encrypted one-use result cookie. Show secrets once, client-bind/hash them, audit redacted, and provide no dynamic registration. Subject allowlisting retains email-reassignment risk.

## Storage Isolation

- JSON records use separate legacy-key and revisioned collection/ID D1 rows, always keyed by principal and client UUID. Human principals are local users; service principals are excluded from user identity surfaces.
- File metadata: same ownership key in D1; bytes in `BUCKET` under generated physical keys.
- Caller keys never become physical R2 keys.
- Every repository read/list/write/delete binds both local UUID and client ID.
- Canonical storage methods require AittaDB bearer access tokens and `storage.read`, `storage.write`, or `storage.delete`.
- Expose no generic SQL, table, D1, R2 listing, environment, binding, owner/client ID, physical key, configuration, or secret API.
- Omit private JWKs, secrets, deployment values, owner IDs, client IDs, and R2 keys from success and failure output.
- Record JSON is limited to 64 KiB. File bytes are limited to 10 MiB. Require trusted Sites identity before parsing a browser multipart wrapper; then stream-bound it, distrust `Content-Length`, bound overhead, and recheck file size. Raw bearer uploads remain canonical API operations.
- File replacement uses copy-on-write keys and D1 compare-and-set. Repair rows block key reattachment; a bounded background batch deletes only globally unreferenced R2 objects, retains referenced bytes, and retries failures without a public surface.
- Attachment filenames are safe and logical-key based.
- Enforce finite deployment, local-user, and local-user/client item and byte ceilings atomically in D1. The write kill switch blocks create/replace but leaves authorized deletion available. Responses disclose only the current user/client namespace usage and limits.
- Collection reads use bounded deterministic keyset pages. Continuation cursors use canonical AES-GCM authenticated encryption derived from private signing-key material and bound to resource kind, local subject, and client; expose no position, user/client identifier, signing material, or secret. Private signing-key rotation invalidates them immediately.

Current-session storage uses the reserved browser client, so it is durable but isolated from every normal OAuth client, even for the same user. Token mode uses the token's client namespace. Submitted and internal tokens never reach HTML, URLs, cookies, logs, or browser storage.

## Browser and Hypermedia Contract

Assume public Sites access: anonymous callers receive only public resources; identity, storage, deletion, and administration stay subject-scoped, authorized, and quota-bounded. The root negotiates JSON and a polished HTML operation map; other resources retain JSON fallback. Selection never uses `User-Agent`. Keep public `robots.txt` and local social metadata crawlable. Add no hero, pricing, testimonials, blog, dashboard, general account/profile pages, or nonessential navigation. `/session` is a focused protected identity/operations view.

Follow `docs/hypermedia-json-rest-api.md`. One resource URI has equivalent HTML and JSON selected by `Accept`, never `User-Agent`; `Content-Type` describes input. Do not split API/web routes. Preview `0.1` JSON uses `data`, semantic `links`, authorized `actions`, media type `application/vnd.aittadb+json; version=0.1`, JSON compatibility, and `AittaDB-API-Version`; stable breaking changes require a new version.

Build one resource/operation model rendered as machine controls or semantic HTML. Actions provide stable names, targets, methods, encodings, typed fields, constraints, choices, and values. Omit unavailable controls by identity, scope, permission, resource, or protocol state; enforce authorization server-side. OpenAPI describes possible versioned operations; hypermedia describes what this caller can do now.

Every application endpoint supplies useful HTML and hypermedia JSON. OAuth/OIDC discovery, JWKS, authorization, token, revocation, introspection, and UserInfo retain standard wire formats; entry resources may advertise forms. Errors include valid recovery controls. HTML executes real validation and durable state, never mock users, credentials, storage, or browser-only authorization.

Browser mutation adapters reject invalid origins before body reads, rate limiting, repository, R2, or maintenance, then require CSRF. Accept issuer-origin Sites dispatch and `Origin: null` only with `Sec-Fetch-Site: same-origin`. Use a bounded host-only `Secure`, `HttpOnly`, `SameSite=Lax` CSRF cookie for concurrent tabs. Fail closed otherwise.

Storage HTML stays resource-oriented: collections render bounded lists/empty states, item navigation, and create/upload; item GET renders only actions valid for its URL key. Browser POST adapts to that same URL via validated `_method`; keys never come from override fields. Signed-in collection upload accepts only request/issuer-origin item `Location` and redirects on request origin; bearer and token-mode results retain `201`. No-JavaScript `?key=` navigation redirects only to an encoded same-origin item path. Never mix unrelated URLs in an operation selector or render JSON dumps as HTML results.

`/auth-ui.js` only progressively hides/disables inactive fields, links required state to visibility, and upgrades navigation. HTML works without JavaScript; server validation is authoritative. Assets are same-origin, CSP-compatible, and perform no D1 work. Use semantic accessible responsive HTML, visible focus, clear errors, minimal JavaScript, no third-party runtime assets/trackers, and scoped shell CSS that does not break Swagger. Follow `docs/style-guide.md`.

Retain the reviewed `vendor/image-size-compat` override while Vinext's build-only dependency remains vulnerable; verify `npm ls image-size`, focused malformed-container tests, and the high-severity audit before changing it. Self-host Inter with system fallbacks; use the AittaDB navy/red-orange/teal contract and checked-in mark, boundary image, and social card. Shared HTML uses the common shell and GitHub footer unless protocol/binary output forbids it.

## Database and Migrations

D1 schema must cover users, clients, redirects, scopes, authorization requests/codes, device grants, refresh families/tokens, consents, revoked access-token IDs, audit/application events, admin submissions, rate limits, legacy/revisioned records/receipts/files, repair/fence state, and deletion jobs. Rate increments are single-statement atomic. Index expiration, cleanup joins, and pages; select bounded cleanup oldest-first with a `rowid` tie-breaker and retain new empty refresh families through the documented race-prevention grace window.

Events and transaction receipts use configured finite retention. Cleanup deletes at most 500 oldest expired rows per category and reports only category/count/limit.

`db/migrations/` is canonical reviewed SQL. `db/schema.ts` is the required-table manifest. `build/sites-migrations.ts` deterministically emits Sites artifacts and journal under `dist/.openai/drizzle/`; Sites applies them. Runtime handlers never execute `CREATE`, `ALTER`, or `DROP`. This project intentionally uses handwritten migrations, not Drizzle ORM/Kit. Do not reintroduce ORM tooling without a complete architecture task.

Every schema change includes the manifest, checked-in migration, migration tests, architecture/docs, and validation in the same task. Migrations are forward, deterministic, reviewed, and safe for existing data; never rewrite applied history casually.

## OpenAPI

Maintain one OpenAPI 3.1 source in `src/openapi.ts`; serve it at `/openapi.json`. `/docs` is self-hosted Swagger UI using pinned same-origin assets and that canonical document, with no CDN or persisted authorization.

Document every REST and browser method, parameter, body, response, OAuth error, schema, auth requirement, example, content type, Device Grant, and PKCE flow. Clearly separate upstream ChatGPT sign-in from AittaDB credentials. Update implementation and OpenAPI together. `npm run openapi:check` must catch route drift; `npm run swagger:check` must catch vendor drift.

## Configuration, Secrets, Logs

`.env.example` names variables without values. Configure issuer/signing, lifetimes, origins, finite limits, write switch, admin subjects, and flags. Missing secrets or malformed flags fail closed. Records, Files, and Statistics default on; OAuth Apps and Events off. Events enables its scopes, publication, reads, and bounded waits; when off, reject before origin/body/CORS/auth/rate/repository/maintenance and omit controls. Production `ISSUER_URL` is `https://aittadb.com`; acceptance/forks use their own pathless HTTPS issuer. Changes invalidate the old token boundary and need acceptance notes.

Generate local ES256 keys only by documented command. Ignored keys stay local; never print, commit, or put them in public hosting metadata. Bootstrap by signing in at `/session`, then configure that deployment-local UUID in `ADMIN_SUBJECTS`; never use email or names. Keep upstream email-reassignment risk explicit.

`/privacy` is public HTML and versioned hypermedia JSON. `PRIVACY_CONTROLLER_*`/`PRIVACY_CONTACT_*` values take precedence; otherwise resolve only the first `ADMIN_SUBJECTS` UUID and publish its stored email plus optional name, never UUIDs, allowlists, provenance, or other fields. Invalid/unresolved data returns generic `503`. Link every HTML page and keep the policy and OpenAPI synchronized with actual data, retention, hosting, residency, cookies, rights, and operator-review behavior.

Redact PII and every credential from logs. Use generic auth errors that do not reveal account existence. Minimal audits may contain event type, structured hashed actor attribution, client/request references, bounded coarse metadata, and timestamps. OAuth, identity, storage, and token responses use `Cache-Control: no-store` where sensitive.

Security headers include restrictive CSP, `frame-ancestors 'none'`, no sniffing, referrer policy, permissions policy, and production HTTPS HSTS. Bearer CORS binds the active audience client and exact origin; token CORS binds the submitted active client before credential consumption. Never use wildcard credentialed CORS or caller-controlled issuer/audience. Prebuffer accepted form/JSON bodies through stream limits before parsing or repositories; declared lengths never relax limits. Stream-bound other bodies and rate-limit OAuth, storage, Events, client authentication, and administration. See `docs/threat-model.md` and `SECURITY.md`.

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
- Secret checks: `npm run secrets:check`, `npm run secrets:audit-history`
- High-severity audit: `npm run audit:high`
- Production build: `npm run build`
- Complete validation: `npm run validate`
- Local keys: `make generate-local-jwt-key`; npm scripts `keys:prepare-rotation`, `keys:validate`, `keys:preflight` (use `--silent`)

Keep commands synchronized with `package.json`, CI, README, and contributor docs. CI lockfile-installs and runs every listed validation category without deploying.

## PLAN.md Workflow

Before repository-affecting work, first add or amend an unchecked root `PLAN.md` task. PLAN is one flat unfinished `TASK-NNN` queue with stable PLAN/CHANGELOG IDs.

Each item MUST own exactly one server primitive or one narrowly bounded operational proof; it fits one commit with objective DoD. Never combine independent resources, methods, controls, migrations, or live matrices in one task. Broad requests first create a decomposition task; dependency-order replacements, then retire the umbrella unchanged to CHANGELOG without claiming delivery. Describe the primitive, not its motivating application.

A Sites-only acceptance task proves one named behavior against one exact deployment and adds no source. Add missing work first. After DoD, remove the task from PLAN and append its unchanged description to CHANGELOG. Never archive partial/completed items.

Report evidence-based readiness confidence from `0/100` to `100/100`, decisive evidence, and uncertainty; rarely use `100/100`. It never replaces security gates or the definition of done. Capture every material residual finding in `PLAN.md`, `ROADMAP.md`, or `BACKLOG.md` before handoff.

`ROADMAP.md` is a flat stable `ROADMAP-NNN` future-direction list; `BACKLOG.md` is a flat stable `BACKLOG-NNN` unscheduled-idea list. Neither implies availability or authority to implement. Move work into PLAN first; update the source only after completion or documented retirement.

Backup/restore/sync stays inside the authorized user/client namespace and excludes internal auth tables, other namespaces, physical keys, bindings, secrets, and deployment data. Capacity is unknown; require bounded, resumable, idempotent, integrity-checked operations with explicit conflict, deletion, recovery, quota, and partial-failure semantics.

## Definition of Done

Implementation DoD: contract/code/negative tests/user+developer docs/passing format+lint+types+tests+build/necessary AGENTS+OpenAPI+schema+migration+architecture+config+ops updates. Scale tests by risk.

## Git, Review, and Deployment

Keep the primary worktree checkpointed: stage and make focused commits for intended changes promptly; push after checks. Planning commits may be direct. Preserve unrelated work; reset/checkout needs approval. Run `npm run validate` before handoff. Feature PRs target `develop`; keep at most one `main` PR from `develop`; no merge without approval; close superseded PRs unmerged. Never leave intended changes loose at handoff. Without push access, retain/report commits.

Outside test, deployment needs approval. Push validated `develop` to the Sites mirror with a short-lived env-only credential; never command args, Git config, files, logs, or source. Deploy/verify acceptance before the identical production commit/build; archives differ only by target `project_id`. Compare commits, apply migrations, verify status, and claim E2E only after hosted tests.

## Maintaining This File

Update `AGENTS.md` for architecture, interface, command, constraint, security, structure, deployment, operation, or workflow changes. Keep it below 32,000 bytes; put rationale in docs and replace stale text.

## Multi-agent execution

GPT-5.6 Sol Ultra is primary architect, orchestrator, integrator, and final decision-maker: it owns requirements, decomposition/dependencies, conflict resolution, review, validation, and the final diff. Direct work is coordination, integration, or irreducible.

- Use Luna for scoped search/logs/docs and fully specified routine code/tests; Terra for multi-file/state/debug; Sol High/Max for architecture, security, protocol, persistence, hard debugging, and review. Escalate rather than retry. Luna never owns unresolved product, protocol, auth, data-integrity, concurrency, or cross-cutting decisions.
- Parallelize only independent isolated worktrees; no overlap. Each unit owns code/tests/docs, and workers report files, validation, assumptions, risks, and next action. Primary integrates, resolves, validates, and accepts only reviewed complete commits; coordination files may be edited directly.
- AittaDB, Aitta Social Hub, Aitta Social, and Invest have separate Terra Ultra owners. Never inspect, direct, or assume another project's state; when input or action is needed, print one concise paste-ready prompt for the user naming the project, goal, facts, requested evidence, and exact reply needed.
