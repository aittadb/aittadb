import assert from "node:assert/strict";
import test from "node:test";

import { issueBrowserSessionAccessToken } from "../../src/browser-session";
import { loadConfig } from "../../src/config";
import { nowSeconds } from "../../src/crypto";
import {
  createClientRegistration,
  issueTokens,
  OAuthScopePolicyError,
  verifyAccessToken,
} from "../../src/oauth";
import { MemoryAuthStore } from "../../src/store/memory";
import { BROWSER_SESSION_CLIENT_ID } from "../../src/system-client";
import type { ClientType, RuntimeEnv, UpstreamIdentity } from "../../src/types";
import {
  cookieValue,
  createTestAittaDB,
  form,
  testEnv,
  testIdentityProvider,
} from "../helpers";

const ISSUER = "https://aittadb.example.test";
const HYPERMEDIA = "application/vnd.aittadb+json; version=0.1";
const EVENT_SCOPES = "events.publish events.read events.subscribe";
const IDENTITY: UpstreamIdentity = {
  email: "events-user@example.test",
  fullName: "Events User",
  displayName: "Events User",
};

test("enabled Events scopes work for interactive, service, and reserved-browser clients", async () => {
  const env = await testEnv({
    FEATURE_OAUTH_APPS_ENABLED: "true",
    FEATURE_EVENTS_ENABLED: "true",
  });
  const config = loadConfig(env, ISSUER);
  const store = new MemoryAuthStore();
  const app = createTestAittaDB(env, store, IDENTITY);
  const publicClient = await register(store, "public");
  const confidentialClient = await register(store, "confidential");
  const serviceClient = await register(store, "service");

  const device = await app.fetch(
    new Request(`${ISSUER}/oauth/device_authorization`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: publicClient.client.id,
        scope: EVENT_SCOPES,
      }),
    }),
  );
  assert.equal(device?.status, 200);

  const authorize = await app.fetch(
    authorizationRequest(confidentialClient.client.id, "events.read"),
  );
  assert.equal(authorize?.status, 302);
  assert.equal(
    new URL(authorize!.headers.get("location")!).pathname,
    "/consent",
  );

  const serviceResponse = await serviceToken(
    app,
    serviceClient.client.id,
    serviceClient.secret!,
    EVENT_SCOPES,
  );
  assert.equal(serviceResponse.status, 200);
  const serviceBody = (await serviceResponse.json()) as Record<string, unknown>;
  assert.equal(serviceBody.scope, EVENT_SCOPES);
  for (const forbidden of ["id_token", "refresh_token", "email", "name"]) {
    assert.equal(Object.hasOwn(serviceBody, forbidden), false);
  }
  const serviceClaims = await verifyAccessToken(
    String(serviceBody.access_token),
    config,
    store,
    serviceClient.client.id,
  );
  assert.equal(serviceClaims.claims.sub, serviceClient.client.id);
  assert.equal(serviceClaims.claims.subject_type, "service");
  assert.equal(serviceClaims.claims.scope, EVENT_SCOPES);

  const browserToken = await issueBrowserSessionAccessToken(
    new Request(ISSUER),
    testIdentityProvider(IDENTITY),
    store,
    config,
    ["events.publish", "events.read", "events.subscribe"],
  );
  assert.equal(typeof browserToken, "string");
  const browserClaims = await verifyAccessToken(
    browserToken as string,
    config,
    store,
    BROWSER_SESSION_CLIENT_ID,
  );
  assert.equal(browserClaims.claims.scope, EVENT_SCOPES);
  assert.equal(browserClaims.claims.subject_type, undefined);

  const noRoute = await app.fetch(
    new Request(`${ISSUER}/events`, { headers: { accept: HYPERMEDIA } }),
  );
  assert.equal(noRoute?.status, 404);
});

test("disabling Events rejects scope escalation and stale registered scope use", async () => {
  const enabledEnv = await testEnv({
    FEATURE_OAUTH_APPS_ENABLED: "true",
    FEATURE_EVENTS_ENABLED: "true",
  });
  const disabledEnv: RuntimeEnv = {
    ...enabledEnv,
    FEATURE_EVENTS_ENABLED: "false",
  };
  const store = new MemoryAuthStore();
  const publicClient = await register(store, "public");
  const confidentialClient = await register(store, "confidential");
  const serviceClient = await register(store, "service");
  const app = createTestAittaDB(disabledEnv, store, IDENTITY);

  const serviceResponse = await serviceToken(
    app,
    serviceClient.client.id,
    serviceClient.secret!,
    "events.read",
  );
  assert.equal(serviceResponse.status, 400);
  assert.equal(
    ((await serviceResponse.json()) as { error: string }).error,
    "invalid_scope",
  );

  const device = await app.fetch(
    new Request(`${ISSUER}/oauth/device_authorization`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: publicClient.client.id,
        scope: "events.publish",
      }),
    }),
  );
  assert.equal(device?.status, 400);
  assert.equal(
    ((await device!.json()) as { error: string }).error,
    "invalid_scope",
  );

  const authorize = await app.fetch(
    authorizationRequest(confidentialClient.client.id, "events.read"),
  );
  assert.equal(authorize?.status, 302);
  const redirect = new URL(authorize!.headers.get("location")!);
  assert.equal(redirect.origin, "https://confidential.example.test");
  assert.equal(redirect.searchParams.get("error"), "invalid_scope");

  const emptyStore = new MemoryAuthStore();
  const browserResult = await issueBrowserSessionAccessToken(
    new Request(ISSUER),
    testIdentityProvider(IDENTITY),
    emptyStore,
    loadConfig(disabledEnv, ISSUER),
    ["events.read"],
  );
  assert.ok(browserResult instanceof Response);
  assert.equal(browserResult.status, 400);
  assert.equal(await emptyStore.countUsers(), 0);

  const user = await store.findOrCreateUser(IDENTITY, nowSeconds());
  await assert.rejects(
    issueTokens({
      config: loadConfig(disabledEnv, ISSUER),
      store,
      user,
      client: publicClient.client,
      scope: "events.read",
      includeRefresh: false,
      now: nowSeconds(),
    }),
    OAuthScopePolicyError,
  );
  const compatible = await issueTokens({
    config: loadConfig(disabledEnv, ISSUER),
    store,
    user,
    client: {
      ...publicClient.client,
      scopes: [...publicClient.client.scopes, "openid", "storage.read"],
    },
    scope: "openid storage.read",
    includeRefresh: false,
    now: nowSeconds(),
  });
  assert.equal(compatible.scope, "openid storage.read");
  assert.equal(typeof compatible.id_token, "string");
});

for (const enabled of [false, true]) {
  test(`client administration ${enabled ? "offers" : "omits"} Events scopes according to deployment policy`, async () => {
    const store = new MemoryAuthStore();
    const user = await store.findOrCreateUser(IDENTITY, nowSeconds());
    const env = await testEnv({
      FEATURE_OAUTH_APPS_ENABLED: "true",
      FEATURE_EVENTS_ENABLED: String(enabled),
      ADMIN_SUBJECTS: user.id,
    });
    const app = createTestAittaDB(env, store, IDENTITY);
    const get = await app.fetch(
      new Request(`${ISSUER}/admin/clients`, {
        headers: { accept: HYPERMEDIA },
      }),
    );
    assert.equal(get?.status, 200);
    const document = (await get!.json()) as {
      actions: Array<{
        name: string;
        fields: Array<{
          name: string;
          value?: string;
          description?: string;
        }>;
      }>;
    };
    const create = document.actions.find(
      (action) => action.name === "create-client",
    );
    assert.ok(create);
    const serialized = JSON.stringify(create);
    assert.equal(serialized.includes("events.publish"), enabled);

    const csrf = cookieValue(get!, "aittadb_csrf");
    const submission = String(
      create.fields.find((field) => field.name === "submission_token")?.value,
    );
    const response = await app.fetch(
      new Request(`${ISSUER}/admin/clients`, {
        method: "POST",
        headers: {
          accept: HYPERMEDIA,
          "content-type": "application/x-www-form-urlencoded",
          cookie: `aittadb_csrf=${csrf}`,
          origin: ISSUER,
        },
        body: form({
          csrf_token: csrf,
          submission_token: submission,
          name: "Admin Events client",
          type: "public",
          redirect_uris: "https://admin-client.example.test/callback",
          scopes: "events.read",
          origins: "https://admin-client.example.test",
        }),
      }),
    );
    assert.equal(response?.status, enabled ? 200 : 400);
    const created = (await store.listClients()).filter(
      (client) => client.name === "Admin Events client",
    );
    assert.equal(created.length, enabled ? 1 : 0);

    const html = await app.fetch(
      new Request(`${ISSUER}/admin/clients`, {
        headers: { accept: "text/html" },
      }),
    );
    assert.equal(html?.status, 200);
    assert.equal((await html!.text()).includes("events.publish"), enabled);
  });
}

async function register(store: MemoryAuthStore, type: ClientType) {
  return createClientRegistration(
    {
      type,
      name: `${type} Events client`,
      redirectUris:
        type === "service" ? [] : [`https://${type}.example.test/callback`],
      scopes: EVENT_SCOPES.split(" "),
      origins: type === "service" ? [] : [`https://${type}.example.test`],
    },
    store,
    nowSeconds(),
    { eventsEnabled: true },
  );
}

function authorizationRequest(clientId: string, scope: string): Request {
  const url = new URL(`${ISSUER}/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set(
    "redirect_uri",
    "https://confidential.example.test/callback",
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", "scope-policy-state");
  url.searchParams.set("code_challenge", "a".repeat(43));
  url.searchParams.set("code_challenge_method", "S256");
  return new Request(url);
}

async function serviceToken(
  app: ReturnType<typeof createTestAittaDB>,
  clientId: string,
  secret: string,
  scope: string,
): Promise<Response> {
  const response = await app.fetch(
    new Request(`${ISSUER}/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${clientId}:${secret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ grant_type: "client_credentials", scope }),
    }),
  );
  assert.ok(response);
  return response;
}
