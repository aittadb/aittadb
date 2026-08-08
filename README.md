# AittaDB

<img src="public/aittadb-mark.svg" width="96" height="96" alt="AittaDB logo">

[GitHub repository](https://github.com/aittadb/aittadb)

**A source-available application backend that developers can deploy entirely on OpenAI-hosted ChatGPT Sites.**

AittaDB currently provides identity, authentication, persistent JSON data, and object storage through a self-contained ChatGPT Sites deployment. Its current implementation depends on OpenAI-hosted ChatGPT Sites for runtime, ChatGPT sign-in, D1, R2, configuration, and secrets. Developers can deploy their own separate AittaDB instance and use it as a shared backend for third-party applications, services, and agents without maintaining separate application servers, database servers, object-storage services, or authentication infrastructure.

> **Experimental:** AittaDB is under active development. Its interfaces and operational requirements may change before a stable release.

AittaDB is not affiliated with or endorsed by OpenAI. It does not expose an official "Sign in with ChatGPT" OAuth service, and tokens issued by this project are not OpenAI or ChatGPT tokens. ChatGPT sign-in works only through a compatible Sites environment that supplies authenticated identity headers to server-side code.

The service creates its own user record with an immutable UUID subject. The upstream email address is used only to locate or create that AittaDB user. ChatGPT Sites does not currently document a stable upstream subject, so an email change can create a new AittaDB identity and a reassigned address can inherit the existing identity and namespace. This remains a risk for ordinary users and administrators: putting that local UUID in `ADMIN_SUBJECTS` does not change how it is located. Self-hosting outside Sites requires replacing the upstream Sites identity adapter.

## Licensing

Current public releases are source-available under FSL-1.1-MIT. Each released version converts to the MIT License two years after publication. An MIT license for immediate use of a current release is also available commercially from the maintainer; contact [@thejhh](https://github.com/thejhh) for terms.

Because a current public release remains under FSL until its conversion date, describe that release as **source-available**, not open source. A version already converted to MIT, or licensed directly under MIT, is open-source software under the MIT License.

## Built for ChatGPT Sites

AittaDB's current implementation is designed to be deployed as an application on [ChatGPT Sites](https://learn.chatgpt.com/docs/sites), an OpenAI-hosted platform. It depends on these Sites capabilities:

- Managed application hosting and runtime.
- ChatGPT sign-in supplied inside the Sites trust boundary.
- D1 storage for persistent structured data.
- R2 object storage for files and other binary data.
- Hosted environment configuration and secrets.

Because these capabilities are provided by ChatGPT Sites, a core AittaDB deployment does not need infrastructure outside Sites. Each deployment has its own issuer, signing keys, D1 database, R2 bucket, configuration, and users. Once deployed, it can act as a shared backend for other websites, ChatGPT Sites, services, native applications, command-line tools, and AI agents through its HTTP APIs.

### Public-Beta Limits

As of August 8, 2026, ChatGPT Sites usage and storage are included up to plan-specific public-beta limits. **Persistent D1 database and R2 object storage are provided by ChatGPT Sites, subject to the plan-specific aggregate limits displayed in ChatGPT during the public beta.** These limits apply across all Sites on the account, may change, and can vary for Enterprise and Edu workspaces. The Sites experience displays the current limits and warns as the account approaches them. Reaching a limit may prevent adding storage, creating another Site, or keeping a high-usage Site publicly available until usage is reduced. See [Creating and managing ChatGPT Sites](https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites).

OpenAI currently publishes no fixed numerical figures for Sites D1/R2 capacity or allocation, object size, rows or queries, bandwidth or operations, or additional pricing. Do not plan or advertise a fixed AittaDB capacity from undocumented assumptions. The Pro plan's 100 GB [ChatGPT Library](https://help.openai.com/en/articles/20001052-library-for-chatgpt) quota applies to files saved in ChatGPT Library and is unrelated to Sites D1/R2 storage.

AittaDB separately enforces finite application-level ceilings for the deployment, each local user, and each local-user/OAuth-client namespace. These are abuse controls, not statements about Sites capacity, and the provider can impose a lower or shared limit first.

## What AittaDB Provides

- ChatGPT-based upstream user identity mapped to a separate local AittaDB user.
- OAuth 2.0 and OpenID Connect sessions for third-party applications.
- Persistent structured application data.
- Object and file storage.
- HTTP APIs for applications, services, and AI agents.
- Persistent events and long-polling delivery as a planned capability, not part of the current MVP.

The goal is to let developers build persistent, authenticated applications without first deploying and maintaining a conventional backend stack.

The browser interface summarizes this product direction as **Identity / Data / Files / Events**. Identity, data, and files are available in the MVP; Events remains an explicitly planned capability. [PLAN.md](PLAN.md) contains accepted unfinished work, while completed task history moves to [CHANGELOG.md](CHANGELOG.md). See [ROADMAP.md](ROADMAP.md) for product direction and [BACKLOG.md](BACKLOG.md) for unscheduled ideas such as backup and live synchronization. Unchecked items are not current features or release commitments.

## Why AittaDB?

In Finnish, an _aitta_ is a traditional detached storehouse on a farmstead. It was built to keep grain, food, tools, and other valuable supplies safe and available.

AittaDB follows the same idea for software: a dependable place for an application's identity, data, and files today, with persistent events planned.

## MVP Capabilities

- OAuth 2.0 Device Authorization Grant for CLIs.
- OAuth 2.0 Authorization Code with PKCE for browser and native clients.
- Minimal OpenID Connect issuer discovery, JWKS, ID tokens, UserInfo, introspection, and revocation.
- ES256 JWT signing through Web Crypto with a configured private JWK.
- Opaque hashed refresh tokens with rotation and reuse detection.
- D1-backed durable state with checked-in migrations.
- Per-user, per-client application storage: JSON records in D1 and file bytes in R2.
- Finite storage ceilings, bounded cursor pagination, atomic rate counters, and a deployment storage-write kill switch.
- ChatGPT-sign-in-protected browser operations for current-session UserInfo, personal record/file storage, device approval, consent, and client administration.
- Administrator access limited to signed-in local UUID subjects configured in `ADMIN_SUBJECTS`.

## Local Setup

```sh
npm ci
cp .env.example .env
make generate-local-jwt-key
npm run validate
```

`make generate-local-jwt-key` writes the generated key to `.secrets/jwt-signing-key.json`, which is ignored by Git. Put generated key values into local environment variables or Sites secrets without committing real key material.

`npm run validate` includes a high-severity dependency audit, OpenAPI validation, self-hosted Swagger UI asset verification, handwritten D1 migration consistency, the root `AGENTS.md` instruction-budget check, tests, and the production build. `AGENTS.md` must remain below 32,000 bytes so Codex loads its complete authoritative contract by default. D1 migrations are maintained as reviewed SQL and packaged into the Sites deployment artifact during the build; request handlers never run schema DDL. The project intentionally has no incomplete ORM generation command.

## Required Configuration

- `ISSUER_URL`: exact public issuer URL.
- `JWT_KEY_ID`: configured signing key ID.
- `JWT_PRIVATE_JWK`: ES256 P-256 private JWK JSON.
- `ADMIN_SUBJECTS`: comma-separated canonical local UUIDv4 subjects for administrators. Sign in at `/session`, read the deployment-local AittaDB subject, and add it through Sites configuration. Only a current trusted Sites session mapped to an entry can use administration. An empty list disables administration, and UUID allowlisting does not eliminate upstream email-reassignment risk.
- `PRIVACY_CONTROLLER_*` / `PRIVACY_CONTACT_*`: optional public operator and contact details for `/privacy`. Explicit values take precedence; missing required details fall back to only the stored email and optional display name of the first resolvable `ADMIN_SUBJECTS` user. No UUID, allowlist, or private configuration is published. A generic `503` is returned when neither source resolves a usable controller and contact.
- `FEATURE_RECORDS_ENABLED`, `FEATURE_FILES_ENABLED`, `FEATURE_STATISTICS_ENABLED`, and `FEATURE_OAUTH_APPS_ENABLED`: strict per-feature booleans. Records, Files, and Statistics default on; downstream OAuth Apps default off. The effective state is visible in the service HTML and versioned hypermedia metadata, without exposing raw environment configuration.
- `STORAGE_WRITES_ENABLED`: deployment storage-write kill switch; disabling it leaves authorized reads and deletes available.
- `STORAGE_GLOBAL_MAX_ITEMS` / `STORAGE_GLOBAL_MAX_BYTES`: combined record-and-file ceiling for the deployment; defaults to 10,000 items and 1 GiB.
- `STORAGE_USER_MAX_ITEMS` / `STORAGE_USER_MAX_BYTES`: combined ceiling across one local user's client namespaces; defaults to 1,000 items and 100 MiB.
- `STORAGE_NAMESPACE_MAX_ITEMS` / `STORAGE_NAMESPACE_MAX_BYTES`: combined ceiling for one local user and OAuth client; defaults to 500 items and 50 MiB.
- `STORAGE_DEFAULT_PAGE_SIZE` / `STORAGE_MAX_PAGE_SIZE`: collection-page bounds; defaults to 50 and 100.
- `STORAGE_READ_RATE_LIMIT` / `STORAGE_WRITE_RATE_LIMIT`: per-user/client storage limits per minute; defaults to 120 and 30.
- D1 binding named `DB`.
- R2 binding named `BUCKET` for `/storage/files/*`.

## API Endpoints

- `GET /health`
- `GET /statistics`
- `GET /session`
- `GET /privacy`
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
- `POST /storage/files`
- `PUT /storage/files/{key}`
- `GET /storage/files/{key}`
- `DELETE /storage/files/{key}`
- `GET /openapi.json`
- `GET /docs`

The public service root does not require authentication because service discovery and OAuth initiation must work before sign-in. Its operation map uses the trusted server-side ChatGPT sign-in signal supplied by Sites: it offers sign-in when no identity is present and sign-out when the caller is already signed in. These controls enter the real Sites-owned sign-in or sign-out routes, not a demo. Sign-in-flow internals such as authorization, consent, token exchange, revocation, and introspection remain available at their canonical URLs and through the API docs, but are not promoted as normal user operations. `/session` starts Sites-owned ChatGPT sign-in when needed and then shows the immutable local AittaDB subject created for the signed-in user. That sign-in can use its own durable AittaDB namespace, but it does not grant any third-party OAuth client a scope or access to that namespace.

Application resources use content negotiation on the same URI. `Accept: text/html` selects a useful human interface; `Accept: application/vnd.aittadb+json; version=0.1` selects the versioned hypermedia contract, and `application/json` remains a compatibility representation. Hypermedia documents contain resource `data`, semantic `links`, and currently available `actions`, and report their contract in `AittaDB-API-Version`. Application errors include the same machine-readable structure and valid recovery controls where protocol compatibility allows. The HTML links, forms, lists, details, and errors expose equivalent authorized capabilities and invoke the same identity, OAuth/OIDC, D1, and R2 logic. The server never selects a representation from `User-Agent`. Version `0.1` remains a development preview; after a stable version is published, breaking contract changes require a new version. OAuth/OIDC responses retain their standards-defined wire formats where wrapping would break interoperability. See [the hypermedia architecture](docs/hypermedia-json-rest-api.md).

At `/admin/clients`, an allowlisted signed-in administrator receives the same create, enable/disable, confidential-secret rotation, and grant-revocation capabilities in HTML and hypermedia JSON. Controls disappear when the client state or type makes them invalid, and the server independently rejects attempts to invoke an omitted operation. Each mutation consumes an atomically claimed one-time submission hash. JSON returns the no-store result directly; HTML redirects to a safe GET and carries the result in a short-lived encrypted, `HttpOnly` cookie, so refresh cannot repeat the POST. A generated confidential secret is identified with its client, never put in a URL or durable plaintext storage, and disappears after that immediate result.

`/docs` is a self-hosted Swagger UI backed directly by the canonical `/openapi.json`. Its assets are pinned and served from AittaDB without a CDN. "Try it out" sends requests to the origin serving the viewer, so a custom-domain deployment does not accidentally call a legacy hostname embedded in an older specification. Browser forms are also available directly on the authorization, device authorization, token, revocation, introspection, and UserInfo routes; state-changing browser submissions are same-origin and CSRF protected, and credential values are never placed in URLs.

The `/userinfo`, `/storage/records`, and `/storage/files` browser views default to the current signed-in session when one exists. They create only a minimal short-lived internal access token, pass it directly to the canonical UserInfo or storage validator, and never expose or retain it. An explicit AittaDB bearer-token mode remains available for testing a registered application's client-scoped data. Inactive token and OAuth grant fields are hidden and disabled by progressive enhancement; without JavaScript, every field remains visible and server validation remains authoritative. Storage collection pages render a useful list or empty state. The file collection also provides an accessible native upload control with drag-and-drop enhancement. Item pages render readable metadata and the actions valid for that exact URL instead of dumping JSON into the HTML shell.

The browser UI uses a shared responsive AittaDB shell with page-aware trust-boundary copy, the same-origin `aittadb-boundary.jpg` artwork, the supplied `aittadb-mark.svg` storehouse mark, and an AittaDB-specific `og.png` social card. Inter is self-hosted from `/fonts/inter-latin-wght-normal.woff2`, with `system-ui`, `Segoe UI`, and `sans-serif` fallbacks. Styles come from `/auth-ui.css`; one minimal same-origin `/auth-ui.js` script provides conditional fields and canonical item navigation. The UI loads no third-party runtime fonts, images, scripts, or tracking code.

## Application Storage

Client applications may request `storage.read`, `storage.write`, and `storage.delete` AittaDB scopes. These scopes authorize storage only inside AittaDB. They do not grant access to ChatGPT, OpenAI, conversations, files, Projects, connectors, subscriptions, billing, or API quota.

Storage is isolated by the immutable AittaDB user UUID and OAuth client ID. JSON records are stored in D1 at `/storage/records/{key}`. File metadata is stored in D1 and file bytes are stored in R2. `POST /storage/files` creates a file with a server-generated logical key and returns `201 Created` with its item URI in `Location`; `PUT /storage/files/{key}` creates or replaces the file at a caller-selected logical key. Caller-provided keys are logical metadata only; AittaDB always generates physical R2 object keys.

Record and file creates or replacements use one conditional D1 write to enforce the configured deployment, user, and user/client item-and-byte ceilings. A rejected write returns `507 storage_limit_exceeded`; disabling writes returns `503 storage_writes_disabled`. File writes use copy-on-write R2 keys and bounded compensation when quota or metadata persistence fails. D1 and R2 do not share a transaction, so simultaneous persistent failures can still require private operator repair.

Storage collections use deterministic encrypted-cursor pagination. `page_size` defaults to 50 and cannot exceed the configured maximum, initially 100. Follow the returned `next` link instead of constructing or reusing a cursor: authenticated encryption binds each cursor to the resource kind, local user, and OAuth client without exposing its logical key, timestamp, namespace identifiers, or signing secrets. Rotating the private signing-key material immediately invalidates outstanding cursors; clients restart from the collection URI. Collection responses disclose only the combined record-and-file usage and namespace ceiling for the authenticated user/client namespace. They never disclose deployment-wide usage, another user, or another client namespace.

The signed-in browser uses a reserved, hidden AittaDB client ID, so the user's durable signed-in AittaDB namespace remains separate even from an OAuth client belonging to the same local user. That reserved client cannot be selected by device authorization, Authorization Code, token exchange, or administrator operations. AittaDB exposes no generic SQL, internal-table, physical R2-key, environment, binding, or deployment-secret API.

`GET /statistics` is public and returns only the aggregate count of local AittaDB identities in this deployment. It exposes no email address, display name, local subject, client ownership, or other personal or internal data.

## Privacy

Each AittaDB deployment operator is the controller for personal data collected by that published deployment. `GET /privacy` serves the deployment's notice as accessible HTML or versioned hypermedia JSON through normal content negotiation. Operators must review the notice, applicable law, configured clients, retention, and public contact details before publishing. See the [baseline Privacy Policy](docs/privacy.md) and [deployment configuration](docs/deployment.md#privacy-notice-configuration).

OpenAI hosts ChatGPT Sites and processes personal data collected by a published Site ("Hosted Data") under the applicable [ChatGPT Sites Data Processing Addendum](https://openai.com/policies/chatgpt-sites-data-processing-addendum/) or organization agreement. AittaDB makes no fixed data-residency promise; the Sites documentation currently states that deployed Sites, D1/R2 storage, artifacts, and logs do not support data residency at launch.

## ChatGPT Sites Sign-In Boundary

ChatGPT sign-in is supplied inside ChatGPT Sites through Sites-owned `/signin-with-chatgpt` and `/signout-with-chatgpt` routes. This service reads only server-side `oai-authenticated-user-email`, optional `oai-authenticated-user-full-name`, and the full-name encoding header. It never forwards or exposes ChatGPT cookies, credentials, sessions, or tokens.

Short Device Grant user codes are returned to the requesting client as required by RFC 8628, but only their hashes are persisted. The browser reconstructs the display value from the matching same-origin submission, and migration `0004_security_indexes.sql` scrubs legacy display values. The application does not add device or user codes to audit events.

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
- Review the planned, not-yet-implemented work in [ROADMAP.md](ROADMAP.md).
- Review unscheduled, uncommitted implementation ideas in [BACKLOG.md](BACKLOG.md).
- Read each repository's documentation.
- Use [GitHub Issues](https://github.com/aittadb/aittadb/issues) for bug reports and feature proposals.
- Read the [ChatGPT Sites documentation](https://learn.chatgpt.com/docs/sites).
- Review the deployment's `/privacy` resource and the [baseline Privacy Policy](docs/privacy.md).
- Visit the founder's GitHub profile: [@thejhh](https://github.com/thejhh).

## Fun Fact

The name combines _aitta_ with _DB_: a traditional farm storehouse reimagined as hosted application infrastructure.
