import {
  boundedRecordErrorDocument,
  boundedRecordErrorStatus,
  type BoundedRecord,
  type BoundedRecordDiscoveryDocument,
  type BoundedRecordDocument,
  type BoundedRecordErrorCode,
  type BoundedRecordPageDocument,
  type BoundedRecordTransactionDocument,
} from "./bounded-record-protocol";
import { escapeHtml, pageDocument, type PageAction } from "./pages";

export interface BoundedRecordHtmlFormOptions {
  readonly readAction: string;
  readonly listAction: string;
  readonly transactionAction: string;
  readonly csrfToken: string;
}

export interface BoundedRecordPageNavigation {
  readonly apiDocsHref?: string;
  readonly homeHref?: string;
  readonly signInHref?: string;
}

export interface BoundedRecordDiscoveryPageOptions {
  readonly document: BoundedRecordDiscoveryDocument;
  readonly forms?: BoundedRecordHtmlFormOptions;
  readonly navigation?: BoundedRecordPageNavigation;
  readonly actions?: readonly PageAction[];
}

export interface BoundedRecordListPageOptions {
  readonly document: BoundedRecordPageDocument;
  readonly recordHref: (record: Readonly<BoundedRecord>) => string;
  readonly collectionHref?: string;
  readonly forms?: BoundedRecordHtmlFormOptions;
  readonly actions?: readonly PageAction[];
}

export interface BoundedRecordItemPageOptions {
  readonly document: BoundedRecordDocument;
  readonly collectionHref?: string;
  readonly forms?: BoundedRecordHtmlFormOptions;
  readonly actions?: readonly PageAction[];
}

export interface BoundedRecordTransactionResultPageOptions {
  readonly document: BoundedRecordTransactionDocument;
  readonly recordHref?: (record: Readonly<BoundedRecord>) => string;
  readonly actions?: readonly PageAction[];
}

export interface BoundedRecordErrorPageOptions {
  readonly code: BoundedRecordErrorCode;
  readonly status?: number;
  readonly actions: readonly PageAction[];
}

const DEFAULT_ACTIONS: readonly PageAction[] = [
  { href: "/session", label: "Sign in with ChatGPT" },
  { href: "/docs", label: "API docs", secondary: true },
];

export function boundedRecordDiscoveryPage(
  options: BoundedRecordDiscoveryPageOptions,
): string {
  const document = options.document;
  const forms = options.forms;
  const navigation = options.navigation ?? {};
  const formSection = forms
    ? `<section class="resource-workbench" aria-labelledby="record-navigation-heading"><h2 id="record-navigation-heading">Use the current signed-in session</h2><p>These forms use this browser's current AittaDB session. API clients can follow the same actions with a bearer credential.</p>${readForm(forms)}${listForm(forms, document.data.limits.max_page_size)}${transactionForm(forms, "discovery")}</section>`
    : `<p class="note">Sign in to use the browser forms, or use the API documentation with an AittaDB bearer credential. ChatGPT credentials never appear in this interface.</p>`;
  const actions =
    options.actions ??
    (forms
      ? compactActions(navigation, [{ href: "/docs", label: "API docs" }])
      : compactActions(navigation, DEFAULT_ACTIONS));

  return pageDocument({
    title: "Bounded record storage",
    eyebrow: "Record storage protocol",
    heading: "Bounded record storage",
    summary:
      "Protocol 1.1 for bounded reads, ordered pages, and atomic record transactions.",
    visualEyebrow: "Versioned storage primitive",
    visualHeading: "Small records. Explicit revisions.",
    visualSummary:
      "AittaDB exposes a bounded, namespace-scoped record protocol with the same useful controls in HTML and JSON.",
    body: `<section class="storage-state" aria-labelledby="protocol-contract-heading"><h2 id="protocol-contract-heading">Protocol contract</h2><div class="info-grid" aria-label="Record storage protocol contract"><div><span>Version</span><strong>${escapeHtml(document.data.protocol_version)}</strong></div><div><span>Protocol</span><strong>${escapeHtml(document.data.protocol)}</strong></div><div><span>Revision model</span><strong>Compare and set</strong></div><div><span>Transaction result</span><strong>Ordered record or empty result</strong></div></div></section>${contractTables(document)}${formSection}`,
    actions,
  });
}

export function boundedRecordListPage(
  options: BoundedRecordListPageOptions,
): string {
  const document = options.document;
  const collection = document.data.collection;
  const nextHref = findLink(document.links, "next");
  const collectionHref = options.collectionHref;
  const rows = document.data.items
    .map((record) => {
      const href = options.recordHref(record);
      return `<tr><th scope="row"><a class="table-link" href="${escapeHtml(href)}">${escapeHtml(record.key.id)}</a></th><td><code>${record.revision}</code></td><td><code class="table-value">${escapeHtml(formatJson(record.value))}</code></td></tr>`;
    })
    .join("");
  const state =
    document.data.items.length === 0
      ? `<p class="empty-state" role="status">No records found in <code>${escapeHtml(collection)}</code>.</p>`
      : `<div class="table-wrap"><table class="resource-table"><caption>Records in ${escapeHtml(collection)}</caption><thead><tr><th scope="col">Record ID</th><th scope="col">Revision</th><th scope="col">Value</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const pagination = nextHref
    ? `<nav class="actions" aria-label="Record pages"><a class="button secondary" href="${escapeHtml(nextHref)}">Next page</a></nav>`
    : `<p class="note">End of this record collection page.</p>`;
  const transaction = options.forms
    ? `<section class="resource-workbench" aria-labelledby="record-transaction-heading"><h2 id="record-transaction-heading">Apply a transaction</h2><p>Submit ordered compare-and-set mutations for this namespace.</p>${transactionForm(options.forms, "list")}</section>`
    : "";
  const collectionLink = collectionHref
    ? `<p><a href="${escapeHtml(collectionHref)}">Back to the record collection</a></p>`
    : "";

  return pageDocument({
    title: `${collection} records`,
    eyebrow: "Record collection",
    heading: "Record collection",
    summary: `Ordered records from the ${collection} collection.`,
    visualEyebrow: "Bounded collection",
    visualHeading: "A page you can safely traverse.",
    visualSummary:
      "Stable record links and opaque continuation pages keep collection navigation bounded and namespace-scoped.",
    body: `<section class="storage-state" aria-labelledby="records-heading"><div class="storage-state-heading"><h2 id="records-heading">${escapeHtml(collection)}</h2><p>${document.data.items.length} ${document.data.items.length === 1 ? "record" : "records"} on this page.</p></div>${state}${pagination}</section>${transaction}${collectionLink}`,
    actions: options.actions ?? DEFAULT_ACTIONS,
  });
}

export function boundedRecordItemPage(
  options: BoundedRecordItemPageOptions,
): string {
  const record = options.document.data;
  const forms = options.forms;
  const collectionHref = options.collectionHref;
  const transaction = forms
    ? `<section class="resource-workbench" aria-labelledby="record-transaction-heading"><h2 id="record-transaction-heading">Apply a transaction</h2><p>Submit an ordered compare-and-set mutation for this namespace.</p>${transactionForm(forms, "item")}</section>`
    : "";
  const collectionLink = collectionHref
    ? `<p><a href="${escapeHtml(collectionHref)}">Back to ${escapeHtml(record.key.collection)} records</a></p>`
    : "";

  return pageDocument({
    title: "Record details",
    eyebrow: "Record resource",
    heading: "Record details",
    summary:
      "A single AittaDB record returned from the current authorized namespace.",
    visualEyebrow: "Revisioned resource",
    visualHeading: "Read the value. Check the revision.",
    visualSummary:
      "Record identity and revision are explicit so clients can make safe conditional updates.",
    body: `<section class="storage-state" aria-labelledby="record-details-heading"><h2 id="record-details-heading">Record metadata</h2><section class="info-grid" aria-label="Record metadata"><div><span>Collection</span><strong>${escapeHtml(record.key.collection)}</strong></div><div><span>Record ID</span><strong>${escapeHtml(record.key.id)}</strong></div><div><span>Revision</span><strong>${record.revision}</strong></div></section><h2>JSON value</h2><pre class="record-value" aria-label="Record JSON value">${escapeHtml(formatJson(record.value))}</pre></section>${transaction}${collectionLink}`,
    actions: options.actions ?? DEFAULT_ACTIONS,
  });
}

export function boundedRecordTransactionResultPage(
  options: BoundedRecordTransactionResultPageOptions,
): string {
  const result = options.document.data;
  const rows = result.records
    .map((record, index) => {
      if (record === null) {
        return `<tr><th scope="row">${index + 1}</th><td><strong>No record</strong></td><td>Empty result</td></tr>`;
      }
      const key = `${record.key.collection}/${record.key.id}`;
      const keyContent = options.recordHref
        ? `<a class="table-link" href="${escapeHtml(options.recordHref(record))}">${escapeHtml(key)}</a>`
        : escapeHtml(key);
      return `<tr><th scope="row">${index + 1}</th><td>${keyContent}</td><td><code>revision ${record.revision}</code><br><code class="table-value">${escapeHtml(formatJson(record.value))}</code></td></tr>`;
    })
    .join("");

  return pageDocument({
    title: "Record transaction result",
    eyebrow: "Atomic transaction result",
    heading: "Record transaction result",
    summary:
      "The ordered result of one AittaDB transaction, rendered for people without exposing a raw protocol dump.",
    tone: "success",
    visualEyebrow: "Atomic result",
    visualHeading: "Every operation keeps its order.",
    visualSummary:
      "A successful replay returns the same ordered result while the service keeps the operation receipt durable.",
    body: `<section class="storage-state" aria-labelledby="transaction-status-heading"><h2 id="transaction-status-heading">Transaction status</h2><section class="info-grid" aria-label="Transaction status"><div><span>Operation ID</span><code>${escapeHtml(result.operation_id)}</code></div><div><span>Replay</span><strong>${result.replayed ? "Yes, original result replayed" : "No, first successful request"}</strong></div><div><span>Outcomes</span><strong>${result.records.length}</strong></div></section><div class="table-wrap"><table class="resource-table"><caption>Ordered transaction outcomes</caption><thead><tr><th scope="col">Order</th><th scope="col">Record</th><th scope="col">Outcome</th></tr></thead><tbody>${rows}</tbody></table></div></section>`,
    actions: options.actions ?? DEFAULT_ACTIONS,
  });
}

export function boundedRecordErrorPage(
  options: BoundedRecordErrorPageOptions,
): string {
  const document = boundedRecordErrorDocument(options.code);
  const status = options.status ?? boundedRecordErrorStatus(options.code);
  const tone =
    status >= 500
      ? "danger"
      : status === 409 || status === 412
        ? "warning"
        : "default";
  return pageDocument({
    title: "Storage request rejected",
    eyebrow: "Storage request",
    heading: "Storage request rejected",
    summary: document.data.message,
    status,
    tone,
    visualEyebrow: "Fixed protocol response",
    visualHeading: "The request stopped at the boundary.",
    visualSummary:
      "AittaDB returns a fixed error without reflecting private request or backend details.",
    body: `<section class="info-grid" aria-label="Storage error"><div><span>Status</span><strong>${status}</strong></div><div><span>Error code</span><code>${escapeHtml(document.data.code)}</code></div><div><span>Message</span><strong>${escapeHtml(document.data.message)}</strong></div></section>`,
    actions: options.actions,
  });
}

function contractTables(document: BoundedRecordDiscoveryDocument): string {
  const capabilities = document.data.capabilities
    .map((capability) => `<li><code>${escapeHtml(capability)}</code></li>`)
    .join("");
  const limits = [
    ["max_record_bytes", document.data.limits.max_record_bytes],
    ["max_page_size", document.data.limits.max_page_size],
    [
      "max_transaction_mutations",
      document.data.limits.max_transaction_mutations,
    ],
    ["max_transaction_bytes", document.data.limits.max_transaction_bytes],
    ["max_cursor_length", document.data.limits.max_cursor_length],
  ]
    .map(
      ([name, value]) =>
        `<tr><th scope="row"><code>${escapeHtml(String(name))}</code></th><td>${escapeHtml(String(value))}</td></tr>`,
    )
    .join("");
  const actions = document.actions
    .map(
      (action) =>
        `<tr><th scope="row"><code>${escapeHtml(action.name)}</code></th><td><code>${escapeHtml(action.method)}</code></td><td><code>${escapeHtml(action.href)}</code></td><td>${escapeHtml(action.authorization.scopes.join(" "))}</td></tr>`,
    )
    .join("");
  return `<section class="resource-workbench" aria-labelledby="capabilities-heading"><h2 id="capabilities-heading">Capabilities</h2><ul>${capabilities}</ul><h2>Limits</h2><div class="table-wrap"><table class="resource-table"><caption>Bounded record protocol limits</caption><thead><tr><th scope="col">Limit</th><th scope="col">Value</th></tr></thead><tbody>${limits}</tbody></table></div><h2>Actions</h2><div class="table-wrap"><table class="resource-table"><caption>Bounded record protocol actions</caption><thead><tr><th scope="col">Action</th><th scope="col">Method</th><th scope="col">Target</th><th scope="col">Required scopes</th></tr></thead><tbody>${actions}</tbody></table></div></section>`;
}

function readForm(forms: BoundedRecordHtmlFormOptions): string {
  return `<section class="resource-operation" aria-labelledby="record-read-heading"><header><span class="method-badge">GET</span><div><h3 id="record-read-heading">Read one record</h3><p>Open a record by collection and ID.</p></div></header><form method="get" action="${escapeHtml(forms.readAction)}" class="stacked-form"><label for="record-read-collection">Collection</label><input id="record-read-collection" name="collection" maxlength="64" autocomplete="off" required><label for="record-read-id">Record ID</label><input id="record-read-id" name="id" maxlength="128" autocomplete="off" required><div class="actions"><button type="submit">Read record</button></div></form></section>`;
}

function listForm(
  forms: BoundedRecordHtmlFormOptions,
  maxPageSize: number,
): string {
  return `<section class="resource-operation" aria-labelledby="record-list-heading"><header><span class="method-badge">GET</span><div><h3 id="record-list-heading">List a collection</h3><p>Browse records in stable key order.</p></div></header><form method="get" action="${escapeHtml(forms.listAction)}" class="stacked-form"><label for="record-list-collection">Collection</label><input id="record-list-collection" name="collection" maxlength="64" autocomplete="off" required><label for="record-list-limit">Page size</label><input id="record-list-limit" name="limit" type="number" min="1" max="${maxPageSize}" value="${maxPageSize}" required><label for="record-list-cursor">Continuation cursor <span class="optional">optional</span></label><input id="record-list-cursor" name="cursor" maxlength="2048" autocomplete="off"><div class="actions"><button type="submit">List records</button></div></form></section>`;
}

function transactionForm(
  forms: BoundedRecordHtmlFormOptions,
  prefix: string,
): string {
  const id = `record-transaction-${prefix}`;
  const example = `{
  "transaction": {
    "operation_id": "example-operation",
    "mutations": [
      {
        "type": "check",
        "key": { "collection": "settings", "id": "example" },
        "expected_revision": null
      }
    ]
  }
}`;
  return `<form method="post" action="${escapeHtml(forms.transactionAction)}" class="stacked-form"><input type="hidden" name="csrf_token" value="${escapeHtml(forms.csrfToken)}"><label for="${id}">Transaction JSON</label><textarea id="${id}" name="transaction" class="json-input" spellcheck="false" required>${escapeHtml(example)}</textarea><div class="actions"><button type="submit">Run transaction</button></div></form>`;
}

function findLink(
  links: readonly { rel: readonly string[]; href: string }[],
  relation: string,
): string | null {
  return links.find((link) => link.rel.includes(relation))?.href ?? null;
}

function formatJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(value, null, 2);
}

function compactActions(
  navigation: BoundedRecordPageNavigation,
  fallback: readonly PageAction[],
): readonly PageAction[] {
  const actions: PageAction[] = [];
  if (navigation.signInHref) {
    actions.push({
      href: navigation.signInHref,
      label: "Sign in with ChatGPT",
    });
  }
  if (navigation.apiDocsHref) {
    actions.push({
      href: navigation.apiDocsHref,
      label: "API docs",
      secondary: true,
    });
  }
  if (navigation.homeHref) {
    actions.push({
      href: navigation.homeHref,
      label: "Service home",
      secondary: true,
    });
  }
  return actions.length > 0 ? actions : fallback;
}
