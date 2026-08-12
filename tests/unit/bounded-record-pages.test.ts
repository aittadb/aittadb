import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedRecordDiscovery,
  boundedRecordDocument,
  boundedRecordPageDocument,
  boundedRecordTransactionDocument,
  type BoundedRecord,
} from "../../src/bounded-record-protocol";
import {
  boundedRecordDiscoveryPage,
  boundedRecordErrorPage,
  boundedRecordItemPage,
  boundedRecordListPage,
  boundedRecordTransactionResultPage,
  type BoundedRecordHtmlFormOptions,
} from "../../src/bounded-record-pages";

const ORIGIN = "https://records.example.test";
const forms: BoundedRecordHtmlFormOptions = {
  readAction: "/storage/record-protocol/records",
  listAction: "/storage/record-protocol/records",
  transactionAction: "/storage/record-protocol/transactions",
  csrfToken: "csrf-test-value",
};
const actions = [
  { href: "/safe-recovery", label: "Safe recovery" },
  { href: "/docs", label: "API docs", secondary: true },
] as const;

test("discovery page exposes the exact contract and conditionally renders forms", () => {
  const document = discovery();
  const withForms = boundedRecordDiscoveryPage({
    document,
    forms,
    navigation: { apiDocsHref: "/docs" },
  });
  assert.match(withForms, /Protocol contract/);
  assert.match(withForms, /1\.1/);
  for (const capability of document.data.capabilities) {
    assert.match(withForms, new RegExp(capability));
  }
  for (const [name, value] of Object.entries(document.data.limits)) {
    assert.match(withForms, new RegExp(`${name}[\\s\\S]+${value}`));
  }
  for (const action of document.actions) {
    assert.match(withForms, new RegExp(action.name));
    assert.match(withForms, new RegExp(action.method));
    assert.match(withForms, new RegExp(escapeRegExp(action.href)));
  }
  assert.match(withForms, /name="csrf_token" value="csrf-test-value"/);
  assert.match(withForms, /name="transaction"/);
  assert.match(withForms, /name="collection"/);
  assert.match(withForms, /Read record/);
  assert.match(withForms, /List records/);

  const withoutForms = boundedRecordDiscoveryPage({
    document,
    navigation: { signInHref: "/session", apiDocsHref: "/docs" },
  });
  assert.doesNotMatch(withoutForms, /<form /);
  assert.match(withoutForms, /Sign in with ChatGPT/);
  assert.match(withoutForms, /API docs/);
  assert.doesNotMatch(withoutForms, /csrf-test-value/);
});

test("list pages render empty and ordered collection states, links, and optional transactions", () => {
  const empty = boundedRecordPageDocument({
    href: `${ORIGIN}/storage/record-protocol/records?collection=items&limit=2`,
    collection: "items",
    pageSize: 2,
    items: [],
    nextCursor: null,
    nextHref: null,
  });
  const emptyHtml = boundedRecordListPage({
    document: empty,
    recordHref: (record) => `/records/${record.key.id}`,
    actions,
  });
  assert.match(emptyHtml, /No records found/);
  assert.doesNotMatch(emptyHtml, /<tbody>\s*<tr>/);
  assert.doesNotMatch(emptyHtml, /name="csrf_token"/);

  const first = record("items", "alpha", 1, { label: "<unsafe>" });
  const second = record("items", "zulu", 2, { enabled: true });
  const page = boundedRecordPageDocument({
    href: `${ORIGIN}/storage/record-protocol/records?collection=items&limit=2`,
    collection: "items",
    pageSize: 2,
    items: [first, second],
    nextCursor: "opaque-cursor",
    nextHref: `${ORIGIN}/storage/record-protocol/records?collection=items&limit=2&cursor=opaque-cursor`,
  });
  const html = boundedRecordListPage({
    document: page,
    recordHref: (item) => `/records/${item.key.id}`,
    forms,
    collectionHref: "/records?collection=items",
    actions,
  });
  assert.match(html, /alpha/);
  assert.match(html, /zulu/);
  assert.match(html, /Next page/);
  assert.match(html, /Back to the record collection/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /name="csrf_token" value="csrf-test-value"/);
});

test("item page renders escaped metadata, revision, formatted value, and conditional form", () => {
  const document = boundedRecordDocument(
    record("profiles", "current", 7, {
      greeting: "</script><script>alert(1)</script>",
      nested: { ok: true },
    }),
  );
  const html = boundedRecordItemPage({
    document,
    forms,
    collectionHref: "/records?collection=profiles",
    actions,
  });
  assert.match(html, /Record ID/);
  assert.match(html, /current/);
  assert.match(html, />7<|>7<\/strong>/);
  assert.match(
    html,
    /&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/,
  );
  assert.match(html, /Back to profiles records/);
  assert.match(html, /name="csrf_token" value="csrf-test-value"/);
  assert.match(html, /name="transaction"/);
});

test("transaction result page is a human result with ordered record and empty outcomes", () => {
  const first = record("items", "alpha", 3, { state: "ready" });
  const document = boundedRecordTransactionDocument({
    operationId: "operation:ordered",
    replayed: true,
    records: [first, null],
  });
  const html = boundedRecordTransactionResultPage({
    document,
    recordHref: (record) => `/records/${record.key.id}`,
    actions,
  });
  assert.match(html, /operation:ordered/);
  assert.match(html, /Yes, original result replayed/);
  assert.match(html, /No record/);
  assert.match(html, /Empty result/);
  assert.match(html, /revision 3/);
  assert.match(html, /items\/alpha/);
  assert.doesNotMatch(html, /json-output/);
  assert.doesNotMatch(html, /"records"\s*:/);
});

test("fixed error pages expose no rejected private values", () => {
  const privateValues = [
    "private-record-key",
    "operation:private",
    "opaque-private-cursor",
    "private stored value",
    "user-secret@example.test",
  ];
  const html = boundedRecordErrorPage({
    code: "precondition_failed",
    actions,
  });
  assert.match(html, /Status/);
  assert.match(html, />412</);
  assert.match(html, /precondition_failed/);
  assert.match(html, /The storage resource has changed\./);
  for (const privateValue of privateValues) {
    assert.equal(html.includes(privateValue), false);
  }
  assert.match(html, /safe-recovery/);
  assert.match(html, /API docs/);
});

function discovery() {
  return boundedRecordDiscovery({
    entryHref: `${ORIGIN}/storage/record-protocol`,
    readRecordHref: `${ORIGIN}/storage/record-protocol/records/{collection}/{id}`,
    listRecordsHref: `${ORIGIN}/storage/record-protocol/records`,
    transactRecordsHref: `${ORIGIN}/storage/record-protocol/transactions`,
  });
}

function record(
  collection: string,
  id: string,
  revision: number,
  value: Record<string, unknown>,
): BoundedRecord {
  return { key: { collection, id }, revision, value } as BoundedRecord;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
