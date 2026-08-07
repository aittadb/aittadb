# AittaDB Agent Instructions

This file is authoritative for humans and AI agents working in this repository. Read it before changing code. Keep it concise and below 32,000 bytes; `npm run agents:check` enforces the limit. Put extended rationale in `docs/` and link it here when useful. Never shorten a mandatory boundary merely to meet the limit.

## Purpose and Product Boundary

AittaDB is a hosted application backend for third-party applications, services, and agents. It runs on the OpenAI-hosted ChatGPT Sites platform, maps a trusted server-side ChatGPT sign-in signal to a separate local AittaDB user, issues its own OAuth 2.0, OpenID Connect, and JWT credentials, and provides user-and-client-isolated JSON records and files.

Current capabilities are identity mapping, OAuth/OIDC/JWT sessions, D1-backed JSON records, and R2-backed files with D1 metadata. Persistent events and long-polling are planned, not implemented. Do not describe planned behavior as available.

AittaDB is independent and is not affiliated with, endorsed by, or an official product of OpenAI. It is deployed on ChatGPT Sites, but its local users, credentials, grants, sessions, and stored data belong only to AittaDB. Never call it "OpenAI Auth", "ChatGPT OAuth", an official "Sign in with ChatGPT" OAuth service, or imply that AittaDB credentials are OpenAI or ChatGPT credentials.

AittaDB does not expose or forward ChatGPT cookies, credentials, tokens, or sessions. It does not access ChatGPT conversations, files, Projects, Library, connectors, subscriptions, workspace roles, billing, or API quota. Its scopes authorize only AittaDB claims, sessions, and storage.

Current releases are source-available under FSL-1.1-MIT. Each released version converts to the MIT License two years after publication. Do not describe a current release as open source.

## Canonical Source and Origin

GitHub at `https://github.com/aittadb/aittadb` is canonical. Work in the current checkout; do not create another canonical tree. Preserve its files, npm lockfile, package choices, instructions, uncommitted user changes, and unrelated work.

The canonical public origin and issuer is `https://aittadb.com`. `ISSUER_URL`, discovery, JWT `iss`, verification URLs, absolute hypermedia, and social metadata must use it. A legacy `chatgpt.site` host may route at the platform, but is not canonical.

Use feature branches. The MVP branch is `codex/initial-implementation`. Never push directly to `main`, merge, deploy, publish, save a production version/checkpoint, rotate hosted secrets, or change Sites access settings without the user's explicit approval. A task-specific approval does not authorize unrelated operational changes.

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

Lead public descriptions with "hosted application backend for third-party apps", followed by ChatGPT sign-in inside ChatGPT Sites, AittaDB-issued sessions, JSON records, and files. Use "ChatGPT sign-in inside ChatGPT Sites" on first user-facing reference. Do not use unexplained "Sites identity" or "Token authority" copy. Use "Session issuer" where needed. Keep `officialOpenAIProduct: false` in machine metadata; explain independence naturally in HTML rather than as a yes/no row.

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

Keep dependencies narrow and explicit:

- HTTP handlers parse/limit requests, negotiate representations, apply CORS/security controls, and call domain services.
- `UpstreamIdentityProvider` parses the trusted signal; production injects the Sites provider and mocks remain under `tests/`.
- User repository owns email lookup, generated immutable UUIDs, and user metadata.
- Client repository owns client type, name, exact redirects, origins, scopes, disablement, secret hashes, and rotation.
- OAuth services own RFC 8628, Authorization Code with PKCE, token exchange, scope checks, consent, revocation, and introspection.
- OIDC services own discovery, JWKS, ID-token claims, nonce, UserInfo, issuer metadata, and verification.
- Token repository owns hashed codes, device grants, refresh families/tokens, revocations, and expiration cleanup.
- Consent, audit, and rate-limit repositories own their narrowly keyed durable records.
- Storage repository owns records and file metadata keyed by local UUID plus OAuth client ID. R2 bytes use generated physical keys.
- Storage browser adapter parses protected HTML forms and sends synthetic requests to canonical `storageEndpoint`; it never duplicates scope, ownership, key, D1, or R2 logic.
- Browser-session adapter maps current trusted identity to a minimal short-lived internal access token for reserved client `aittadb-browser-session-v1`; it never logs, renders, returns, or persists that plaintext token.
- System-client policy keeps that reserved client migration-seeded, hidden, immutable through administration, and rejected from external OAuth grants.
- Crypto owns secure randomness, hashing, constant-time comparison, PKCE, JWT signing/validation, and JWKS.
- Configuration owns parsing, defaults, required-secret checks, and production/test separation.
- Representation negotiation owns HTML versus JSON/binary only; browser pages always execute real route/domain logic, never a demo model.

Use dependency injection where it materially improves tests. Keep protocol-independent logic separate from HTTP and storage behind repository interfaces.

## TypeScript and Coding Rules

Use TypeScript `strict`; avoid `any`. Parse unknown input with explicit guards and structured APIs. Prefer small modules, pure domain functions, existing local patterns, and conservative changes. Add abstractions only when they remove real complexity. Use succinct comments only for non-obvious blocks.

Use prepared SQL with one statement per `prepare()` and bound untrusted values. Never construct SQL identifiers or clauses from caller input. Use documented integer Unix seconds or ISO text consistently. Use Web-standard `Request`, `Response`, URL, streams, and Web Crypto in deployed code.

## Cryptography and Authentication

- JWTs use ES256 with P-256 through Web Crypto.
- Load the private JWK only from a hosted secret; publish only the derived public JWK.
- Require configured `kid`; never generate a key at runtime startup.
- Include immutable local UUID `sub` and unique `jti`.
- Default access-token lifetime is 600 seconds.
- Validate signature, exact algorithm, `kid`, `iss`, `aud`, `exp`, `iat`, and `nbf` when present. Reject wrong algorithms and unknown keys.
- Omit `email_verified` or set it false unless Sites explicitly documents that assurance.
- Authorization, device, and refresh credentials are cryptographically random. Store only hashes for bearer-equivalent opaque values and confidential client secrets.
- Rotate refresh tokens on every successful use. Reuse revokes the family.
- Access-token consumers require `token_use=access` and a valid `jti`; ID tokens never authorize UserInfo, introspection, storage, or administration. UserInfo also requires the `openid` scope.
- D1 and memory one-time transitions use affected-row-gated compare-and-set operations. Never separate a read-time pending/unused check from the write that consumes an authorization request, authorization code, approved device grant, or refresh token.
- Generated client secrets appear once, are SHA-256 hashed, and are compared without timing-dependent early exit.
- Never log or put access, refresh, device, authorization, client, CSRF, cookie, or signing credentials in URLs or client bundles.

OAuth rules:

- Implement RFC 8628 Device Authorization Grant and Authorization Code with PKCE `S256`; no implicit or resource-owner-password grants.
- Public clients use no secret; confidential clients authenticate.
- Enforce exact registered redirect URI and allowed scope matching.
- Authorization codes are high-entropy, one-time, and short-lived.
- Preserve `state` and OIDC `nonce`.
- Require explicit consent unless remembered consent exactly covers client and scopes.
- Device polling enforces interval, `slow_down`, pending, denied, expired, client binding, and one-time approval. Persist device and user codes only as hashes; reconstruct a short user-code display only from the already-matching same-origin browser submission.
- Use standard OAuth content types and errors. Token success remains protocol-standard.
- Introspection is for authorized confidential clients and active access tokens only. Revocation authenticates the owning client, handles access and refresh tokens even when the hint is omitted or wrong, revokes refresh families, records access-token `jti`, and preserves standard non-disclosure behavior.

Admin operations require trusted ChatGPT sign-in, an allowed local subject or explicitly audited exact-email bootstrap, and the independent deployment key through a header or short-lived subject-bound secure cookie. The key is never sufficient without Sites identity. Support list/create, public/confidential type, display name, exact redirects, scopes, origins, disable, secret rotation, and grant revocation. No unrestricted dynamic registration.

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
- Collection reads use bounded deterministic keyset pages. Continuation cursors use canonical AES-GCM authenticated encryption bound to resource kind, local subject, and client; expose no position or cross-namespace inventory. Signing-key rotation invalidates cursors.

Current-session storage uses the reserved browser client, so it is durable but isolated from every normal OAuth client, even for the same user. Token mode uses the token's client namespace. Submitted and internal tokens never reach HTML, URLs, cookies, logs, or browser storage.

## Browser and Hypermedia Contract

The root is public and returns concise hypermedia JSON or a polished service entry page. It is an operation map, not marketing or a fake demo. Do not add a hero marketing site, pricing, testimonials, blog, dashboard, general account/profile pages, or nonessential navigation. `/session` is a focused protected identity/operations view.

Follow `docs/hypermedia-json-rest-api.md`. An application resource URI has equivalent HTML and JSON representations selected only by `Accept`, never `User-Agent`; `Content-Type` describes submitted input. Do not create separate API/web route trees. The `0.1` preview JSON contract uses `data`, semantic `links`, and currently authorized `actions`, the `application/vnd.aittadb+json; version=0.1` media type, an `application/json` compatibility representation, and the `AittaDB-API-Version` header. Once stable `1.0` is published, breaking contract changes require a new version.

Build one representation-independent resource/operation model and render it as machine controls or semantic HTML. Actions carry stable names, methods, targets, encodings, typed fields, locations, constraints, choices, and current/default values. Use server-supplied concrete targets or declared URI templates; clients must not need hard-coded route construction. Omit controls unavailable for the current identity, scopes, permissions, resource state, or protocol state, while always enforcing authorization server-side. OpenAPI describes all possible versioned operations; hypermedia describes what this caller can do now.

Every application endpoint provides useful HTML when `text/html` is preferred and hypermedia JSON for JSON clients, while OAuth/OIDC discovery, JWKS, authorization, token, revocation, introspection, and UserInfo wire formats remain standards-compliant. Protocol entry resources may advertise their forms without wrapping successful protocol payloads. JSON errors carry semantic recovery controls where valid. Every HTML action executes real production validation and durable state. No mock users, grants, tokens, storage, or browser-only authorization shortcuts.

Browser state-changing forms require same-origin plus CSRF checks. Accept the configured issuer origin behind Sites dispatch; `Origin: null` is allowed only with `Sec-Fetch-Site: same-origin`. Use one validated host-only, secure, `HttpOnly`, `SameSite=Lax` CSRF cookie during its bounded window so concurrent tabs work. Missing, malformed, mismatched, or cross-origin submissions fail closed. Never weaken protocol validation for HTML.

Storage HTML is resource-oriented:

- Collection `GET` renders list and item-navigation controls.
- Item `GET /storage/{kind}/{key}` renders read/download, replace/upload, and delete actions for that URL key only.
- Protected browser actions `POST` to that same resource URL with `_method=GET`, `PUT`, or `DELETE`; reject method/resource mismatches.
- Item keys come only from the URL, never an override field.
- No-JavaScript navigation submits collection `?key=...`; validate it and redirect only to the encoded same-origin item path.
- Do not use one operation selector to mix unrelated resource URLs.
- Render authorized collection state as an accessible list/table or explicit empty state; render item state and outcomes as human-readable fields, never as a JSON dump inside the HTML shell.

`/auth-ui.js` is same-origin progressive enhancement only. It hides/disables inactive authentication and grant fields, links `required` state to visibility, and upgrades item navigation. Initial HTML remains complete and usable without JavaScript; server validation is authoritative. `/auth-ui.css` and the script must remain CSP-compatible and perform no D1 work.

Use semantic HTML, keyboard access, visible focus, meaningful labels, screen-reader compatibility, clear errors, responsive layout, no unnecessary JavaScript, and no third-party runtime fonts, imagery, trackers, or scripts. Follow `docs/style-guide.md`. Keep AittaDB shell selectors scoped so Swagger operations and Schemas controls are not restyled.

Vinext currently imports `image-size` only for build-time image metadata, while all upstream `image-size` releases through `2.0.2` have unpatched denial-of-service advisories. Keep the reviewed `vendor/image-size-compat` package override and its `image-dimensions` delegate until Vinext adopts a patched dependency; verify it with `npm ls image-size`, its focused malformed-container tests, and `npm audit --audit-level=high` before changing or removing it.

Brand contract: self-host Inter with `system-ui, "Segoe UI", sans-serif`; Aitta weight 750 in `#0B234A`, DB weight 750 in `#F04A32`, teal accent `#159CA6`. Use `public/aittadb-mark.svg`, decorative `public/aittadb-boundary.jpg` with empty alt, and `public/og.png`. All pages use the shared shell and GitHub footer unless a protocol/binary constraint prevents it.

## Database and Migrations

D1 schema must explicitly cover local users, clients, redirects, scopes, authorization requests/codes, device grants, refresh families/tokens, consents, revoked access-token IDs where needed, audit events, rate limits, storage records, and file metadata. Rate increments are single-statement atomic. Index expiration, cleanup joins, and pages; bound every cleanup category and retain new empty refresh families through the documented race-prevention grace window.

`db/migrations/` is canonical reviewed SQL. `db/schema.ts` is the required-table manifest. `build/sites-migrations.ts` deterministically emits Sites artifacts and journal under `dist/.openai/drizzle/`; Sites applies them. Runtime handlers never execute `CREATE`, `ALTER`, or `DROP`. This project intentionally uses handwritten migrations, not Drizzle ORM/Kit. Do not reintroduce ORM tooling without a complete architecture task.

Every schema change includes the manifest, checked-in migration, migration tests, architecture/docs, and validation in the same task. Migrations are forward, deterministic, reviewed, and safe for existing data; never rewrite applied history casually.

## OpenAPI

Maintain one OpenAPI 3.1 source in `src/openapi.ts`; serve it at `/openapi.json`. `/docs` is self-hosted Swagger UI using pinned same-origin assets and that canonical document, with no CDN or persisted authorization.

Document every REST and browser method, parameter, body, response, OAuth error, schema, auth requirement, example, content type, Device Grant, and PKCE flow. Clearly separate upstream ChatGPT sign-in from AittaDB credentials. Update implementation and OpenAPI together. `npm run openapi:check` must catch route drift; `npm run swagger:check` must catch vendor drift.

## Configuration, Secrets, Logs

`.env.example` lists names and documentation, never values. Important configuration includes issuer/signing data, token lifetimes, exact client origins, finite storage ceilings/page/rate settings, a storage write switch, administrator subjects, a narrow email bootstrap allowlist, and the independent administrator-key hash. Production fails closed when required secrets are absent. The canonical `ISSUER_URL` is exactly `https://aittadb.com` with no path or trailing slash; issuer changes invalidate the old token boundary and require explicit acceptance notes.

Generate local ES256 and administrator keys only through documented script/Make targets. Secret key files are ignored. Never print/process a generated private or administrator key in agent conversation, commit it, or place it in public hosting metadata. Remove bootstrap email entries after subject enrollment where practical; the independent key remains mandatory because upstream Sites identity has no documented stable subject and email reassignment remains possible.

Redact PII and every credential from logs. Use generic auth errors that do not reveal account existence. Minimal audit events may contain event type, local UUID, client ID, request ID, carefully bounded coarse request metadata, and timestamps. OAuth, identity, storage, and token responses use `Cache-Control: no-store` where sensitive.

Security headers include restrictive CSP, `frame-ancestors 'none'`, no sniffing, referrer policy, permissions policy, and production HTTPS HSTS. Bearer CORS is bound to the token audience's active client and exact origin. Token-endpoint CORS binds the submitted active client before consuming a credential. Never use wildcard credentialed CORS or user-controlled issuer/audience. Stream-enforce bounds and rate-limit OAuth, storage, client-authentication, and administration. See `docs/threat-model.md` and `SECURITY.md`.

## Documentation Set

Maintain `README.md`, `AGENTS.md`, `PLAN.md`, `ROADMAP.md`, `BACKLOG.md`, `LICENSE.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `.env.example`, architecture, style, performance, threat model, deployment, self-hosting limits, OpenAPI, schema/migrations, CLI Device Grant example, browser/native PKCE example, curl examples, key generation/rotation, downstream JWT verification, fork setup, and Sites-specific behavior.

README must prominently state experimental status, independence, the Sites identity-header dependency, separate local identity/credentials, no official ChatGPT OAuth service, self-hosting adapter replacement, and FSL-to-MIT conversion. Keep implementation claims current.

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
- Local administrator key files: `make generate-local-admin-access-key`
- Ephemeral stdout key generation: `npm run keys:generate`

Keep commands synchronized with `package.json`, CI, README, and contributor docs. CI uses lockfile installation and runs format, lint, typecheck, unit/integration tests, OpenAPI, Swagger, migration, AGENTS-size, audit, and production build checks. It never deploys.

## PLAN.md Workflow

Before implementing any repository-affecting user request, first capture it in root `PLAN.md` by adding a new unchecked task or amending the relevant unchecked task. Do this for follow-ups received during work before acting on them; conversational questions that require no repository change need no task. Use one flat list of initially unchecked `TASK-NNN` items with no nesting, phases, epics, or separate implementation/test/doc tasks. Each item is the smallest practical dependency-ordered, focused-commit unit and explicitly includes its contract, implementation, tests, docs, failure paths, configuration/migration/OpenAPI/AGENTS changes, and acceptance evidence.

Process in order unless a discovered dependency is documented. Add missing work as a new unchecked flat item at the correct position before doing it. Mark `[x]` only after the entire definition of done passes. Never mark partial work complete or rewrite completed descriptions; PLAN is audit history.

Parallelize independent reads, validation commands, and non-overlapping implementation work whenever practical. Serialize dependent, overlapping, and security-sensitive edits; use an isolated Git worktree only when it reduces conflict without replacing this canonical checkout.

Prefer the smallest implementation that materially reduces risk and leaves a coherent working repository; do not speculate beyond the requested or evidenced problem. Whenever deciding that a feature, task, deployment, or release is ready, report an evidence-based readiness confidence from `0/100` to `100/100`, name the decisive evidence and material residual uncertainty, and rarely use `100/100`. The score informs judgment but never replaces security gates or the definition of done. Capture every material residual finding in `PLAN.md`, `ROADMAP.md`, or `BACKLOG.md` before handoff.

`ROADMAP.md` lists future product direction as one flat stable `ROADMAP-NNN` checkbox list. `BACKLOG.md` lists uncommitted, unscheduled ideas as one flat stable `BACKLOG-NNN` checkbox list. Neither implies availability or authorizes implementation. Before implementing an item from either file, capture the integrated delivery unit in `PLAN.md`; update its source item only after the PLAN definition of done passes or the idea is explicitly retired with a documented replacement.

Backup, restore, and synchronization designs must remain inside the authenticated user and authorized client namespace. They must exclude AittaDB's OAuth/identity/internal tables, other namespaces, physical R2 keys, environment and binding data, signing keys, secrets, and deployment metadata. Provider capacity is unknown; require bounded, resumable, idempotent, integrity-checked operations with documented conflict, deletion, recovery, quota, and partial-failure semantics before implementation.

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

Use focused commits aligned to completed PLAN items where practical. Inspect a dirty tree and preserve unrelated user work. Never use destructive reset/checkout without explicit instruction. Run relevant checks before commits and `npm run validate` before handoff.

After validation, commit every intended source change, use authenticated GitHub access to push the feature branch, and update/open a draft PR. Otherwise keep the verified commit local and report unavailable write access. Do not leave intended implementation changes unstaged or uncommitted at handoff. Do not merge. Review findings prioritize security, behavioral regressions, protocol divergence, and missing tests.

Production or preview deployment still requires the approval described under Canonical Source. Publish the exact validated committed source, apply checked-in migration artifacts through Sites, preserve D1/R2 bindings and hosted secrets, and verify deployment status. Never claim ChatGPT authentication works end to end unless a real private/public Sites deployment was tested. Record unverified Sites behavior and the exact next manual step.

## Maintaining This File

Update `AGENTS.md` in the same task whenever architecture, interfaces, commands, constraints, security policy, repository structure, deployment procedure, current operational knowledge, or workflow changes. Keep it below 32,000 bytes. Prefer compact normative rules here and deeper explanation in maintained docs; remove stale statements instead of appending contradictions.
