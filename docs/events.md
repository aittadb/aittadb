# Persistent Events

Persistent Events is being built as a small AittaDB server primitive. The current internal persistence contract does not expose an HTTP route and does not make Events available to applications yet.

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

The public UUID is not an authorization capability. Future reads must bind the caller's exact principal and client namespace in every query. Internal sequences must never be returned directly; resumable traversal uses the authenticated opaque cursor described below.

## Validation and Failures

The deployed contract accepts only canonical lowercase UUIDv4 identifiers, nonempty bounded namespace components, event types beginning with an ASCII alphanumeric character and containing only ASCII alphanumeric, dot, underscore, colon, or hyphen characters, JSON objects no larger than 64 KiB, canonical 43-character SHA-256 base64url hashes, and finite ordered timestamps.

Malformed values fail before persistence. D1 constraints repeat the security-relevant bounds so direct repository defects fail closed. Duplicate public IDs, duplicate namespace-bound idempotency hashes, foreign owners, inactive subjects, and attempted updates fail without replacing an existing event. Public status codes and replay/conflict semantics belong to later repository and HTTP tasks.

## Internal Ordered Pages

The internal page repository reads one exact principal/client namespace in increasing sequence order. Callers may start at the beginning or continue strictly after one validated sequence. Each call accepts a finite limit no larger than 100, asks D1 for only `limit + 1` rows, returns no more than the requested limit, and reports only whether another page exists. Empty namespaces return an empty final page.

Repository consumers must not serialize the internal sequence. A future public Events collection will translate it through the namespace-bound cursor primitive. Malformed page positions and limits fail before D1, and a repository row that violates the durable contract fails closed instead of being partially returned.

## Opaque Resume Cursors

`src/application-event-cursor.ts` seals one internal resume checkpoint with AES-256-GCM. The encrypted version-1 payload contains only the last event sequence and an expiry. Sequence zero is the explicit empty-stream checkpoint, so an empty read can still provide a safe position from which a later event is strictly newer. Random 96-bit IVs make two cursors for the same checkpoint different while decoding both to the same deterministic `afterSequence` value.

The initial lifetime is exactly 15 minutes. Issuance accepts only a nonnegative safe-integer sequence and time. Opening requires an unexpired safe-integer expiry no later than 15 minutes from the opening time; expiry is exclusive, so a cursor is invalid at its expiry second. A client with an expired or otherwise invalid cursor must restart from the Events collection entry point. Cursor state is not stored in D1 or process memory.

The key is domain-separated from storage cursors and derived from the configured private signing-key material. AES-GCM additional authenticated data binds the fixed Events resource, exact issuer, signing key ID, principal, and OAuth client without putting those values in the token. A cursor therefore cannot cross a resource, deployment boundary, principal, or client. Changing the signing key material or key ID immediately invalidates it.

Opening accepts only bounded canonical unpadded base64url, strict UTF-8, the exact versioned canonical JSON shape, safe integers, and the bounded lifetime. Truncation, tampering, unsupported versions, reordered or extra fields, malformed context, and all binding failures return one internal `null` result. No decoder error contains plaintext cursor state, identity, client, or signing material. HTTP error mapping remains owned by the later Events collection task.

## Internal Point Lookup

Point lookup requires the exact principal, client, and canonical public UUID in one prepared query. A matching row is returned as a validated defensive value. An absent UUID and an event owned by another principal or client all return the same `null` result, so the repository does not reveal whether another namespace contains that identifier. Malformed namespace values or identifiers fail before D1 access, and malformed persisted rows fail closed.

## Internal Idempotent Append

Append validates the complete persistence input, then attempts one conditional D1 `INSERT ... RETURNING` without a preliminary read. Admission requires an existing principal, an existing enabled client, and no account-deletion job. A successful insert returns `created` with the immutable row selected by that same statement.

When that insert does not win and an idempotency hash was supplied, one namespace- and active-owner-bound read compares the stored request fingerprint. An exact fingerprint returns `replayed` with the original event; another fingerprint returns `conflict`. No idempotency value, a colliding public UUID, missing ownership, a disabled client, or an inactive subject returns the same `unavailable` result. Unexpected repository failures are not reclassified as an ownership or conflict outcome.

The memory repository executes the equivalent transition without yielding between its ownership check, idempotency decision, sequence assignment, and insertion. Both adapters return defensive event values and retain only the supplied SHA-256 base64url idempotency hash, never the original key.
