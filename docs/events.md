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

The public UUID is not an authorization capability. Future reads must bind the caller's exact principal and client namespace in every query. Internal sequences must never be returned directly; resumable public traversal will use an authenticated opaque cursor.

## Validation and Failures

The deployed contract accepts only canonical lowercase UUIDv4 identifiers, nonempty bounded namespace components, event types beginning with an ASCII alphanumeric character and containing only ASCII alphanumeric, dot, underscore, colon, or hyphen characters, JSON objects no larger than 64 KiB, canonical 43-character SHA-256 base64url hashes, and finite ordered timestamps.

Malformed values fail before persistence. D1 constraints repeat the security-relevant bounds so direct repository defects fail closed. Duplicate public IDs, duplicate namespace-bound idempotency hashes, foreign owners, inactive subjects, and attempted updates fail without replacing an existing event. Public status codes and replay/conflict semantics belong to later repository and HTTP tasks.
