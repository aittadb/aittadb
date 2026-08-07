# Architecture

Sites Auth Broker runs as a Sites-compatible Vinext project with a Cloudflare Worker-compatible Fetch router in `src/handler.ts`. Vinext remains the build wrapper; broker endpoints are protocol-first Fetch handlers.

System units:

- `src/identity.ts`: trusted ChatGPT Sites header parsing and test-only identity adapter.
- `src/oauth.ts`: OAuth/OIDC domain behavior.
- `src/crypto.ts`: Web Crypto random values, hashes, PKCE, ES256 JWTs, and JWKS.
- `src/store/d1.ts`: D1 repository implementation.
- `src/store/memory.ts`: test-only repository implementation.
- `src/handler.ts`: HTTP route handling, CORS, CSRF, and minimal browser flows.
- `src/openapi.ts`: canonical OpenAPI source served by `/openapi.json`.

The service stores only local state in D1. It never stores or forwards ChatGPT credentials. Downstream `sub` values are locally generated immutable UUIDs.
