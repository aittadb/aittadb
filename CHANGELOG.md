# Changelog

## 0.1.0

- Initial AittaDB MVP with ChatGPT Sites identity mapping, Device Authorization Grant, Authorization Code with PKCE, OIDC discovery, JWKS, UserInfo, introspection, revocation, D1 migrations, tests, CI, and documentation.
- Added an image-led, page-aware browser interface for service metadata, health, device authorization, consent, administration, and error responses.
- Clarified the upstream boundary as ChatGPT sign-in inside ChatGPT Sites while retaining separate local subjects and AittaDB-issued credentials.
- Renamed the project to AittaDB and introduced its storehouse mark, Inter wordmark, navy/red-orange/teal palette, GitHub organization identity, hypermedia metadata name, and application-storage positioning.
- Updated the React/RSC, Vinext, Vite, Cloudflare, and Wrangler stack to patched compatible versions; removed unused Drizzle Kit and Fontsource tooling; corrected runtime dependency placement; and added enforced dependency-audit and automated update checks.
- Added production-backed browser forms for OAuth/OIDC and D1/R2 storage operations, plus a self-hosted Swagger UI for the canonical OpenAPI document.
- Added current signed-in session modes for UserInfo and isolated record/file storage, backed by a hidden non-administrable browser client and the canonical token validators.
- Hardened storage non-disclosure and cross-user/client isolation, made file downloads attachment-safe, isolated AittaDB shell styles from Swagger UI controls, and added focused regression coverage.
- Removed request-time D1 schema work, packaged reviewed SQL migrations into Sites deployment artifacts, bypassed application startup for static assets, bounded cleanup scheduling, and parallelized client metadata hydration.
- Corrected browser form origin validation for canonical custom domains and Sites same-origin dispatch behavior without allowing arbitrary cross-origin submissions.
- Kept validated host-only CSRF session tokens stable across concurrently open browser forms while retaining malformed-token, mismatch, and same-origin rejection.
- Completed custom-domain acceptance with real ChatGPT Sites identity, OAuth/device-flow coverage, signed-in D1/R2 operations, all-route content negotiation, responsive browser QA, green CI, and improved warm request latency.
- Repositioned public copy around AittaDB's implemented hosted application-backend scope, distinguished durable signed-in storage from temporary browser state, exposed current and planned capabilities in root metadata, and removed sign-in-flow internals from normal user operation maps while preserving their canonical forms and API documentation.
- Made storage browser interfaces resource-oriented: collection URLs list and navigate, item URLs read/download, replace/upload, and delete only their own key, and protected form posts translate to canonical methods on the same URL. Added progressive conditional disclosure for authentication and OAuth grant fields with a complete no-JavaScript fallback.
- Compacted the authoritative `AGENTS.md` while preserving project and security rules, and added a tested local/CI guard requiring it to remain below 32,000 bytes.
- Added the versioned `data`/`links`/`actions` hypermedia JSON contract with same-URI HTML equivalence, session-aware sign-in/sign-out controls, transaction resources, and privacy-preserving aggregate service statistics.
- Added collection-level `POST /storage/files` creation with server-generated logical keys, `201 Created`, and `Location`, while retaining item `PUT` for caller-keyed create/update and strict per-user, per-client isolation.
- Upgraded storage HTML to render collection lists or empty states, readable item details and outcomes, state-aware operations, and an accessible file upload control with drag-and-drop enhancement.
- Made Swagger "Try it out" use the viewer's current origin, and clarified that AittaDB can be independently deployed on ChatGPT Sites with Identity, Data, and Files available now and Events explicitly planned.
- Added a flat, stable-ID roadmap that inventories only missing storage capabilities, decomposes the planned Events subsystem and storage-policy work, and keeps unknown Sites D1/R2 limits explicit without presenting roadmap items as current features.
- Removed deployable mock-identity bindings and runtime branches; production now injects only the documented ChatGPT Sites header provider while tests use an explicit provider located under `tests/`.
- Hardened OAuth state with atomic authorization, device, code, and refresh-token transitions; access-token purpose checks; `openid`-gated UserInfo; client-bound access/refresh revocation with hint fallback; and refresh-family reuse detection.
- Made browser mutation origin checks reject missing headers, bounded complete multipart streams independently of `Content-Length`, and added copy-on-write plus bounded D1/R2 compensation for file failures.
- Replaced Vinext's vulnerable unpatched `image-size` transitive package with a narrow checked-in compatibility adapter backed by `image-dimensions`, retaining a zero-high-severity dependency audit.
- Added an explicitly non-committal backlog for namespace-isolated backup, verified restore, incremental backup, and live synchronization design work, with repository checks that keep it distinct from the implementation plan and product roadmap.
- Added finite deployment, local-user, and local-user/client storage item and byte ceilings; a storage-write kill switch; namespace-only usage reporting; and signed cursor pagination with bounded page sizes.
- Made endpoint and storage rate counters atomic, expanded expiration cleanup into bounded batches, bounded accepted request bodies while streaming, restricted UserInfo/storage CORS to exact active-client origins, rejected disabled clients, and enabled HSTS for production HTTPS responses.
- Hardened administration with immutable local-subject allowlisting, an independently generated access key stored only as a hosted hash, subject-bound 15-minute browser sessions, redacted mutation auditing, and a documented email-bootstrap migration path.
- Removed short Device Grant user-code display values from durable state, scrubbed existing values in migration `0004`, and retained consent display only from the matching same-origin browser submission.
- Extended R2 copy-on-write and D1 metadata compensation around quota rejection and replacement/deletion failures while documenting that simultaneous persistent D1 and R2 failures can still require operator repair.
- Added physical-key compare-and-set file mutations with deterministic concurrent losers, encrypted namespace-bound storage cursors, grace-safe indexed refresh-family cleanup, pre-authenticated multipart parsing, and client-bound token-endpoint CORS before credential consumption.
