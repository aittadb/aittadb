import assert from "node:assert/strict";
import test from "node:test";

import {
  BOUNDED_RECORD_CAPABILITIES,
  BOUNDED_RECORD_LIMITS,
  BOUNDED_RECORD_MEDIA_TYPE,
  BOUNDED_RECORD_MAX_TRANSACTION_ENTRIES,
  BOUNDED_RECORD_PROTOCOL_VERSION,
  BoundedRecordProtocolError,
  boundedRecordDiscovery,
  boundedRecordDocument,
  boundedRecordErrorDocument,
  boundedRecordErrorStatus,
  boundedRecordPageDocument,
  boundedRecordTransactionDocument,
  canonicalBoundedRecordTransaction,
  decodeBoundedRecordKey,
  decodeBoundedRecordTransaction,
  validateBoundedRecordLimits,
  type BoundedRecordTransactionCommand,
} from "../../src/bounded-record-protocol";
import { HYPERMEDIA_API_VERSION } from "../../src/hypermedia";

const ORIGIN = "https://storage.example.test";
const ENTRY = `${ORIGIN}/storage/record-protocol`;
const READ = `${ORIGIN}/storage/record-protocol/records/{collection}/{id}`;
const LIST = `${ORIGIN}/storage/record-protocol/records`;
const TRANSACT = `${ORIGIN}/storage/record-protocol/transactions`;

test("protocol 1.1 discovery freezes the exact generic capability contract", () => {
  const document = discovery();
  assert.equal(document.api_version, HYPERMEDIA_API_VERSION);
  assert.equal(document.type, "bounded-record-storage");
  assert.equal(document.data.protocol, "bounded-record-storage");
  assert.equal(document.data.protocol_version, BOUNDED_RECORD_PROTOCOL_VERSION);
  assert.deepEqual(document.data.capabilities, BOUNDED_RECORD_CAPABILITIES);
  assert.deepEqual(document.data.limits, BOUNDED_RECORD_LIMITS);
  assert.equal(document.data.limits.max_page_size, 100);
  assert.equal(document.data.limits.max_transaction_mutations, 25);
  assert.equal(document.data.transaction_shape.mutations.unique_keys, true);
  assert.equal(
    document.data.transaction_shape.mutations.check,
    "null-requires-absence-positive-revision-preserves-record",
  );
  assert.deepEqual(
    document.actions.map(({ name, method, href }) => ({ name, method, href })),
    [
      { name: "read-record", method: "GET", href: READ },
      { name: "list-records", method: "GET", href: LIST },
      { name: "transact-records", method: "POST", href: TRANSACT },
    ],
  );
  assert.deepEqual(document.actions[0]?.authorization.scopes, ["storage.read"]);
  assert.deepEqual(document.actions[2]?.authorization.scopes, [
    "storage.read",
    "storage.write",
    "storage.delete",
  ]);
  assert.equal(document.actions[2]?.type, "application/json");
  assert.equal(document.actions[2]?.accept, BOUNDED_RECORD_MEDIA_TYPE);
  assert.ok(
    document.links.every((link) => link.type === BOUNDED_RECORD_MEDIA_TYPE),
  );
  assert.equal(Object.isFrozen(document), true);
  assert.equal(Object.isFrozen(document.data.capabilities), true);
});

test("discovery rejects unsafe origins, templates, and client-unsafe limits", () => {
  const attempts: Array<() => unknown> = [
    () =>
      boundedRecordDiscovery({
        entryHref: ENTRY,
        readRecordHref: READ,
        listRecordsHref: "https://other.example.test/records",
        transactRecordsHref: TRANSACT,
      }),
    () =>
      boundedRecordDiscovery({
        entryHref: ENTRY,
        readRecordHref: `${ORIGIN}/records/{collection}`,
        listRecordsHref: LIST,
        transactRecordsHref: TRANSACT,
      }),
    () =>
      boundedRecordDiscovery({
        entryHref: ENTRY,
        readRecordHref: READ,
        listRecordsHref: LIST,
        transactRecordsHref: TRANSACT,
        limits: { ...BOUNDED_RECORD_LIMITS, max_page_size: 99 },
      }),
    () =>
      validateBoundedRecordLimits({
        ...BOUNDED_RECORD_LIMITS,
        max_transaction_bytes: 1_048_577,
      }),
  ];
  for (const attempt of attempts) assertInvalid(attempt);
});

test("strict decoding snapshots ordered put, check, and delete mutations", () => {
  const command = decodeBoundedRecordTransaction({
    transaction: {
      operation_id: "operation:profile-update",
      mutations: [
        {
          type: "put",
          key: { collection: "profiles", id: "current" },
          expected_revision: null,
          value: { name: "Example", nested: { enabled: true } },
        },
        {
          type: "check",
          key: { collection: "settings", id: "policy" },
          expected_revision: 7,
        },
        {
          type: "delete",
          key: { collection: "leases", id: "active" },
          expected_revision: 2,
        },
      ],
    },
  });

  assert.deepEqual(command, {
    transaction: {
      operation_id: "operation:profile-update",
      mutations: [
        {
          type: "put",
          key: { collection: "profiles", id: "current" },
          expected_revision: null,
          value: { name: "Example", nested: { enabled: true } },
        },
        {
          type: "check",
          key: { collection: "settings", id: "policy" },
          expected_revision: 7,
        },
        {
          type: "delete",
          key: { collection: "leases", id: "active" },
          expected_revision: 2,
        },
      ],
    },
  });
  assert.equal(Object.isFrozen(command.transaction.mutations), true);
  assert.equal(Object.isFrozen(command.transaction.mutations[0]?.key), true);
});

test("canonical transactions ignore object member order but preserve mutation order", () => {
  const left = transaction([
    put("profiles", "current", null, { z: 1, a: { y: 2, x: 3 } }),
    check("settings", "policy", null),
  ]);
  const right = {
    transaction: {
      mutations: [
        {
          value: { a: { x: 3, y: 2 }, z: 1 },
          expected_revision: null,
          key: { id: "current", collection: "profiles" },
          type: "put",
        },
        {
          expected_revision: null,
          type: "check",
          key: { id: "policy", collection: "settings" },
        },
      ],
      operation_id: "operation:canonical",
    },
  };
  assert.equal(
    canonicalBoundedRecordTransaction(left),
    canonicalBoundedRecordTransaction(right),
  );
  assert.notEqual(
    canonicalBoundedRecordTransaction(left),
    canonicalBoundedRecordTransaction(
      transaction([
        check("settings", "policy", null),
        put("profiles", "current", null, { z: 1, a: { y: 2, x: 3 } }),
      ]),
    ),
  );
});

test("strict decoding rejects malformed shapes, revisions, keys, and duplicates", () => {
  const valid = transaction([put("profiles", "current", null, { ok: true })]);
  const tooMany = Array.from(
    { length: BOUNDED_RECORD_MAX_TRANSACTION_ENTRIES + 1 },
    (_, index) => put("profiles", `record-${index}`, null, { index }),
  );
  const attempts: unknown[] = [
    { ...valid, extra: true },
    { transaction: { ...valid.transaction, extra: true } },
    {
      transaction: {
        operation_id: "bad id",
        mutations: valid.transaction.mutations,
      },
    },
    { transaction: { operation_id: "operation:empty", mutations: [] } },
    { transaction: { operation_id: "operation:large", mutations: tooMany } },
    transaction([
      put("profiles", "same", null, { a: 1 }),
      check("profiles", "same", null),
    ]),
    transaction([
      { ...put("profiles", "current", null, { ok: true }), extra: true },
    ]),
    transaction([put("Profiles", "current", null, { ok: true })]),
    transaction([put("profiles", ".invalid", null, { ok: true })]),
    transaction([
      { ...remove("profiles", "current", 1), expected_revision: null },
    ]),
    transaction([{ ...check("profiles", "current", 1), expected_revision: 0 }]),
    transaction([
      { ...put("profiles", "current", null, { ok: true }), value: [] },
    ]),
    transaction([
      {
        ...put("profiles", "current", null, { ok: true }),
        value: { n: Infinity },
      },
    ]),
  ];
  for (const attempt of attempts) {
    assertInvalid(() => decodeBoundedRecordTransaction(attempt));
  }
});

test("strict decoding rejects sparse arrays and accessors without invoking them", () => {
  const sparse = [put("profiles", "current", null, { ok: true })];
  sparse.length = 2;
  assertInvalid(() =>
    decodeBoundedRecordTransaction({
      transaction: { operation_id: "operation:sparse", mutations: sparse },
    }),
  );

  let invoked = false;
  const mutation = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(mutation, "type", {
    enumerable: true,
    get() {
      invoked = true;
      return "check";
    },
  });
  mutation.key = { collection: "profiles", id: "current" };
  mutation.expected_revision = null;
  assertInvalid(() =>
    decodeBoundedRecordTransaction({
      transaction: {
        operation_id: "operation:accessor",
        mutations: [mutation],
      },
    }),
  );
  assert.equal(invoked, false);
});

test("record and transaction byte ceilings are independently enforced", () => {
  const smallRecordLimits = {
    ...BOUNDED_RECORD_LIMITS,
    max_record_bytes: 12,
  };
  assertInvalid(() =>
    decodeBoundedRecordTransaction(
      transaction([put("records", "large", null, { value: "too large" })]),
      smallRecordLimits,
    ),
  );
  assertInvalid(() =>
    decodeBoundedRecordTransaction(
      transaction([put("records", "one", null, { ok: true })]),
      { ...BOUNDED_RECORD_LIMITS, max_transaction_bytes: 32 },
    ),
  );
});

test("record, page, and transaction documents preserve bounded ordered evidence", () => {
  const first = {
    key: decodeBoundedRecordKey({ collection: "settings", id: "alpha" }),
    revision: 1,
    value: { enabled: true },
  };
  const second = {
    key: decodeBoundedRecordKey({ collection: "settings", id: "beta" }),
    revision: 4,
    value: { enabled: false },
  };
  assert.deepEqual(boundedRecordDocument(first), {
    api_version: HYPERMEDIA_API_VERSION,
    type: "bounded-storage-record",
    id: "settings/alpha",
    data: first,
    links: [],
    actions: [],
  });
  const page = boundedRecordPageDocument({
    href: `${LIST}?collection=settings&limit=2`,
    collection: "settings",
    pageSize: 2,
    items: [first, second],
    nextCursor: "opaque-cursor",
    nextHref: `${LIST}?collection=settings&limit=2&cursor=opaque-cursor`,
  });
  assert.equal(page.data.items.length, 2);
  assert.equal(page.data.next_cursor, "opaque-cursor");
  assert.deepEqual(
    page.links.map((link) => link.rel),
    [["self"], ["next"]],
  );

  const result = boundedRecordTransactionDocument({
    operationId: "operation:result",
    replayed: false,
    records: [first, null, second],
  });
  assert.equal(result.type, "bounded-storage-transaction");
  assert.equal(result.data.records[0]?.revision, 1);
  assert.equal(result.data.records[1], null);
  assert.equal(result.data.records[2]?.revision, 4);
});

test("fixed failures never reflect private input", () => {
  const privateValues = [
    "private-record-key",
    "operation:private",
    "opaque-private-cursor",
  ];
  const expected = {
    invalid_request: 400,
    not_found: 404,
    conflict: 409,
    precondition_failed: 412,
    quota_exceeded: 507,
    unavailable: 503,
  } as const;
  for (const [code, status] of Object.entries(expected)) {
    const document = boundedRecordErrorDocument(code as keyof typeof expected);
    const encoded = JSON.stringify(document);
    assert.equal(
      boundedRecordErrorStatus(code as keyof typeof expected),
      status,
    );
    assert.deepEqual(Object.keys(document.data).sort(), ["code", "message"]);
    assert.deepEqual(document.links, []);
    assert.deepEqual(document.actions, []);
    for (const privateValue of privateValues) {
      assert.equal(encoded.includes(privateValue), false);
    }
  }
});

function discovery() {
  return boundedRecordDiscovery({
    entryHref: ENTRY,
    readRecordHref: READ,
    listRecordsHref: LIST,
    transactRecordsHref: TRANSACT,
  });
}

function transaction(
  mutations: readonly Record<string, unknown>[],
): BoundedRecordTransactionCommand {
  return {
    transaction: {
      operation_id: "operation:canonical",
      mutations:
        mutations as BoundedRecordTransactionCommand["transaction"]["mutations"],
    },
  };
}

function put(
  collection: string,
  id: string,
  expectedRevision: number | null,
  value: Record<string, unknown>,
) {
  return {
    type: "put",
    key: { collection, id },
    expected_revision: expectedRevision,
    value,
  };
}

function check(
  collection: string,
  id: string,
  expectedRevision: number | null,
) {
  return {
    type: "check",
    key: { collection, id },
    expected_revision: expectedRevision,
  };
}

function remove(collection: string, id: string, expectedRevision: number) {
  return {
    type: "delete",
    key: { collection, id },
    expected_revision: expectedRevision,
  };
}

function assertInvalid(attempt: () => unknown): void {
  assert.throws(
    attempt,
    (error) =>
      error instanceof BoundedRecordProtocolError &&
      error.code === "invalid_request" &&
      error.message === "The storage request is invalid.",
  );
}
