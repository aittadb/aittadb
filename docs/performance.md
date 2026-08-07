# Performance

AittaDB keeps public discovery and static delivery off the database path. Requests for `/`, `/health`, discovery, JWKS, OpenAPI, docs, and `/auth-ui.css` do not issue D1 statements. Static assets bypass application creation and pass directly to Vinext.

Durable routes construct the D1 repository but never apply schema DDL. Independent client redirect, scope, and origin lookups are hydrated concurrently. Expired-row cleanup is non-authoritative and scheduled through `waitUntil` at most once per five-minute Worker instance interval, so a response does not wait for cleanup and correctness never depends on process memory.

Before this boundary was introduced, single live checks on 2026-08-07 measured approximately 3.96 seconds to first byte for `/`, 5.61 seconds for `/health`, and 4.04 seconds for `/auth-ui.css`, while a static SVG returned in 0.07 seconds. The shared cause was sequential schema creation on every dynamic request. Final deployment acceptance must record comparable warm and cold measurements after deployment, inspect Worker errors, and verify that public responses perform no D1 work. These observations are diagnostic evidence, not a latency SLA.

Performance changes must preserve security and durability. Do not cache identity, grants, tokens, consents, client disablement, or storage ownership in process memory, and do not weaken no-store responses, token validation, rate limits, or per-user/per-client query predicates to reduce latency.
