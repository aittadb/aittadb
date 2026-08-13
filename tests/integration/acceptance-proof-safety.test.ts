import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { createAittaDBWithStore } from "../../src/handler";
import { BOUNDED_RECORD_MEDIA_TYPE } from "../../src/bounded-record-protocol";
import { ACCEPTANCE_PROOF_SAFETY_PATH } from "../../src/proof-safety";
import { testEnv } from "../helpers";

const ISSUER = "https://test.aittadb.com";
const TRANSPORT_ORIGIN = "https://worker-transport.example.test";
const CHALLENGE = "5c9f2936-1ca2-4d85-87f4-3e9bfd2c30cb";

test("acceptance proof-safety assertion is exact, issuer-bound, and state-free", async () => {
  const env = await enabledEnv();
  const scheduled: Promise<unknown>[] = [];
  let identityReads = 0;
  const app = createAittaDBWithStore(
    env,
    null,
    undefined,
    {
      waitUntil(promise) {
        scheduled.push(promise);
      },
    },
    {
      read() {
        identityReads += 1;
        throw new Error("proof safety must not inspect Sites identity");
      },
    },
  );

  const response = await requiredResponse(
    app.fetch(
      new Request(
        `${TRANSPORT_ORIGIN}${ACCEPTANCE_PROOF_SAFETY_PATH}?challenge=${CHALLENGE}`,
        { headers: { accept: BOUNDED_RECORD_MEDIA_TYPE } },
      ),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), BOUNDED_RECORD_MEDIA_TYPE);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Accept");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const document = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(document), [
    "api_version",
    "type",
    "id",
    "data",
    "links",
    "actions",
  ]);
  assert.equal(document.api_version, "0.1");
  assert.equal(document.type, "acceptance-proof-safety");
  assert.equal(
    document.id,
    `${ISSUER}${ACCEPTANCE_PROOF_SAFETY_PATH}?challenge=${CHALLENGE}`,
  );
  assert.deepEqual(document.data, {
    challenge: CHALLENGE,
    environment: "disposable-acceptance",
    issuer: ISSUER,
    storage_contract_proofs: "allowed",
  });
  assert.deepEqual(document.links, []);
  assert.deepEqual(document.actions, []);
  assert.equal(identityReads, 0);
  assert.deepEqual(scheduled, []);
});

test("proof-safety assertion fails closed before body, identity, storage, or cleanup work", async () => {
  const env = await enabledEnv();
  const scheduled: Promise<unknown>[] = [];
  let identityReads = 0;
  const app = createAittaDBWithStore(
    env,
    null,
    undefined,
    {
      waitUntil(promise) {
        scheduled.push(promise);
      },
    },
    {
      read() {
        identityReads += 1;
        throw new Error("proof safety must not inspect Sites identity");
      },
    },
  );
  const invalidRequests = [
    new Request(`${ISSUER}${ACCEPTANCE_PROOF_SAFETY_PATH}`, {
      headers: { accept: BOUNDED_RECORD_MEDIA_TYPE },
    }),
    new Request(
      `${ISSUER}${ACCEPTANCE_PROOF_SAFETY_PATH}?challenge=${CHALLENGE.toUpperCase()}`,
      { headers: { accept: BOUNDED_RECORD_MEDIA_TYPE } },
    ),
    new Request(
      `${ISSUER}${ACCEPTANCE_PROOF_SAFETY_PATH}?challenge=${CHALLENGE}&extra=value`,
      { headers: { accept: BOUNDED_RECORD_MEDIA_TYPE } },
    ),
    new Request(
      `${ISSUER}${ACCEPTANCE_PROOF_SAFETY_PATH}?challenge=${CHALLENGE}&challenge=${CHALLENGE}`,
      { headers: { accept: BOUNDED_RECORD_MEDIA_TYPE } },
    ),
    new Request(
      `${ISSUER}${ACCEPTANCE_PROOF_SAFETY_PATH}?challenge=${CHALLENGE}`,
      { headers: { accept: "application/json" } },
    ),
  ];

  for (const request of invalidRequests) {
    const response = await requiredResponse(app.fetch(request));
    assert.ok([404, 406].includes(response.status));
    assert.notEqual(
      response.headers.get("content-type"),
      BOUNDED_RECORD_MEDIA_TYPE,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "");
  }

  const unsupportedMethod = new Request(
    `${ISSUER}${ACCEPTANCE_PROOF_SAFETY_PATH}?challenge=${CHALLENGE}`,
    {
      method: "POST",
      headers: { accept: BOUNDED_RECORD_MEDIA_TYPE },
      body: "must-not-be-read",
    },
  );
  const methodResponse = await requiredResponse(app.fetch(unsupportedMethod));
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get("allow"), "GET");
  assert.equal(unsupportedMethod.bodyUsed, false);
  assert.equal(identityReads, 0);
  assert.deepEqual(scheduled, []);
});

test("proof-safety setting is default-off and accepts only an eligible deployment", async () => {
  const defaults = await testEnv();
  assert.equal(
    loadConfig(defaults, defaults.ISSUER_URL!).acceptanceProofSafetyEnabled,
    false,
  );

  const enabled = await enabledEnv();
  assert.equal(
    loadConfig(enabled, enabled.ISSUER_URL!).acceptanceProofSafetyEnabled,
    true,
  );
  const hostedAcceptance = await testEnv({
    NODE_ENV: "production",
    DB: {} as D1Database,
    ISSUER_URL: ISSUER,
    FEATURE_OAUTH_APPS_ENABLED: "true",
    ACCEPTANCE_PROOF_SAFETY_ENABLED: "true",
  });
  assert.equal(
    loadConfig(hostedAcceptance, hostedAcceptance.ISSUER_URL!)
      .acceptanceProofSafetyEnabled,
    true,
  );

  for (const extra of [
    { ACCEPTANCE_PROOF_SAFETY_ENABLED: "yes" },
    {
      ISSUER_URL: "https://aittadb.com",
      FEATURE_OAUTH_APPS_ENABLED: "true",
      ACCEPTANCE_PROOF_SAFETY_ENABLED: "true",
    },
    {
      ISSUER_URL: "https://test.aittadb.com.evil.example",
      FEATURE_OAUTH_APPS_ENABLED: "true",
      ACCEPTANCE_PROOF_SAFETY_ENABLED: "true",
    },
    {
      ISSUER_URL: "https://production-test.example.com",
      FEATURE_OAUTH_APPS_ENABLED: "true",
      ACCEPTANCE_PROOF_SAFETY_ENABLED: "true",
    },
    {
      ISSUER_URL: "http://test.aittadb.com",
      FEATURE_OAUTH_APPS_ENABLED: "true",
      ACCEPTANCE_PROOF_SAFETY_ENABLED: "true",
    },
    {
      FEATURE_RECORDS_ENABLED: "false",
      FEATURE_OAUTH_APPS_ENABLED: "true",
      ACCEPTANCE_PROOF_SAFETY_ENABLED: "true",
    },
    {
      FEATURE_OAUTH_APPS_ENABLED: "false",
      ACCEPTANCE_PROOF_SAFETY_ENABLED: "true",
    },
  ]) {
    const env = await testEnv(extra);
    assert.throws(() => loadConfig(env, env.ISSUER_URL!));
  }
});

async function enabledEnv() {
  return testEnv({
    ISSUER_URL: ISSUER,
    FEATURE_OAUTH_APPS_ENABLED: "true",
    ACCEPTANCE_PROOF_SAFETY_ENABLED: "true",
  });
}

async function requiredResponse(
  response: Promise<Response | null>,
): Promise<Response> {
  const value = await response;
  assert.ok(value);
  return value;
}
