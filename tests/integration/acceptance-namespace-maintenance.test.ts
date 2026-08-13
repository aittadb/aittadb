import assert from "node:assert/strict";
import test from "node:test";

import { ACCEPTANCE_NAMESPACE_MAINTENANCE_PATH } from "../../src/acceptance-namespace-maintenance";
import { loadConfig } from "../../src/config";
import { nowSeconds } from "../../src/crypto";
import { createAittaDBWithStore } from "../../src/handler";
import { MemoryAuthStore } from "../../src/store/memory";
import type { RuntimeEnv, UpstreamIdentity } from "../../src/types";
import { cookieValue, createTestAittaDB, form, testEnv } from "../helpers";

const ISSUER = "https://test.aittadb.com";
const HYPERMEDIA = "application/vnd.aittadb+json; version=0.1";
const ENDPOINT = `${ISSUER}${ACCEPTANCE_NAMESPACE_MAINTENANCE_PATH}`;
const TARGET_PREFIX = "proof-0123456789abcdef01234567-";

interface MaintenanceAction {
  name: string;
  fields: Array<{
    name: string;
    value?: unknown;
    secret?: boolean;
    min_length?: number;
    max_length?: number;
    pattern?: string;
    options?: Array<{ value: string; title: string }>;
  }>;
}

interface MaintenanceDocument {
  type: string;
  data: {
    max_rows: number;
    eligible_service_client_count: number;
    operation_result?: {
      deleted_records: number;
      deleted_transaction_receipts: number;
      remaining_records: number;
      remaining_transaction_receipts: number;
    };
  };
  actions: MaintenanceAction[];
}

interface Fixture {
  app: ReturnType<typeof createTestAittaDB>;
  env: RuntimeEnv;
  identity: UpstreamIdentity;
  store: MemoryAuthStore;
  serviceClientId: string;
  outsiderClientId: string;
}

test("acceptance namespace maintenance is default-off and fails before identity work", async () => {
  const env = await testEnv({
    ISSUER_URL: ISSUER,
    FEATURE_OAUTH_APPS_ENABLED: "true",
  });
  assert.equal(
    loadConfig(env, env.ISSUER_URL!).acceptanceNamespaceMaintenanceEnabled,
    false,
  );
  let identityReads = 0;
  const app = createAittaDBWithStore(env, null, undefined, undefined, {
    read() {
      identityReads += 1;
      throw new Error("disabled maintenance must not read identity");
    },
  });
  const response = await requiredResponse(
    app.fetch(new Request(ENDPOINT, { headers: { accept: HYPERMEDIA } })),
  );
  assert.equal(response.status, 503);
  assert.equal(identityReads, 0);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);

  const unsupportedIssuer = await testEnv({
    ISSUER_URL: "https://other-acceptance.example.test",
    FEATURE_OAUTH_APPS_ENABLED: "true",
    ACCEPTANCE_NAMESPACE_MAINTENANCE_ENABLED: "true",
  });
  assert.throws(
    () => loadConfig(unsupportedIssuer, unsupportedIssuer.ISSUER_URL!),
    /ACCEPTANCE_NAMESPACE_MAINTENANCE_ENABLED requires a recognized non-production HTTPS issuer/,
  );
  const missingOAuth = await testEnv({
    ISSUER_URL: ISSUER,
    ACCEPTANCE_NAMESPACE_MAINTENANCE_ENABLED: "true",
  });
  assert.throws(
    () => loadConfig(missingOAuth, missingOAuth.ISSUER_URL!),
    /ACCEPTANCE_NAMESPACE_MAINTENANCE_ENABLED requires a recognized non-production HTTPS issuer/,
  );
});

test("acceptance maintenance exposes equivalent HTML and hypermedia controls only to an allowlisted session", async () => {
  const fixture = await maintenanceFixture();
  const json = await requiredResponse(
    fixture.app.fetch(
      new Request(ENDPOINT, { headers: { accept: HYPERMEDIA } }),
    ),
  );
  assert.equal(json.status, 200);
  const document = (await json.json()) as MaintenanceDocument;
  assert.equal(document.type, "acceptance-namespace-maintenance");
  assert.equal(document.data.max_rows, 100);
  assert.equal(document.data.eligible_service_client_count, 2);
  const action = maintenanceAction(document);
  assert.deepEqual(
    action.fields.map((entry) => entry.name),
    [
      "csrf_token",
      "submission_token",
      "service_client_id",
      "collection_prefix",
    ],
  );
  assert.equal(field(action, "csrf_token")?.secret, true);
  assert.equal(field(action, "submission_token")?.secret, true);
  assert.deepEqual(
    {
      min_length: field(action, "collection_prefix")?.min_length,
      max_length: field(action, "collection_prefix")?.max_length,
      pattern: field(action, "collection_prefix")?.pattern,
    },
    {
      min_length: 31,
      max_length: 31,
      pattern: "^proof-[a-f0-9]{24}-$",
    },
  );
  assert.equal(
    field(action, "service_client_id")?.options?.some(
      (option) => option.value === fixture.serviceClientId,
    ),
    true,
  );
  assert.doesNotMatch(JSON.stringify(document), /0123456789abcdef/);

  const html = await requiredResponse(
    fixture.app.fetch(
      new Request(ENDPOINT, { headers: { accept: "text/html" } }),
    ),
  );
  assert.equal(html.status, 200);
  const body = await html.text();
  assert.match(
    body,
    new RegExp(`action="${ACCEPTANCE_NAMESPACE_MAINTENANCE_PATH}"`),
  );
  assert.match(body, /name="service_client_id"/);
  assert.match(body, /name="collection_prefix"/);
  assert.doesNotMatch(body, /0123456789abcdef/);

  const unlisted = createTestAittaDB(fixture.env, fixture.store, {
    email: "unlisted@example.test",
    fullName: null,
    displayName: "Unlisted",
  });
  const denied = await requiredResponse(
    unlisted.fetch(new Request(ENDPOINT, { headers: { accept: HYPERMEDIA } })),
  );
  assert.equal(denied.status, 403);
});

test("acceptance maintenance rejects browser forgery and purges only the selected service namespace", async () => {
  const fixture = await maintenanceFixture();
  const page = await requiredResponse(
    fixture.app.fetch(
      new Request(ENDPOINT, { headers: { accept: HYPERMEDIA } }),
    ),
  );
  const csrf = cookieValue(page, "aittadb_csrf");
  const document = (await page.json()) as MaintenanceDocument;
  const action = maintenanceAction(document);
  const submissionToken = String(field(action, "submission_token")?.value);
  const requestBody = {
    csrf_token: csrf,
    submission_token: submissionToken,
    service_client_id: fixture.serviceClientId,
    collection_prefix: TARGET_PREFIX,
  };

  const invalidPrefix = await post(fixture, {
    ...requestBody,
    collection_prefix: "too-short-",
  });
  assert.equal(invalidPrefix.status, 400);
  const nonProofPrefix = await post(fixture, {
    ...requestBody,
    collection_prefix: "archive-0123456789abcdef01234567-",
  });
  assert.equal(nonProofPrefix.status, 400);
  assert.ok(
    await fixture.store.getBoundedStorageRecord(
      fixture.serviceClientId,
      fixture.serviceClientId,
      `${TARGET_PREFIX}records`,
      "target",
    ),
  );

  const forged = await post(
    fixture,
    {
      ...requestBody,
      csrf_token: "incorrect",
    },
    csrf,
  );
  assert.equal(forged.status, 403);
  assert.ok(
    await fixture.store.getBoundedStorageRecord(
      fixture.serviceClientId,
      fixture.serviceClientId,
      `${TARGET_PREFIX}records`,
      "target",
    ),
  );

  const foreignOrigin = await requiredResponse(
    fixture.app.fetch(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          accept: HYPERMEDIA,
          "content-type": "application/x-www-form-urlencoded",
          cookie: `aittadb_csrf=${csrf}`,
          origin: "https://foreign.example.test",
        },
        body: form(requestBody),
      }),
    ),
  );
  assert.equal(foreignOrigin.status, 403);

  const completed = await post(fixture, requestBody);
  assert.equal(completed.status, 200);
  const result = (await completed.json()) as MaintenanceDocument;
  assert.deepEqual(result.data.operation_result, {
    deleted_records: 1,
    deleted_transaction_receipts: 1,
    remaining_records: 0,
    remaining_transaction_receipts: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), /0123456789abcdef/);
  assert.equal(
    await fixture.store.getBoundedStorageRecord(
      fixture.serviceClientId,
      fixture.serviceClientId,
      `${TARGET_PREFIX}records`,
      "target",
    ),
    null,
  );
  assert.ok(
    await fixture.store.getBoundedStorageRecord(
      fixture.serviceClientId,
      fixture.serviceClientId,
      "unrelated-records",
      "retain",
    ),
  );
  assert.ok(
    await fixture.store.getBoundedStorageRecord(
      fixture.outsiderClientId,
      fixture.outsiderClientId,
      `${TARGET_PREFIX}records`,
      "outsider",
    ),
  );
  assert.deepEqual(fixture.store.audits.at(-1)?.data, {
    deleted_records: 1,
    deleted_transaction_receipts: 1,
    identity_source: "subject",
  });

  const replay = await post(fixture, requestBody);
  assert.equal(replay.status, 409);
});

async function maintenanceFixture(): Promise<Fixture> {
  const baseEnv = await testEnv({
    ISSUER_URL: ISSUER,
    FEATURE_OAUTH_APPS_ENABLED: "true",
    ACCEPTANCE_NAMESPACE_MAINTENANCE_ENABLED: "true",
  });
  const store = new MemoryAuthStore();
  const identity: UpstreamIdentity = {
    email: "maintenance-admin@example.test",
    fullName: "Maintenance Admin",
    displayName: "Maintenance Admin",
  };
  const admin = await store.findOrCreateUser(identity, nowSeconds());
  const env = { ...baseEnv, ADMIN_SUBJECTS: admin.id };
  const config = loadConfig(env, env.ISSUER_URL!);
  const service = await store.createClient(
    {
      type: "service",
      name: "Disposable proof owner",
      redirectUris: [],
      scopes: ["storage.read", "storage.write", "storage.delete"],
      origins: [],
    },
    "synthetic-service-secret-hash",
    nowSeconds(),
  );
  const outsider = await store.createClient(
    {
      type: "service",
      name: "Disposable proof outsider",
      redirectUris: [],
      scopes: ["storage.read"],
      origins: [],
    },
    "synthetic-outsider-secret-hash",
    nowSeconds(),
  );
  await putRecord(
    store,
    service.id,
    `${TARGET_PREFIX}records`,
    "target",
    "maintenance-target",
    config,
  );
  await putRecord(
    store,
    service.id,
    "unrelated-records",
    "retain",
    "maintenance-unrelated",
    config,
  );
  await putRecord(
    store,
    outsider.id,
    `${TARGET_PREFIX}records`,
    "outsider",
    "maintenance-outsider",
    config,
  );
  return {
    env,
    store,
    identity,
    serviceClientId: service.id,
    outsiderClientId: outsider.id,
    app: createTestAittaDB(env, store, identity),
  };
}

async function putRecord(
  store: MemoryAuthStore,
  clientId: string,
  collection: string,
  id: string,
  operationId: string,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const result = await store.transactBoundedStorageRecords(
    clientId,
    clientId,
    {
      transaction: {
        operation_id: operationId,
        mutations: [
          {
            type: "put",
            key: { collection, id },
            expected_revision: null,
            value: { retained: true },
          },
        ],
      },
    },
    config.storageLimits,
    nowSeconds(),
    {
      receiptRetentionSeconds: config.boundedRecordReceiptRetentionSeconds,
      receiptLimits: config.boundedRecordReceiptLimits,
    },
  );
  assert.equal(result.status, "created");
}

async function post(
  fixture: Fixture,
  body: Record<string, string>,
  csrfCookieToken = body.csrf_token,
): Promise<Response> {
  return requiredResponse(
    fixture.app.fetch(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          accept: HYPERMEDIA,
          "content-type": "application/x-www-form-urlencoded",
          cookie: `aittadb_csrf=${csrfCookieToken}`,
          origin: ISSUER,
        },
        body: form(body),
      }),
    ),
  );
}

function maintenanceAction(document: MaintenanceDocument): MaintenanceAction {
  const action = document.actions.find(
    (candidate) => candidate.name === "purge-bounded-service-namespace",
  );
  assert.ok(action);
  return action;
}

function field(action: MaintenanceAction, name: string) {
  return action.fields.find((entry) => entry.name === name);
}

async function requiredResponse(
  value: Promise<Response | null>,
): Promise<Response> {
  const response = await value;
  assert.ok(response);
  return response;
}
