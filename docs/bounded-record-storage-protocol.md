# Bounded Record Storage Protocol 1.1

AittaDB's bounded record-storage protocol is a generic server primitive for
credential-bound JSON records. It does not contain application workflows or
interpret stored values. Protocol clients discover its HTTPS targets at
runtime instead of constructing AittaDB routes.

Protocol 1.1 uses AittaDB's `0.1` hypermedia envelope and the response media
type `application/vnd.aittadb+json; version=0.1`. The strict TypeScript wire
contract is maintained in `src/bounded-record-protocol.ts`.

## Discovery contract

The discovery resource has type `bounded-record-storage` and advertises these
actions:

| Action             | Method | Required AittaDB scopes                           |
| ------------------ | ------ | ------------------------------------------------- |
| `read-record`      | `GET`  | `storage.read`                                    |
| `list-records`     | `GET`  | `storage.read`                                    |
| `transact-records` | `POST` | `storage.read`, `storage.write`, `storage.delete` |

All action targets are HTTPS and share the discovery origin. A deployment
advertises this exact capability set:

- `bounded-record-read`
- `opaque-cursor-page`
- `atomic-multi-record-compare-and-set`
- `atomic-read-revision-check`
- `idempotent-operation-id`
- `atomic-rollback`
- `quota-preflight`
- `non-disclosing-authorization`

The maximum page size is 100 and a transaction contains 1 through 25 unique
record keys. A deployment also advertises positive finite record-byte,
transaction-byte, and cursor-character limits no larger than 262,144 bytes,
1,048,576 bytes, and 2,048 characters respectively. AittaDB's initial record
limit is 65,536 bytes.

## Keys and revisions

A record key has a collection matching `^[a-z][a-z0-9-]{0,63}$` and a separate
stable record ID of 1 through 128 ASCII characters. A record value is a finite
JSON object. Revision 1 is assigned at creation; every successful replacement
increments the positive revision by exactly one.

Collection pages are ordered by stable record ID and use opaque continuation
cursors. The cursor plaintext is the canonical JSON object
`{"v":1,"last_record_id":"..."}` and contains no other field. A random
AES-GCM IV and ciphertext make the result URL-safe; authenticated data binds
the bounded-record list resource, exact authenticated user/client namespace,
collection, and requested page size. The key is derived from the configured
private ES256 JWK scalar through a domain distinct from legacy storage cursors.
The cursor is at most 2,048 characters and carries no public principal,
physical storage key, or authorization-policy field. Rotating the private
signing-key material immediately invalidates outstanding cursors. Tampering,
malformed or noncanonical encoding, wrong context, invalid IDs, and oversized
input all fail with the same generic invalid-cursor result.

## Atomic transactions

One transaction has a stable operation ID and an ordered array of unique-key
mutations:

- `put` with `expected_revision: null` creates an absent record.
- `put` with an exact positive revision replaces that record.
- `delete` requires an exact positive revision.
- `check` with `null` proves absence without writing.
- `check` with a positive revision returns unchanged record evidence.

All authorization, shape, revision, existence, quota, and other preconditions
are evaluated against one pre-transaction state. Every record effect and the
durable operation receipt commit together, or none commit. Deletes can free
capacity for puts in the same transaction because quotas use the complete
candidate state.

The D1 repository executes one bounded atomic batch. It first stores a pending
receipt only after preflight succeeds, applies at most 25 guarded unique-key
mutations, verifies every resulting revision/value/absence, and transitions the
receipt to committed. A failed guard deliberately aborts the D1 batch, so no
partial record or pending receipt survives. The in-memory test adapter performs
the same transition without yielding between its final precondition and state
replacement.

An exact retry in the same credential namespace returns the original ordered
result with `replayed: true`, including after runtime reconstruction. Reusing
the operation ID for changed work returns a fixed conflict. Failed operations
retain no receipt.

Only SHA-256 hashes of operation IDs and canonical requests are persisted.
Committed receipts retain the bounded ordered result required for exact replay;
they are internal, have no list/read API, and do not count as application
records. Separate deployment, subject, and namespace receipt count/byte
ceilings reuse the configured finite storage-limit values so check-only traffic
cannot create unbounded internal state. Exceeding either application-record or
receipt admission returns the same fixed `quota_exceeded` result without
disclosing which ceiling was reached. Account deletion removes receipts before
record rows and refuses finalization while either remains.

## Fixed failures

Protocol errors use type `bounded-storage-error`, empty `links` and `actions`,
and only a fixed `code` and message. Supported codes are `invalid_request`,
`not_found`, `conflict`, `precondition_failed`, `quota_exceeded`, and
`unavailable`.

Record authorization is non-disclosing. Once bearer authentication succeeds,
denied and absent record operations have equivalent fixed `404 not_found`
representations. Errors and logs never contain record keys or values,
operation IDs, cursors, quota state, identities, credentials, internal paths,
or backend exception text.
