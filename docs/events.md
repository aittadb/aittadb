# Persistent Events

Persistent Events is being built as small composable AittaDB server primitives. When `FEATURE_EVENTS_ENABLED=true`, the current release exposes bounded collection reads at `GET /events` and immutable item reads at `GET /events/{id}`; publication and long-poll delivery remain unavailable until their owning tasks land.

## Durable Event Contract

`application_events` stores immutable JSON-object events inside one exact AittaDB principal and OAuth-client namespace. Each row has:

- a random public UUIDv4 identifier;
- an internal increasing sequence used only for repository ordering;
- the owning principal and client identifiers;
- a bounded vendor-neutral event type;
- a JSON object and its exact UTF-8 byte count;
- an optional SHA-256 base64url idempotency-key hash;
- a SHA-256 base64url request fingerprint;
- creation and expiry times.

The optional idempotency value is never stored in plaintext. A namespace can use one hash once; rows without an idempotency hash remain independently insertable. D1 foreign keys require existing principals and clients. A database trigger rejects inserts after account deletion begins, and another trigger rejects every update. Retention and account-deletion workers may delete rows through separately bounded primitives.

The public UUID is not an authorization capability. Every read binds the caller's exact principal and client namespace in its query. Internal sequences must never be returned directly; resumable traversal uses the authenticated opaque cursor described below.

## Validation and Failures

The deployed contract accepts only canonical lowercase UUIDv4 identifiers, nonempty bounded namespace components, event types beginning with an ASCII alphanumeric character and containing only ASCII alphanumeric, dot, underscore, colon, or hyphen characters, JSON objects no larger than 64 KiB, canonical 43-character SHA-256 base64url hashes, and finite ordered timestamps.

Malformed values fail before persistence. D1 constraints repeat the security-relevant bounds so direct repository defects fail closed. Duplicate public IDs, duplicate namespace-bound idempotency hashes, foreign owners, inactive subjects, and attempted updates fail without replacing an existing event. Public status codes and replay/conflict semantics belong to later repository and HTTP tasks.

## Public Collection Read

`GET /events` represents one immutable event collection as versioned hypermedia JSON or accessible HTML according to `Accept`. A bearer request requires `events.read`, a valid access-token purpose and audience, an active client, and an active human or service principal. A request without a bearer token may use only the trusted ChatGPT-signed-in Sites session and AittaDB's reserved browser-client namespace; the short-lived internal adapter token is never returned, rendered, logged, or stored by the browser.

The collection is oldest-first and finite. `EVENTS_DEFAULT_PAGE_SIZE` defaults to 50, `EVENTS_MAX_PAGE_SIZE` defaults to and cannot exceed 100, and each repository read fetches only one extra row to determine `has_more`. One optional `type` parameter performs an exact case-sensitive match inside the prepared D1 query. Unsupported, repeated, malformed, or oversized query values fail rather than being ignored.

Every successful page contains only public event UUID, type, JSON-object data, creation and expiry time, page metadata, and an opaque `resume_cursor`. A `next` link appears only when another current row exists; a `resume` link is always present, including for an empty stream, so later delivery can continue after the returned checkpoint. Internal sequence, principal/client identifiers, request fingerprints, idempotency hashes, aggregate usage, and credentials are never represented. HTML summarizes payload shape rather than dumping event JSON and provides the same filter and page navigation.

The cursor is bound to the exact principal, client, and type filter. It cannot be reused across filters or namespaces and expires after 15 minutes. Responses use `Cache-Control: no-store`. `EVENTS_READ_RATE_LIMIT` defaults to 120 reads per principal/client minute. Cross-origin bearer reads require an exact origin registered on that token's active client; wildcard credentialed CORS is unsupported. The outer Events feature gate runs before bearer, Sites identity, CORS client lookup, rate-limit, cursor, or event-repository work and removes collection controls when disabled.

## Internal Ordered Pages

The internal page repository reads one exact principal/client namespace in increasing sequence order. Callers may start at the beginning or continue strictly after one validated sequence. Each call accepts a finite limit no larger than 100, asks D1 for only `limit + 1` rows, returns no more than the requested limit, and reports only whether another page exists. Empty namespaces return an empty final page.

Repository consumers must not serialize the internal sequence. The public collection translates it through the namespace-bound cursor primitive. Exact type filtering happens in the bounded prepared query and uses `idx_application_events_owner_type_sequence`; it is never an in-memory post-filter. Malformed page positions, types, and limits fail before D1, and a repository row that violates the durable contract fails closed instead of being partially returned.

## Opaque Resume Cursors

`src/application-event-cursor.ts` seals one internal resume checkpoint with AES-256-GCM. The encrypted version-1 payload contains only the last event sequence and an expiry. Sequence zero is the explicit empty-stream checkpoint, so an empty read can still provide a safe position from which a later event is strictly newer. Random 96-bit IVs make two cursors for the same checkpoint different while decoding both to the same deterministic `afterSequence` value.

The initial lifetime is exactly 15 minutes. Issuance accepts only a nonnegative safe-integer sequence and time. Opening requires an unexpired safe-integer expiry no later than 15 minutes from the opening time; expiry is exclusive, so a cursor is invalid at its expiry second. A client with an expired or otherwise invalid cursor must restart from the Events collection entry point. Cursor state is not stored in D1 or process memory.

The key is domain-separated from storage cursors and derived from the configured private signing-key material. AES-GCM additional authenticated data binds the fixed Events resource, exact issuer, signing key ID, principal, OAuth client, and exact event-type filter without putting those values in the token. A cursor therefore cannot cross a resource, deployment boundary, principal, client, or filtered collection. Changing the signing key material or key ID immediately invalidates it.

Opening accepts only bounded canonical unpadded base64url, strict UTF-8, the exact versioned canonical JSON shape, safe integers, and the bounded lifetime. Truncation, tampering, unsupported versions, reordered or extra fields, malformed context, and all binding failures return one internal `null` result. The HTTP collection maps every rejected cursor to one non-disclosing `invalid_request`; no error contains plaintext cursor state, identity, client, filter, or signing material.

## Internal Point Lookup

Point lookup requires the exact principal, client, and canonical public UUID in one prepared query. A matching row is returned as a validated defensive value. An absent UUID and an event owned by another principal or client all return the same `null` result, so the repository does not reveal whether another namespace contains that identifier. Malformed namespace values or identifiers fail before D1 access, and malformed persisted rows fail closed.

## Immutable Item Read

With `FEATURE_EVENTS_ENABLED=true`, `GET /events/{id}` returns one unexpired event from the authenticated principal and OAuth-client namespace. Bearer requests require a short-lived AittaDB access token with `events.read`, an exact active token audience client, and an active human or service principal. A signed-in request without a bearer token uses the same canonical operation through the reserved current-session client; no internal token is rendered, persisted, or returned.

The identifier must be a canonical lowercase UUIDv4. Malformed, absent, expired, other-user, and other-client identifiers produce the same generic `404` representation. Successful JSON exposes only `id`, `event_type`, the event's JSON object, `created_at`, and `expires_at`; it omits sequence, ownership, request hashes, and idempotency state. HTML renders those same fields accessibly. Both representations link to the future collection URI and advertise no mutation. Exact client-origin CORS, request and rate bounds, `Cache-Control: no-store`, and the outer Events gate apply before repository disclosure.

The collection link defines the resource relationship but does not make `GET /events`, event publication, deletion, update, or long-poll delivery available in this preview.

## Internal Idempotent Append

Append validates the complete persistence input and finite limits, then attempts one conditional D1 `INSERT ... RETURNING` without a preliminary read. Admission requires an existing principal, an existing enabled client, no account-deletion job, and available deployment, local-user, and local-user/client item and payload-byte capacity. A successful insert returns `created` with the immutable row selected by that same statement. The memory adapter performs the same checks without yielding between its decision and insertion.

When that insert does not win and an idempotency hash was supplied, one namespace- and active-owner-bound read compares the stored request fingerprint before admission is classified. An exact fingerprint returns `replayed` with the original event even when the namespace is full, and another fingerprint returns `conflict`; neither consumes capacity twice. An active new append that exceeds any configured ceiling returns `quota_exceeded`. No idempotency value with a colliding public UUID, missing ownership, a disabled client, or an inactive subject returns `unavailable`. Unexpected repository and classification failures are not reclassified as quota, ownership, or conflict outcomes.

Only exact UTF-8 `data_json` bytes count toward byte ceilings; row and index overhead remains provider-managed and is not advertised as capacity. Defaults are 10,000 events and 256 MiB deployment-wide, 1,000 events and 32 MiB per local user, and 500 events and 16 MiB per user/client namespace. Operators may lower the six `EVENTS_*_MAX_ITEMS` and `EVENTS_*_MAX_BYTES` settings. Raising a limit is an explicit capacity decision, not a claim about ChatGPT Sites quotas. Reads and bounded cleanup remain available after publication reaches a ceiling; remove expired or acceptance-fixture events through approved bounded cleanup before raising limits.

Both adapters return defensive event values and retain only the supplied SHA-256 base64url idempotency hash, never the original key. Quota outcomes expose no deployment-wide, other-user, or other-client usage.

## Retention and Bounded Cleanup

`EVENT_RETENTION_SECONDS` defines the lifetime assigned to newly published events. It defaults to seven days (`604800`) and accepts an integer from 1 second through one year (`31536000`). Event creation must derive `expires_at` from the server clock and this setting; callers cannot select a longer lifetime. Migration `0015_application_event_retention.sql` repeats the one-year hard bound for direct D1 inserts. Changing the setting affects only later events because each immutable row keeps its original expiry.

Ordinary durable requests may schedule the shared maintenance pass through `waitUntil` at most once per Worker instance minute. One pass deletes no more than 500 eligible application events, ordered by `expires_at` and then internal sequence through `idx_application_events_expires_sequence`. It never scans or deletes an unexpired row. Repeated passes safely advance a backlog; expiry makes a row eligible but does not promise immediate removal when traffic or `waitUntil` execution is absent.

The cleanup report and optional private telemetry expose only the fixed `application-events` category, a verified aggregate deleted count or `null`, and the fixed batch limit. They never contain an event identifier, type, payload, owner, client, cursor, SQL text, or exception. Failures emit only `maintenance.cleanup.failed`. There is no public cleanup or retention-administration endpoint.

## Account Deletion

Starting self-service deletion immediately makes the human subject inactive for event append, including requests that reached the repository after an earlier authorization check. The internal account-deletion coordinator then removes no more than 100 events per pass across that subject's client namespaces. Each pass requires the exact current attempt and unexpired lease, uses deterministic client/sequence order, and treats committed absence as its resume position.

The purge cannot target a service principal or another human subject. D1 and memory finalization both require zero events for the deleting subject, and migration `0016_account_deletion_events.sql` adds an independent terminal-state guard for the same condition. Partial batches and failures leave the account retryable; no event identifier, type, payload, owner, client, sequence, or cursor reaches coordinator telemetry. After completion, a later sign-in with the same email receives a new UUID and an empty event namespace.
