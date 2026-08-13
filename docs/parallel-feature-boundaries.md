# Parallel Feature Boundaries

## Purpose

This note records the current TypeScript and HTML feature boundaries so work can be
split safely without turning AittaDB into a plugin framework. It is evidence for
`TASK-247`, not a mandate to refactor every large file.

## Current Boundaries

`src/handler.ts` is the shared HTTP composition hotspot. It owns route ordering,
feature availability, representation negotiation, body policy, CORS, and the
top-level dispatch to feature endpoints. A new protocol may need a small,
intentional edit there, but its route-specific behavior belongs in its own module.

The bounded record-storage protocol follows that shape:

- `src/bounded-record-http.ts` owns the record protocol route family and returns
  `Response | null` to the central dispatcher.
- `src/bounded-record-protocol.ts` owns strict decoding and protocol documents.
- `src/bounded-record-transaction.ts` owns ordered transaction semantics.
- `src/bounded-record-pages.ts` owns feature HTML and imports only the shared page
  shell from `src/pages.ts`.

This keeps protocol behavior, rendering, and transaction semantics independently
testable while retaining one authoritative HTTP security boundary. Do not move the
feature HTML into `src/pages.ts` or split the HTTP module by method: the shared
error, principal-adaptation, and representation contracts are meaningful cohesion.

`src/storage.ts` remains the canonical legacy record/file authorization surface.
Bounded records reuse its scoped authorization helpers rather than duplicating
scope or namespace checks. Extracting those checks now would spread a
security-sensitive contract without a demonstrated second consumer.

`src/store/d1.ts` is a large infrastructure hotspot, but bounded record reads and
transactions are contiguous and have matching Memory/D1 coverage. Extracting a
new generic repository would currently cross quotas, cleanup, deletion, the
`AuthStore` contract, and both adapters. That is not a safe or useful split yet.

## Test Seams

- Strict documents and decoding: `tests/unit/bounded-record-protocol.test.ts`.
- HTML rendering: `tests/unit/bounded-record-pages.test.ts`.
- Memory/D1 transaction and repository parity:
  `tests/unit/bounded-record-transaction.test.ts` and
  `tests/unit/bounded-record-repository.test.ts`.
- Route, authorization, privacy, and feature-gate behavior:
  `tests/integration/bounded-record-protocol.test.ts`.

These seams let a protocol change, representation change, or repository change be
developed and reviewed independently before the small shared-dispatch integration.

## Refactor Decision

No source refactor is justified by the current evidence. The existing bounded
record modules are a useful feature-owned boundary, and a generalized router,
plugin system, per-method files, or generic storage repository would add coupling
rather than remove it.

Create a new narrowly scoped PLAN task only when a second independent storage
protocol demonstrably needs the same `src/handler.ts` integration points. Its
contract may then be a typed declarative storage-route composition seam that
preserves route order, feature gates, body limits, CORS, negotiation, and current
regression behavior. Until then, make the small explicit `handler.ts` integration
edit and keep the behavior in the feature module.
