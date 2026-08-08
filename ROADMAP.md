# AittaDB Roadmap

Every item below is planned future work, not a current AittaDB capability or release commitment. Stable `ROADMAP-NNN` identifiers must not be renumbered or reused. `PLAN.md` tracks auditable implementation work; this file records product direction.

The current source inventory already includes record collection `GET`, record item `GET`/`PUT`/`DELETE`, file collection `GET`/`POST`, file item `GET`/`PUT`/`DELETE`, and file metadata retrieval through JSON content negotiation. Those operations are not repeated below. Persistent Events has no current API or persistence contract.

ChatGPT Sites D1/R2 capacity remains subject to unknown plan-specific aggregate public-beta limits displayed in ChatGPT. Roadmap quota and policy work must use explicit AittaDB-configured ceilings, must not claim to reveal or increase provider capacity, and must fail safely when the platform limit is reached.

- [ ] ROADMAP-001: Add record collection creation with `POST /storage/records`, a server-generated logical key, `201 Created`, `Location`, equivalent HTML and hypermedia controls, and the existing user/client isolation boundary.
- [ ] ROADMAP-002: Add atomic partial JSON record updates at `PATCH /storage/records/{key}` with one documented patch media type, validation, failure semantics, HTML equivalence, and scoped authorization.
- [ ] ROADMAP-003: Add previous-page recovery and explicitly supported key or update-time filters to the existing bounded record pagination without exposing owner/client columns or internal query structure.
- [ ] ROADMAP-004: Add record entity tags and conditional reads/writes so clients can detect stale state and prevent lost updates without weakening authorization.
- [ ] ROADMAP-005: Add file metadata mutation at `PATCH /storage/files/{key}` for a narrowly defined set of public metadata without replacing bytes or exposing the physical R2 key.
- [ ] ROADMAP-006: Add previous-page recovery and explicitly supported logical-key, content-type, or update-time filters to the existing bounded file pagination without exposing R2 internals.
- [ ] ROADMAP-007: Add file entity tags and conditional reads/writes so clients can validate cached metadata and prevent lost byte or metadata updates.
- [ ] ROADMAP-008: Add authorized HTTP byte-range retrieval for files with correct range validation, content headers, and unchanged user/client isolation.
- [ ] ROADMAP-009: Define and migrate durable D1 event persistence with immutable event IDs, ordered timestamps, payload bounds, idempotency rules, and user/client ownership keys.
- [ ] ROADMAP-010: Add scoped event publication with versioned hypermedia and HTML contracts, durable writes, idempotency behavior, request limits, and no implicit cross-client fan-out.
- [ ] ROADMAP-011: Add bounded event collection and item retrieval with deterministic ordering, filtering rules, and no access outside the authenticated user/client namespace.
- [ ] ROADMAP-012: Add long-poll event delivery with bounded wait duration, cancellation handling, rate limits, Worker-compatible execution, and ordinary polling fallback.
- [ ] ROADMAP-013: Add opaque event cursors with stable resume semantics, expiry behavior, malformed-cursor rejection, and no embedded identity or deployment secrets.
- [ ] ROADMAP-014: Add configurable event retention and bounded cleanup with documented deletion guarantees, safe defaults, and no long background jobs.
- [ ] ROADMAP-015: Add event authorization scopes and policy enforcement for publish, read, and subscribe operations, including negative cross-user and cross-client paths.
- [ ] ROADMAP-016: Add allowlisted-administrator storage ACL and policy management without granting generic D1/R2 access or bypassing immutable user/client namespace isolation.
- [ ] ROADMAP-017: Add configurable per-user storage quotas aggregated safely across that user's client namespaces without revealing one client's contents to another.
- [ ] ROADMAP-018: Add configurable per-client storage quotas that remain independent for each user/client namespace and cannot target AittaDB's internal clients or tables.
- [ ] ROADMAP-019: Add configurable record-count ceilings with transaction-safe accounting for create, replace, and delete behavior.
- [ ] ROADMAP-020: Add configurable file-count ceilings with D1/R2 consistency handling for create, replace, and delete behavior.
- [ ] ROADMAP-021: Add configurable aggregate record-byte ceilings while retaining the existing per-record request bound and defining exact JSON size accounting.
- [ ] ROADMAP-022: Add configurable aggregate file-byte ceilings while retaining the existing per-file request bound and handling failed or interrupted R2/D1 writes safely.
- [ ] ROADMAP-023: Add administrator-configured file content-type allow/deny policy based on verified request metadata, with safe defaults and generic rejection responses.
- [ ] ROADMAP-024: Add optional administrator-configured JSON Schema validation for record namespaces with schema versioning, bounded evaluation, and actionable validation errors.
- [ ] ROADMAP-025: Add privacy-preserving usage visibility for users, clients, and allowlisted administrators, showing only authorized counts, bytes, configured ceilings, and coarse enforcement state.
- [ ] ROADMAP-026: Define consistent quota and policy enforcement behavior, including atomic reservation where possible, rollback/repair paths, standard status and error bodies, `Retry-After` where meaningful, and equivalent hypermedia/HTML recovery controls.
- [ ] ROADMAP-027: Add safe storage-policy migration with dry-run impact reporting, versioned policy records, rollback strategy, existing-data handling, and fail-closed behavior during partial rollout.
- [ ] ROADMAP-028: Integrate Sites-provided limit visibility only if OpenAI publishes a supported runtime interface; until then, keep provider capacity explicitly unknown and distinguish AittaDB policy usage from Sites account-wide limits.
- [ ] ROADMAP-029: Stabilize and publish the first non-preview hypermedia media-type version after route parity, compatibility, security, and deployed interoperability evidence are complete.
