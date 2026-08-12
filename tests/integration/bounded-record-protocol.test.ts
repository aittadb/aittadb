import assert from "node:assert/strict";
import test from "node:test";

import {
  BOUNDED_RECORD_CAPABILITIES,
  BOUNDED_RECORD_MEDIA_TYPE,
  BOUNDED_RECORD_MAX_TRANSACTION_BYTES,
} from "../../src/bounded-record-protocol";
import { loadConfig } from "../../src/config";
import { nowSeconds } from "../../src/crypto";
import { createAittaDBWithStore } from "../../src/handler";
import {
  createClientRegistration,
  issueClientCredentialsToken,
} from "../../src/oauth";
import { MemoryAuthStore } from "../../src/store/memory";
import type { AittaDBApp } from "../../src/handler";
import type { AppConfig, ClientView, RuntimeEnv } from "../../src/types";
import {
  cookieValue,
  createTestAittaDB,
  form,
  testEnv,
  testIdentityProvider,
} from "../helpers";

const ISSUER = "https://aittadb.example.test";
const ACCEPT = BOUNDED_RECORD_MEDIA_TYPE;
const ENTRY = `${ISSUER}/storage/record-protocol`;
const RECORDS = `${ENTRY}/records`;
const TRANSACTIONS = `${ENTRY}/transactions`;

test("bounded record discovery is public, exact, and D1-free", async () => {
  const env = await testEnv();
  const app = createAittaDBWithStore(
    env,
    null,
    undefined,
    undefined,
    testIdentityProvider(null),
  );
  const response = await requiredResponse(
    app.fetch(new Request(ENTRY, { headers: { accept: ACCEPT } })),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), ACCEPT);
  const document = (await response.json()) as DiscoveryDocument;
  assert.equal(document.type, "bounded-record-storage");
  assert.equal(document.data.protocol_version, "1.1");
  assert.deepEqual(document.data.capabilities, BOUNDED_RECORD_CAPABILITIES);
  assert.deepEqual(
    document.actions.map((action) => action.name),
    ["read-record", "list-records", "transact-records"],
  );
  assert.deepEqual(
    document.actions.find((action) => action.name === "transact-records")
      ?.authorization.scopes,
    ["storage.read", "storage.write", "storage.delete"],
  );
  assert.equal(document.data.limits.max_page_size, 100);
  assert.equal(document.data.limits.max_transaction_mutations, 25);
  assert.ok(document.data.limits.max_record_bytes > 0);
  assert.ok(document.data.limits.max_transaction_bytes > 0);
  assert.ok(document.data.limits.max_cursor_length > 0);
});

test("strict protocol clients receive the exact versioned media type", async () => {
  const fixture = await protocolFixture();
  const discovery = await requiredResponse(
    fixture.app.fetch(new Request(ENTRY, { headers: { accept: ACCEPT } })),
  );
  assert.equal(discovery.headers.get("content-type"), ACCEPT);

  const transactionResponse = await fixture.postTransaction(
    transaction("operation:strict-media", [
      mutation("put", "settings", "strict", null, { accepted: true }),
    ]),
  );
  assert.equal(transactionResponse.status, 200);
  assert.equal(transactionResponse.headers.get("content-type"), ACCEPT);

  for (const response of [
    await fixture.get(`${RECORDS}/settings/strict`),
    await fixture.get(`${RECORDS}?collection=settings&limit=100`),
    await fixture.get(`${RECORDS}/settings/missing`),
  ]) {
    assert.equal(response.headers.get("content-type"), ACCEPT);
  }

  const compatible = await requiredResponse(
    fixture.app.fetch(
      new Request(ENTRY, { headers: { accept: "application/json" } }),
    ),
  );
  assert.equal(
    compatible.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
});

test("service credentials execute and replay mixed bounded record operations", async () => {
  const fixture = await protocolFixture();
  const create = transaction("operation:create", [
    mutation("check", "settings", "missing", null),
    mutation("put", "settings", "alpha", null, { enabled: true }),
    mutation("put", "settings", "beta", null, { enabled: false }),
    mutation("put", "settings", "gamma", null, { enabled: true }),
  ]);

  const first = await fixture.postTransaction(create);
  assert.equal(first.status, 200);
  const firstDocument = (await first.json()) as TransactionDocument;
  assert.equal(firstDocument.data.replayed, false);
  assert.equal(firstDocument.data.records.length, 4);
  assert.equal(firstDocument.data.records[0], null);
  assert.equal(firstDocument.data.records[1]?.revision, 1);

  const replay = await fixture.postTransaction(create);
  assert.equal(replay.status, 200);
  const replayDocument = (await replay.json()) as TransactionDocument;
  assert.equal(replayDocument.data.replayed, true);
  assert.deepEqual(replayDocument.data.records, firstDocument.data.records);

  const changed = await fixture.postTransaction(
    transaction("operation:create", [
      mutation("check", "settings", "different", null),
    ]),
  );
  await assertFixedError(changed, 409, "conflict");

  const read = await fixture.get(`${RECORDS}/settings/alpha`);
  assert.equal(read.status, 200);
  const record = (await read.json()) as RecordDocument;
  assert.deepEqual(record.data.value, { enabled: true });
  assert.equal(record.data.revision, 1);

  const update = await fixture.postTransaction(
    transaction("operation:update", [
      mutation("check", "settings", "alpha", 1),
      mutation("put", "settings", "beta", 1, { enabled: true }),
      mutation("delete", "settings", "gamma", 1),
    ]),
  );
  assert.equal(update.status, 200);
  const updated = (await update.json()) as TransactionDocument;
  assert.equal(updated.data.records[0]?.revision, 1);
  assert.equal(updated.data.records[1]?.revision, 2);
  assert.equal(updated.data.records[2], null);

  const stale = await fixture.postTransaction(
    transaction("operation:stale", [
      mutation("put", "settings", "beta", 1, { enabled: false }),
    ]),
  );
  await assertFixedError(stale, 412, "precondition_failed");
});

test("bounded pages are deterministic and cursors are namespace-bound", async () => {
  const first = await protocolFixture();
  await first.postTransaction(
    transaction("operation:page", [
      mutation("put", "items", "a", null, { order: 1 }),
      mutation("put", "items", "b", null, { order: 2 }),
    ]),
  );
  const pageOne = await first.get(`${RECORDS}?collection=items&limit=1`);
  assert.equal(pageOne.status, 200);
  const firstPage = (await pageOne.json()) as PageDocument;
  assert.deepEqual(
    firstPage.data.items.map((item) => item.key.id),
    ["a"],
  );
  assert.ok(firstPage.data.next_cursor);
  const next = firstPage.links.find((link) => link.rel.includes("next"));
  assert.ok(next);

  const pageTwo = await first.get(next.href);
  assert.equal(pageTwo.status, 200);
  const secondPage = (await pageTwo.json()) as PageDocument;
  assert.deepEqual(
    secondPage.data.items.map((item) => item.key.id),
    ["b"],
  );
  assert.equal(secondPage.data.next_cursor, null);

  const second = await protocolFixture(first.env, first.store);
  const isolated = await second.get(`${RECORDS}?collection=items&limit=1`);
  assert.equal(isolated.status, 200);
  assert.deepEqual(((await isolated.json()) as PageDocument).data.items, []);

  const substituted = await second.get(next.href);
  await assertFixedError(substituted, 400, "invalid_request");

  const firstMissing = await first.get(`${RECORDS}/items/missing`);
  const secondMissing = await second.get(`${RECORDS}/items/a`);
  assert.equal(await firstMissing.text(), await secondMissing.text());
});

test("authorization and strict request decoding fail without disclosure", async () => {
  const fixture = await protocolFixture();
  const malformedWithoutToken = await requiredResponse(
    fixture.app.fetch(
      new Request(TRANSACTIONS, {
        method: "POST",
        headers: { accept: ACCEPT, "content-type": "application/json" },
        body: "not-json",
      }),
    ),
  );
  assert.equal(malformedWithoutToken.status, 401);
  assert.equal(
    ((await malformedWithoutToken.json()) as { error: string }).error,
    "invalid_token",
  );

  const malformed = await fixture.postRaw("not-json");
  const malformedCopy = malformed.clone();
  await assertFixedError(malformed, 400, "invalid_request");
  const duplicateKey = await fixture.postTransaction({
    transaction: {
      operation_id: "operation:duplicate",
      mutations: [
        mutation("check", "settings", "same", null),
        mutation("check", "settings", "same", null),
      ],
    },
  });
  await assertFixedError(duplicateKey, 400, "invalid_request");

  const readOnly = await protocolFixture(undefined, undefined, [
    "storage.read",
  ]);
  const denied = await readOnly.postTransaction(
    transaction("operation:denied", [
      mutation("check", "settings", "missing", null),
    ]),
  );
  assert.equal(denied.status, 403);
  assert.equal(
    ((await denied.json()) as { error: string }).error,
    "insufficient_scope",
  );

  const oversized = await requiredResponse(
    fixture.app.fetch(
      new Request(TRANSACTIONS, {
        method: "POST",
        headers: {
          accept: ACCEPT,
          authorization: `Bearer ${fixture.token}`,
          "content-length": String(BOUNDED_RECORD_MAX_TRANSACTION_BYTES + 1),
          "content-type": "application/json",
        },
        body: "{}",
      }),
    ),
  );
  await assertFixedError(oversized, 400, "invalid_request");
  assert.doesNotMatch(await malformedCopy.text(), /not-json|operation:/);
});

test("current ChatGPT Sites session drives real HTML record operations with CSRF", async () => {
  const env = await testEnv();
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store);
  const discovery = await requiredResponse(
    app.fetch(new Request(ENTRY, { headers: { accept: "text/html" } })),
  );
  assert.equal(discovery.status, 200);
  const csrf = cookieValue(discovery, "aittadb_csrf");
  const discoveryHtml = await discovery.text();
  assert.match(discoveryHtml, /Use the current signed-in session/);
  assert.match(discoveryHtml, /Run transaction/);
  assert.doesNotMatch(discoveryHtml, /access_token|Bearer ey/);

  const command = transaction("browser:create", [
    mutation("put", "settings", "browser", null, {
      marker: "private-payload-47",
    }),
  ]);
  const rejected = await requiredResponse(
    app.fetch(browserTransactionRequest(command, "wrong-csrf", csrf)),
  );
  assert.equal(rejected.status, 403);
  assert.match(rejected.headers.get("content-type") ?? "", /^text\/html/);
  assert.doesNotMatch(
    await rejected.text(),
    /browser:create|private-payload-47/,
  );

  const accepted = await requiredResponse(
    app.fetch(browserTransactionRequest(command, csrf, csrf)),
  );
  assert.equal(accepted.status, 200);
  const resultHtml = await accepted.text();
  assert.match(resultHtml, /Record transaction result/);
  assert.match(resultHtml, /browser\/settings|settings\/browser/);
  assert.doesNotMatch(resultHtml, /access_token|Bearer ey/);

  const item = await requiredResponse(
    app.fetch(
      new Request(`${RECORDS}/settings/browser`, {
        headers: { accept: "text/html" },
      }),
    ),
  );
  assert.equal(item.status, 200);
  assert.match(await item.text(), /Record details/);

  const anonymous = createTestAittaDB(env, store, null);
  const signedOut = await requiredResponse(
    anonymous.fetch(
      new Request(`${RECORDS}/settings/browser`, {
        headers: { accept: "text/html" },
      }),
    ),
  );
  assert.equal(signedOut.status, 302);
  assert.match(
    signedOut.headers.get("location") ?? "",
    /\/signin-with-chatgpt\?return_to=/,
  );
});

test("signed-in initial record list form submits a canonical collection GET", async () => {
  const env = await testEnv();
  const app = createTestAittaDB(env, new MemoryAuthStore());
  const discovery = await requiredResponse(
    app.fetch(new Request(ENTRY, { headers: { accept: "text/html" } })),
  );
  const discoveryHtml = await discovery.text();
  const listForm = discoveryHtml.match(
    /<section class="resource-operation" aria-labelledby="record-list-heading">[\s\S]*?<\/form>/,
  )?.[0];
  assert.ok(listForm);
  assert.match(listForm, /action="\/storage\/record-protocol\/records"/);
  assert.doesNotMatch(listForm, /name="cursor"/);

  const firstPage = await requiredResponse(
    app.fetch(
      new Request(`${RECORDS}?collection=items&limit=100`, {
        headers: { accept: "text/html" },
      }),
    ),
  );
  assert.equal(firstPage.status, 200);
  assert.match(firstPage.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(
    await firstPage.text(),
    /No records found in <code>items<\/code>/,
  );

  const explicitEmptyCursor = await requiredResponse(
    app.fetch(
      new Request(`${RECORDS}?collection=items&limit=100&cursor=`, {
        headers: { accept: ACCEPT },
      }),
    ),
  );
  await assertFixedError(explicitEmptyCursor, 400, "invalid_request");
});

test("bounded record routes enforce exact client CORS and feature availability", async () => {
  const fixture = await protocolFixture();
  const rejected = await requiredResponse(
    fixture.app.fetch(
      new Request(`${RECORDS}?collection=settings&limit=100`, {
        headers: {
          accept: ACCEPT,
          authorization: `Bearer ${fixture.token}`,
          origin: "https://foreign.example.test",
        },
      }),
    ),
  );
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get("access-control-allow-origin"), null);

  const disabledEnv = await testEnv({ FEATURE_RECORDS_ENABLED: "false" });
  const observed = new ObservedBoundedStore();
  const disabled = createTestAittaDB(disabledEnv, observed, null);
  for (const request of [
    new Request(ENTRY, { headers: { accept: ACCEPT } }),
    new Request(`${RECORDS}?collection=settings&limit=100`, {
      headers: { accept: ACCEPT, authorization: "Bearer invalid" },
    }),
    new Request(TRANSACTIONS, {
      method: "POST",
      headers: {
        accept: ACCEPT,
        authorization: "Bearer invalid",
        "content-type": "application/json",
      },
      body: "{}",
    }),
  ]) {
    const response = await requiredResponse(disabled.fetch(request));
    assert.equal(response.status, 503);
  }
  assert.deepEqual(observed.boundedCalls, []);
});

interface ProtocolFixture {
  env: RuntimeEnv;
  config: AppConfig;
  store: MemoryAuthStore;
  app: AittaDBApp;
  client: ClientView;
  token: string;
  get(href: string): Promise<Response>;
  postRaw(body: string): Promise<Response>;
  postTransaction(value: unknown): Promise<Response>;
}

async function protocolFixture(
  existingEnv?: RuntimeEnv,
  existingStore?: MemoryAuthStore,
  scopes = ["storage.read", "storage.write", "storage.delete"],
): Promise<ProtocolFixture> {
  const env = existingEnv ?? (await testEnv());
  const config = loadConfig(env, ISSUER);
  const store = existingStore ?? new MemoryAuthStore();
  const registration = await createClientRegistration(
    {
      type: "service",
      name: `bounded record service ${crypto.randomUUID()}`,
      redirectUris: [],
      scopes,
      origins: [],
    },
    store,
    nowSeconds(),
  );
  const tokenResponse = await issueClientCredentialsToken({
    config,
    store,
    client: registration.client,
    requestedScope: scopes.join(" "),
    now: nowSeconds(),
  });
  assert.equal(tokenResponse.status, 200);
  const token = String(
    ((await tokenResponse.json()) as { access_token: string }).access_token,
  );
  const app = createTestAittaDB(env, store);
  const authorized = (href: string, init: RequestInit = {}) =>
    requiredResponse(
      app.fetch(
        new Request(href, {
          ...init,
          headers: {
            accept: ACCEPT,
            authorization: `Bearer ${token}`,
            ...(init.headers ?? {}),
          },
        }),
      ),
    );
  return {
    env,
    config,
    store,
    app,
    client: registration.client,
    token,
    get: (href) => authorized(href),
    postRaw: (body) =>
      authorized(TRANSACTIONS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    postTransaction: (value) =>
      authorized(TRANSACTIONS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      }),
  };
}

class ObservedBoundedStore extends MemoryAuthStore {
  readonly boundedCalls: string[] = [];

  override async getBoundedStorageRecord(
    ...args: Parameters<MemoryAuthStore["getBoundedStorageRecord"]>
  ) {
    this.boundedCalls.push("get");
    return super.getBoundedStorageRecord(...args);
  }

  override async listBoundedStorageRecords(
    ...args: Parameters<MemoryAuthStore["listBoundedStorageRecords"]>
  ) {
    this.boundedCalls.push("list");
    return super.listBoundedStorageRecords(...args);
  }

  override async transactBoundedStorageRecords(
    ...args: Parameters<MemoryAuthStore["transactBoundedStorageRecords"]>
  ) {
    this.boundedCalls.push("transact");
    return super.transactBoundedStorageRecords(...args);
  }
}

function transaction(operationId: string, mutations: unknown[]) {
  return { transaction: { operation_id: operationId, mutations } };
}

function mutation(
  type: "put" | "delete" | "check",
  collection: string,
  id: string,
  expectedRevision: number | null,
  value?: Record<string, unknown>,
) {
  return {
    type,
    key: { collection, id },
    expected_revision: expectedRevision,
    ...(type === "put" ? { value } : {}),
  };
}

function browserTransactionRequest(
  command: unknown,
  submittedCsrf: string,
  cookieCsrf: string,
): Request {
  return new Request(TRANSACTIONS, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      cookie: `aittadb_csrf=${cookieCsrf}`,
      origin: ISSUER,
      "sec-fetch-site": "same-origin",
    },
    body: form({
      csrf_token: submittedCsrf,
      transaction: JSON.stringify(command),
    }),
  });
}

async function assertFixedError(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  assert.equal(response.status, status);
  const text = await response.text();
  const document = JSON.parse(text) as {
    type: string;
    data: { code: string; message: string };
    links: unknown[];
    actions: unknown[];
  };
  assert.equal(document.type, "bounded-storage-error");
  assert.equal(document.data.code, code);
  assert.deepEqual(document.links, []);
  assert.deepEqual(document.actions, []);
  assert.doesNotMatch(text, /credential|Bearer|operation:|cursor|quota state/);
}

async function requiredResponse(
  response: Promise<Response | null>,
): Promise<Response> {
  const resolved = await response;
  assert.ok(resolved);
  return resolved;
}

interface DiscoveryDocument {
  type: string;
  data: {
    protocol_version: string;
    capabilities: readonly string[];
    limits: {
      max_record_bytes: number;
      max_page_size: number;
      max_transaction_mutations: number;
      max_transaction_bytes: number;
      max_cursor_length: number;
    };
  };
  actions: Array<{
    name: string;
    authorization: { scopes: string[] };
  }>;
}

interface RecordValue {
  key: { collection: string; id: string };
  revision: number;
  value: Record<string, unknown>;
}

interface RecordDocument {
  data: RecordValue;
}

interface TransactionDocument {
  data: {
    replayed: boolean;
    records: Array<RecordValue | null>;
  };
}

interface PageDocument {
  data: {
    items: RecordValue[];
    next_cursor: string | null;
  };
  links: Array<{ rel: string[]; href: string }>;
}
