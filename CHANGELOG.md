# Changelog

## 0.1.0

- Initial MVP implementation of Sites Auth Broker with Device Authorization Grant, Authorization Code with PKCE, OIDC discovery, JWKS, UserInfo, introspection, revocation, D1 migrations, tests, CI, and documentation.
- Added an image-led, page-aware browser interface for service metadata, health, device authorization, consent, administration, and error responses.
- Clarified the upstream boundary as ChatGPT sign-in inside ChatGPT Sites while retaining separate local subjects and broker-issued tokens.
- Renamed the project to AittaDB and introduced its storehouse mark, Inter wordmark, navy/red-orange/teal palette, GitHub organization identity, hypermedia metadata name, and application-storage positioning.
- Updated the React/RSC, Vinext, Vite, Cloudflare, and Wrangler stack to patched compatible versions; removed unused Drizzle Kit and Fontsource tooling; corrected runtime dependency placement; and added enforced dependency-audit and automated update checks.
- Added production-backed browser forms for OAuth/OIDC and D1/R2 storage operations, plus a self-hosted Swagger UI for the canonical OpenAPI document.
- Added current signed-in session modes for UserInfo and isolated record/file storage, backed by a hidden non-administrable browser client and the canonical token validators.
- Hardened storage non-disclosure and cross-user/client isolation, made file downloads attachment-safe, isolated AittaDB shell styles from Swagger UI controls, and added focused regression coverage.
- Removed request-time D1 schema work, packaged reviewed SQL migrations into Sites deployment artifacts, bypassed application startup for static assets, bounded cleanup scheduling, and parallelized client metadata hydration.
- Corrected browser form origin validation for canonical custom domains and Sites same-origin dispatch behavior without allowing arbitrary cross-origin submissions.
- Kept validated host-only CSRF session tokens stable across concurrently open browser forms while retaining malformed-token, mismatch, and same-origin rejection.
- Completed custom-domain acceptance with real ChatGPT Sites identity, OAuth/device-flow coverage, signed-in D1/R2 operations, all-route content negotiation, responsive browser QA, green CI, and improved warm request latency.
