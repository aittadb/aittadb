import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config";
import { nowSeconds, sha256 } from "../../src/crypto";
import { createClientRegistration, issueTokens } from "../../src/oauth";
import { MemoryAuthStore } from "../../src/store/memory";
import type { RuntimeEnv, UpstreamIdentity } from "../../src/types";
import { cookieValue, createTestAittaDB, form, testEnv } from "../helpers";

const ISSUER = "https://aittadb.example.test";
const HYPERMEDIA = "application/vnd.aittadb+json; version=0.1";

interface AdminAction {
  name: string;
  title: string;
  method: string;
  href: string;
  type?: string;
  authorization?: { scheme: string };
  fields: Array<{ name: string; value?: unknown; secret?: boolean }>;
}

interface AdminDocument {
  api_version: string;
  type: string;
  data: {
    clients: Array<{
      id: string;
      name: string;
      type: "public" | "confidential";
      disabled: boolean;
    }>;
    new_client_secret_client_id?: string;
    new_client_secret?: string;
    secret_displayed_once?: true;
    operation_result?: { operation: string; client_id: string };
  };
  links: Array<{ rel: string[]; href: string }>;
  actions: AdminAction[];
}

interface AdminFixture {
  env: RuntimeEnv;
  store: MemoryAuthStore;
  identity: UpstreamIdentity;
  userId: string;
  app: ReturnType<typeof createTestAittaDB>;
}

test("admin HTML and hypermedia expose the same state- and type-aware controls", async () => {
  const fixture = await adminFixture();
  const activePublic = await createClientRegistration(
    registration("Active public", "public"),
    fixture.store,
    nowSeconds(),
  );
  const activeConfidential = await createClientRegistration(
    registration("Active confidential", "confidential"),
    fixture.store,
    nowSeconds(),
  );
  const disabledConfidential = await createClientRegistration(
    registration("Disabled confidential", "confidential"),
    fixture.store,
    nowSeconds(),
  );
  await fixture.store.setClientDisabled(
    disabledConfidential.client.id,
    nowSeconds(),
  );

  const jsonResponse = await fixture.app.fetch(
    new Request(`${ISSUER}/admin/clients`, {
      headers: { accept: HYPERMEDIA },
    }),
  );
  assert.equal(jsonResponse?.status, 200);
  assert.match(
    jsonResponse!.headers.get("content-type") ?? "",
    /^application\/vnd\.aittadb\+json; version=0\.1/,
  );
  assert.equal(jsonResponse!.headers.get("aittadb-api-version"), "0.1");
  assert.equal(jsonResponse!.headers.get("cache-control"), "no-store");
  const document = (await jsonResponse!.json()) as AdminDocument;
  assert.equal(document.api_version, "0.1");
  assert.equal(document.type, "oauth-client-collection");
  assert.ok(document.actions.some((action) => action.name === "create-client"));
  const jsonSubmission = documentSubmissionToken(document);
  assert.ok(
    document.actions.every(
      (action) => fieldValue(action, "submission_token") === jsonSubmission,
    ),
  );

  const htmlResponse = await fixture.app.fetch(
    new Request(`${ISSUER}/admin/clients`, {
      headers: { accept: "text/html" },
    }),
  );
  assert.equal(htmlResponse?.status, 200);
  const html = await htmlResponse!.text();
  assert.match(html, /<button type="submit">Create client<\/button>/);
  assert.match(htmlSubmissionToken(html), /^[A-Za-z0-9_-]{32}$/);

  for (const [clientId, expected] of [
    [activePublic.client.id, ["disable", "revoke_grants"]],
    [
      activeConfidential.client.id,
      ["disable", "rotate_secret", "revoke_grants"],
    ],
    [
      disabledConfidential.client.id,
      ["enable", "rotate_secret", "revoke_grants"],
    ],
  ] as const) {
    assert.deepEqual(jsonOperations(document, clientId), [...expected].sort());
    assert.deepEqual(htmlOperations(html, clientId), [...expected].sort());
  }

  for (const secret of [
    activeConfidential.secret,
    disabledConfidential.secret,
  ]) {
    assert.ok(secret);
    assert.doesNotMatch(JSON.stringify(document), new RegExp(secret));
    assert.doesNotMatch(html, new RegExp(secret));
  }
});

test("confidential create and rotation reveal a client-bound secret only once", async () => {
  const fixture = await adminFixture();
  const page = await adminGet(fixture, "text/html");
  const csrf = cookieValue(page, "aittadb_csrf");
  const pageHtml = await page.text();
  const createSubmission = htmlSubmissionToken(pageHtml);
  const createInput = {
    name: "One-time confidential",
    type: "confidential",
    redirect_uris: "https://client.example.test/callback",
    scopes: "openid offline_access",
    origins: "https://client.example.test",
  };
  const created = await adminPost(
    fixture,
    csrf,
    createSubmission,
    createInput,
    "text/html",
  );
  assert.equal(created.status, 303);
  assert.equal(created.headers.get("location"), "/admin/clients");
  assert.equal(await created.text(), "");
  const createFlash = cookieValue(created, "aittadb_admin_result");
  assert.doesNotMatch(createFlash, /One-time|confidential|client\.example/);
  const createdClients = await fixture.store.listClients();
  const createdClient = createdClients.find(
    (client) => client.name === "One-time confidential",
  );
  assert.ok(createdClient);
  assert.equal(createdClients.length, 1);

  const createdResult = await adminGet(
    fixture,
    "text/html",
    `aittadb_csrf=${csrf}; aittadb_admin_result=${createFlash}`,
  );
  const createdHtml = await createdResult.text();
  assert.match(createdHtml, new RegExp(createdClient.id));
  const createdSecret = oneTimeSecret(createdHtml);
  assert.equal(
    await fixture.store.getClientSecretHash(createdClient.id),
    await sha256(createdSecret),
  );
  assert.match(
    createdResult.headers.get("set-cookie") ?? "",
    /aittadb_admin_result=;[^,]*Max-Age=0/,
  );
  const rotateSubmission = htmlSubmissionToken(createdHtml);

  const refreshed = await adminGet(
    fixture,
    "text/html",
    `aittadb_csrf=${csrf}`,
  );
  assert.doesNotMatch(await refreshed.text(), new RegExp(createdSecret));
  assert.equal((await fixture.store.listClients()).length, 1);

  const replayedCreate = await adminPost(
    fixture,
    csrf,
    createSubmission,
    createInput,
    "text/html",
  );
  assert.equal(replayedCreate.status, 409);
  assert.equal((await fixture.store.listClients()).length, 1);

  const staleCreateFlash = await adminGet(
    fixture,
    "text/html",
    `aittadb_csrf=${csrf}; aittadb_admin_result=${createFlash}`,
  );
  assert.doesNotMatch(await staleCreateFlash.text(), new RegExp(createdSecret));

  const rotated = await adminPost(
    fixture,
    csrf,
    rotateSubmission,
    { action: "rotate_secret", client_id: createdClient.id },
    "text/html",
  );
  assert.equal(rotated.status, 303);
  assert.equal(rotated.headers.get("location"), "/admin/clients");
  const rotateFlash = cookieValue(rotated, "aittadb_admin_result");
  assert.doesNotMatch(rotateFlash, new RegExp(createdSecret));
  const rotatedResult = await adminGet(
    fixture,
    "text/html",
    `aittadb_csrf=${csrf}; aittadb_admin_result=${rotateFlash}`,
  );
  const rotatedHtml = await rotatedResult.text();
  assert.match(rotatedHtml, new RegExp(createdClient.id));
  const rotatedSecret = oneTimeSecret(rotatedHtml);
  assert.notEqual(rotatedSecret, createdSecret);
  assert.equal(
    await fixture.store.getClientSecretHash(createdClient.id),
    await sha256(rotatedSecret),
  );

  const rotatedHash = await fixture.store.getClientSecretHash(createdClient.id);
  const replayedRotate = await adminPost(
    fixture,
    csrf,
    rotateSubmission,
    { action: "rotate_secret", client_id: createdClient.id },
    "text/html",
  );
  assert.equal(replayedRotate.status, 409);
  assert.equal(
    await fixture.store.getClientSecretHash(createdClient.id),
    rotatedHash,
  );
  const laterHtml = await adminGet(
    fixture,
    "text/html",
    `aittadb_csrf=${csrf}`,
  );
  assert.doesNotMatch(await laterHtml.text(), new RegExp(rotatedSecret));

  const jsonPage = await adminGet(fixture);
  const jsonCsrf = cookieValue(jsonPage, "aittadb_csrf");
  const jsonDocument = (await jsonPage.json()) as AdminDocument;
  const jsonSubmission = documentSubmissionToken(jsonDocument);

  const publicResult = await adminPost(
    fixture,
    jsonCsrf,
    jsonSubmission,
    {
      name: "No-secret public",
      type: "public",
      redirect_uris: "https://public.example.test/callback",
      scopes: "openid",
      origins: "",
    },
    HYPERMEDIA,
  );
  const publicDocument = (await publicResult.json()) as AdminDocument;
  assert.equal(publicResult.status, 200);
  assert.equal(publicDocument.data.operation_result?.operation, "create");
  assert.equal(publicDocument.data.new_client_secret, undefined);
  assert.equal(publicDocument.data.new_client_secret_client_id, undefined);
  assert.equal(publicDocument.data.secret_displayed_once, undefined);

  const jsonConfidential = await adminPost(
    fixture,
    jsonCsrf,
    documentSubmissionToken(publicDocument),
    {
      name: "JSON confidential",
      type: "confidential",
      redirect_uris: "https://json.example.test/callback",
      scopes: "openid",
      origins: "",
    },
    HYPERMEDIA,
  );
  assert.equal(jsonConfidential.status, 200);
  const jsonConfidentialDocument =
    (await jsonConfidential.json()) as AdminDocument;
  const jsonSecret = jsonConfidentialDocument.data.new_client_secret;
  const jsonClientId =
    jsonConfidentialDocument.data.new_client_secret_client_id;
  assert.match(jsonSecret ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.match(jsonClientId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(jsonConfidentialDocument.data.secret_displayed_once, true);
  assert.equal(
    await fixture.store.getClientSecretHash(jsonClientId!),
    await sha256(jsonSecret!),
  );
  const jsonLater = await adminGet(fixture);
  assert.doesNotMatch(await jsonLater.text(), new RegExp(jsonSecret!));
});

test("admin state transitions enforce advertised controls and grant revocation", async () => {
  const fixture = await adminFixture();
  const confidential = await createClientRegistration(
    registration("Lifecycle confidential", "confidential"),
    fixture.store,
    nowSeconds(),
  );
  assert.ok(confidential.secret);
  const tokens = await issueTokens({
    config: loadConfig(fixture.env, ISSUER),
    store: fixture.store,
    user: (await fixture.store.getUser(fixture.userId))!,
    client: confidential.client,
    scope: "openid offline_access",
    includeRefresh: true,
    now: nowSeconds(),
  });
  const refreshToken = String(tokens.refresh_token);
  assert.match(refreshToken, /^[A-Za-z0-9_-]{64}$/);

  const page = await adminGet(fixture, "text/html");
  const csrf = cookieValue(page, "aittadb_csrf");
  const initialHtml = await page.text();
  const disableSubmission = htmlSubmissionToken(initialHtml);
  const disabled = await htmlAdminMutation(fixture, csrf, disableSubmission, {
    action: "disable",
    client_id: confidential.client.id,
  });
  assert.match(disabled.html, /disabled\./);
  assert.deepEqual(htmlOperations(disabled.html, confidential.client.id), [
    "enable",
    "revoke_grants",
    "rotate_secret",
  ]);
  assert.equal(
    (await fixture.store.getClient(confidential.client.id))?.disabledAt !==
      null,
    true,
  );
  assert.equal(fixture.store.audits.length, 1);

  const repeatedDisable = await adminPost(
    fixture,
    csrf,
    disableSubmission,
    { action: "disable", client_id: confidential.client.id },
    "text/html",
  );
  assert.equal(repeatedDisable.status, 409);
  assert.equal(fixture.store.audits.length, 1);
  await adminGet(fixture, "text/html", `aittadb_csrf=${csrf}`);
  assert.equal(fixture.store.audits.length, 1);

  const enabled = await htmlAdminMutation(
    fixture,
    csrf,
    disabled.nextSubmission,
    { action: "enable", client_id: confidential.client.id },
  );
  assert.deepEqual(htmlOperations(enabled.html, confidential.client.id), [
    "disable",
    "revoke_grants",
    "rotate_secret",
  ]);
  assert.equal(
    (await fixture.store.getClient(confidential.client.id))?.disabledAt,
    null,
  );
  assert.equal(fixture.store.audits.length, 2);
  const repeatedEnable = await adminPost(
    fixture,
    csrf,
    disabled.nextSubmission,
    { action: "enable", client_id: confidential.client.id },
    "text/html",
  );
  assert.equal(repeatedEnable.status, 409);
  assert.equal(fixture.store.audits.length, 2);
  await adminGet(fixture, "text/html", `aittadb_csrf=${csrf}`);
  assert.equal(fixture.store.audits.length, 2);
  assert.equal(
    (await fixture.store.getClient(confidential.client.id))?.disabledAt,
    null,
  );

  const publicClient = await createClientRegistration(
    registration("Lifecycle public", "public"),
    fixture.store,
    nowSeconds(),
  );
  const rotatePublic = await adminPost(
    fixture,
    csrf,
    enabled.nextSubmission,
    { action: "rotate_secret", client_id: publicClient.client.id },
    HYPERMEDIA,
  );
  assert.equal(rotatePublic.status, 409);
  assert.equal(
    await fixture.store.getClientSecretHash(publicClient.client.id),
    null,
  );

  const revoked = await htmlAdminMutation(
    fixture,
    csrf,
    enabled.nextSubmission,
    { action: "revoke_grants", client_id: confidential.client.id },
  );
  assert.match(revoked.html, /Active grants .* revoked\./);
  assert.equal(fixture.store.audits.length, 3);
  const replayedRevocation = await adminPost(
    fixture,
    csrf,
    enabled.nextSubmission,
    { action: "revoke_grants", client_id: confidential.client.id },
    "text/html",
  );
  assert.equal(replayedRevocation.status, 409);
  await adminGet(fixture, "text/html", `aittadb_csrf=${csrf}`);
  assert.equal(fixture.store.audits.length, 3);

  const refresh = await fixture.app.fetch(
    new Request(`${ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: confidential.client.id,
        client_secret: confidential.secret!,
      }),
    }),
  );
  assert.equal(refresh?.status, 400);
  assert.equal(
    ((await refresh!.json()) as { error: string }).error,
    "invalid_grant",
  );

  assert.deepEqual(
    fixture.store.audits.map((entry) => entry.data.action),
    ["disable", "enable", "revoke_grants"],
  );
  for (const entry of fixture.store.audits) {
    assert.doesNotMatch(
      JSON.stringify(entry),
      new RegExp(confidential.client.id),
    );
    assert.doesNotMatch(
      JSON.stringify(entry),
      new RegExp(confidential.secret!),
    );
  }
});

test("admin failures remain versioned, non-disclosing, and non-mutating", async () => {
  const fixture = await adminFixture();

  const anonymous = await createTestAittaDB(
    fixture.env,
    fixture.store,
    null,
  ).fetch(
    new Request(`${ISSUER}/admin/clients`, {
      headers: { accept: HYPERMEDIA },
    }),
  );
  assert.equal(anonymous?.status, 401);
  assert.match(
    anonymous!.headers.get("content-type") ?? "",
    /^application\/vnd\.aittadb\+json/,
  );
  const anonymousDocument = (await anonymous!.json()) as AdminDocument;
  assert.equal(anonymousDocument.type, "error");
  assert.deepEqual(
    anonymousDocument.actions.map((action) => action.name),
    ["begin-session"],
  );
  assert.equal("clients" in anonymousDocument.data, false);

  const unlisted = await createTestAittaDB(fixture.env, fixture.store, {
    email: "unlisted@example.test",
    fullName: "Unlisted User",
    displayName: "Unlisted User",
  }).fetch(
    new Request(`${ISSUER}/admin/clients`, {
      headers: { accept: HYPERMEDIA },
    }),
  );
  assert.equal(unlisted?.status, 403);
  const unlistedBody = await unlisted!.text();
  assert.doesNotMatch(unlistedBody, /create-client|client_id|redirect_uris/);

  const page = await adminGet(fixture);
  const csrf = cookieValue(page, "aittadb_csrf");
  const submissionToken = documentSubmissionToken(
    (await page.json()) as AdminDocument,
  );
  const baseHeaders = {
    accept: HYPERMEDIA,
    "content-type": "application/x-www-form-urlencoded",
    cookie: `aittadb_csrf=${csrf}`,
  };
  const cases: Array<[string, Request, number]> = [
    [
      "missing origin",
      new Request(`${ISSUER}/admin/clients`, {
        method: "POST",
        headers: baseHeaders,
        body: form({
          csrf_token: csrf,
          submission_token: submissionToken,
          type: "public",
          name: "No origin",
        }),
      }),
      403,
    ],
    [
      "foreign origin",
      new Request(`${ISSUER}/admin/clients`, {
        method: "POST",
        headers: { ...baseHeaders, origin: "https://attacker.example.test" },
        body: form({
          csrf_token: csrf,
          submission_token: submissionToken,
          type: "public",
          name: "Foreign",
        }),
      }),
      403,
    ],
    [
      "bad csrf",
      new Request(`${ISSUER}/admin/clients`, {
        method: "POST",
        headers: { ...baseHeaders, origin: ISSUER },
        body: form({
          csrf_token: "wrong",
          submission_token: submissionToken,
          type: "public",
          name: "Bad CSRF",
        }),
      }),
      403,
    ],
    [
      "invalid type",
      adminRequest(csrf, submissionToken, {
        type: "private",
        name: "Bad type",
      }),
      400,
    ],
    [
      "invalid redirect",
      adminRequest(csrf, submissionToken, {
        type: "public",
        name: "Bad redirect",
        redirect_uris: "not a URI",
        scopes: "openid",
      }),
      400,
    ],
    [
      "unknown client",
      adminRequest(csrf, submissionToken, {
        action: "disable",
        client_id: "00000000-0000-4000-8000-000000000000",
      }),
      404,
    ],
    [
      "unsupported action",
      adminRequest(csrf, submissionToken, {
        action: "delete",
        client_id: fixture.userId,
      }),
      400,
    ],
    [
      "missing submission token",
      adminRequest(csrf, "", {
        type: "public",
        name: "Missing submission",
        redirect_uris: "https://client.example.test/callback",
        scopes: "openid",
      }),
      409,
    ],
    [
      "unsupported media",
      new Request(`${ISSUER}/admin/clients`, {
        method: "POST",
        headers: {
          accept: HYPERMEDIA,
          "content-type": "application/json",
          cookie: `aittadb_csrf=${csrf}`,
          origin: ISSUER,
        },
        body: "{}",
      }),
      415,
    ],
    [
      "oversized form",
      new Request(`${ISSUER}/admin/clients`, {
        method: "POST",
        headers: { ...baseHeaders, origin: ISSUER },
        body: form({
          csrf_token: csrf,
          submission_token: submissionToken,
          padding: "x".repeat(17_000),
        }),
      }),
      413,
    ],
  ];

  for (const [label, request, expectedStatus] of cases) {
    const response = await fixture.app.fetch(request);
    assert.equal(response?.status, expectedStatus, label);
    assert.match(
      response!.headers.get("content-type") ?? "",
      /^application\/vnd\.aittadb\+json/,
      label,
    );
    assert.equal(response!.headers.get("cache-control"), "no-store", label);
    const body = await response!.text();
    assert.doesNotMatch(body, /new_client_secret/, label);
  }
  assert.equal((await fixture.store.listClients()).length, 0);
  assert.equal(fixture.store.audits.length, 0);
  assert.equal(fixture.store.adminOperationSubmissions.size, 0);
});

async function adminFixture(): Promise<AdminFixture> {
  const baseEnv = await testEnv();
  const store = new MemoryAuthStore();
  const identity: UpstreamIdentity = {
    email: "admin@example.test",
    fullName: "AittaDB Admin",
    displayName: "AittaDB Admin",
  };
  const user = await store.findOrCreateUser(identity, nowSeconds());
  const env = { ...baseEnv, ADMIN_SUBJECTS: user.id };
  return {
    env,
    store,
    identity,
    userId: user.id,
    app: createTestAittaDB(env, store, identity),
  };
}

function registration(name: string, type: "public" | "confidential") {
  return {
    type,
    name,
    redirectUris: [
      `https://${name.toLowerCase().replaceAll(" ", "-")}.example.test/callback`,
    ],
    scopes: ["openid", "offline_access"],
    origins: [],
  };
}

async function adminGet(
  fixture: AdminFixture,
  accept = HYPERMEDIA,
  cookie?: string,
): Promise<Response> {
  const response = await fixture.app.fetch(
    new Request(`${ISSUER}/admin/clients`, {
      headers: { accept, ...(cookie ? { cookie } : {}) },
    }),
  );
  assert.equal(response?.status, 200);
  return response!;
}

async function adminPost(
  fixture: AdminFixture,
  csrf: string,
  submissionToken: string,
  body: Record<string, string>,
  accept: string,
): Promise<Response> {
  const response = await fixture.app.fetch(
    new Request(`${ISSUER}/admin/clients`, {
      method: "POST",
      headers: {
        accept,
        "content-type": "application/x-www-form-urlencoded",
        cookie: `aittadb_csrf=${csrf}`,
        origin: ISSUER,
      },
      body: form({
        csrf_token: csrf,
        ...(submissionToken ? { submission_token: submissionToken } : {}),
        ...body,
      }),
    }),
  );
  assert.ok(response);
  return response;
}

function adminRequest(
  csrf: string,
  submissionToken: string,
  body: Record<string, string>,
): Request {
  return new Request(`${ISSUER}/admin/clients`, {
    method: "POST",
    headers: {
      accept: HYPERMEDIA,
      "content-type": "application/x-www-form-urlencoded",
      cookie: `aittadb_csrf=${csrf}`,
      origin: ISSUER,
    },
    body: form({
      csrf_token: csrf,
      ...(submissionToken ? { submission_token: submissionToken } : {}),
      ...body,
    }),
  });
}

async function htmlAdminMutation(
  fixture: AdminFixture,
  csrf: string,
  submissionToken: string,
  body: Record<string, string>,
): Promise<{ html: string; nextSubmission: string }> {
  const response = await adminPost(
    fixture,
    csrf,
    submissionToken,
    body,
    "text/html",
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/admin/clients");
  const flash = cookieValue(response, "aittadb_admin_result");
  const result = await adminGet(
    fixture,
    "text/html",
    `aittadb_csrf=${csrf}; aittadb_admin_result=${flash}`,
  );
  const html = await result.text();
  return { html, nextSubmission: htmlSubmissionToken(html) };
}

function documentSubmissionToken(document: AdminDocument): string {
  const create = document.actions.find(
    (action) => action.name === "create-client",
  );
  assert.ok(create);
  const value = fieldValue(create, "submission_token");
  assert.match(String(value), /^[A-Za-z0-9_-]{32}$/);
  return String(value);
}

function htmlSubmissionToken(html: string): string {
  const value = html.match(/name="submission_token" value="([^"]+)"/)?.[1];
  assert.match(value ?? "", /^[A-Za-z0-9_-]{32}$/);
  return value!;
}

function oneTimeSecret(html: string): string {
  const value = html.match(
    /shown once: <code>([A-Za-z0-9_-]{43})<\/code>/,
  )?.[1];
  assert.ok(value);
  return value;
}

function jsonOperations(document: AdminDocument, clientId: string): string[] {
  return document.actions
    .filter((action) => fieldValue(action, "client_id") === clientId)
    .map((action) => String(fieldValue(action, "action")))
    .sort();
}

function fieldValue(action: AdminAction, name: string): unknown {
  return action.fields.find((field) => field.name === name)?.value;
}

function htmlOperations(html: string, clientId: string): string[] {
  return (html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [])
    .filter((candidate) =>
      candidate.includes(`name="client_id" value="${clientId}"`),
    )
    .map(
      (candidate) =>
        candidate.match(/name="action" value="([^"]+)"/)?.[1] ?? "",
    )
    .filter(Boolean)
    .sort();
}
