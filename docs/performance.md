# Performance

AittaDB keeps public discovery and static delivery off the database path. Requests for `/`, `/health`, discovery, JWKS, OpenAPI, docs, and `/auth-ui.css` do not issue D1 statements. Static assets bypass application creation and pass directly to Vinext.

Durable routes construct the D1 repository but never apply schema DDL. Independent client redirect, scope, and origin lookups are hydrated concurrently. Expired-row cleanup is non-authoritative and scheduled through `waitUntil` at most once per five-minute Worker instance interval, so a response does not wait for cleanup and correctness never depends on process memory.

Before this boundary was introduced, single live checks on 2026-08-07 measured approximately 3.96 seconds to first byte for `/`, 5.61 seconds for `/health`, and 4.04 seconds for `/auth-ui.css`, while a static SVG returned in 0.07 seconds. The shared cause was sequential schema creation on every dynamic request.

After deployment, first observed dynamic responses measured approximately 1.73 seconds for `/` and 4.11 seconds for `/health`; warm checks measured 0.32 seconds and 0.19 seconds respectively, with `/auth-ui.css` at 0.22 seconds and the static SVG at 0.11 seconds. The final 34-request HTML/JSON route matrix returned warm first-byte times between 0.07 and 0.31 seconds. The unauthenticated method matrix returned expected fail-closed responses between 0.07 and 1.31 seconds. Error-filtered Worker logs contained no exception outcomes; observed entries were expected 4xx acceptance probes, default favicon misses, and client-cancelled file-response events after the signed-in upload/list/download/delete checks completed successfully. These observations are diagnostic evidence, not a latency SLA.

Performance changes must preserve security and durability. Do not cache identity, grants, tokens, consents, client disablement, or storage ownership in process memory, and do not weaken no-store responses, token validation, rate limits, or per-user/per-client query predicates to reduce latency.
